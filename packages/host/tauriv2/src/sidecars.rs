//! The sidecar channel.
//!
//! The configuration files staged with the frontend decide the available sidecars. For each plugin in the plugins of
//! environment.json, the host reads the sidecars of modules/<plugin>/plugin.json, and for each sidecar it reads
//! the executable and protocol of modules/<sidecar>/sidecar.json. The executable is in the directory of the
//! application executable under the name basename(executable). A sidecar is identified by its name.
//!
//! Starts a declared sidecar at its first use and relays one-line JSON messages between surface pages and the sidecar.
//! The message body is not interpreted. The format is defined in docs/spec/sidecars.md.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{RecvError, SyncSender, TryRecvError, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::{Duration, Instant};

use wait_timeout::ChildExt;

use crate::application_log::log_error;
use crate::buffer_bounds::{PendingLines, record_buffer_drop};
use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::platform::{PersistentStream, current};
use crate::sidecar_reply::{RequestLedger, error_of_body, record_stopped_requests};
use crate::windows::{emit_window, window_data};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::Window;

/// The event value that passes a message sent by a sidecar to the page.
#[derive(Clone, Serialize)]
pub struct Message {
    /// The sidecar that sent the message.
    pub sidecar: String,
    /// The id of the surface that receives the message.
    pub surface: String,
    /// The message body, not interpreted.
    pub body: Box<RawValue>,
}

/// The event value that reports a sidecar failure to the page (docs/spec/sidecars.md#failure).
#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    /// The sidecar that failed.
    pub sidecar: String,
    /// The id of the surface that sent a request to the failed process.
    pub surface: String,
    /// The cause of the failure.
    pub reason: String,
}

/// The message kinds of the outbox channel of a sidecar.
enum Outgoing {
    /// One line to send to the sidecar.
    Line(QueuedLine),
    /// A signal to close the stdin of the sidecar.
    Close,
}

/// The interface that sends responses to a sidecar.
pub trait ResponseSender: Send {
    /// Sends the response JSON to the sidecar. The image name is used as the key.
    fn send(&self, surface: &str, image: &str, body: &RawValue) -> Result<(), ResponseError>;
}

/// The error of a response to a sidecar. `Ended` states that the process of the sidecar is not running, so nothing
/// receives the response; `Failed` is any other failure. The text is the same in both hosts.
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseError {
    Ended(String),
    Failed(String),
}

impl std::fmt::Display for ResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResponseError::Ended(text) | ResponseError::Failed(text) => formatter.write_str(text),
        }
    }
}

/// The window that owns a surface. It provides the root of sidecar messages and receives events.
pub trait Owner: Clone + Send + 'static {
    /// The value that distinguishes the owning window.
    fn key(&self) -> String;
    /// The project directory that is sent as the root of sidecar requests.
    fn root(&self) -> Result<String, String>;
    /// Passes a message that the sidecar sent to the page of the window.
    fn deliver(&self, message: Message);
    /// Passes a sidecar failure to the page of the window.
    fn deliver_failure(&self, failure: Failure);
    /// Decides and handles an image envelope. There is no default implementation.
    /// Return value: whether the image envelope was handled.
    fn decide_image_envelope(
        &self,
        _sidecar_name: &str,
        _surface: &str,
        _body: &RawValue,
        _response_sender: &dyn ResponseSender,
    ) -> bool {
        false
    }
    /// Called when the connection of a persistent sidecar is established again after it was lost (V5-106). The window
    /// must send the image configure of that sidecar again, because the configure state that the previous connection
    /// confirmed died with the connection. There is no default implementation: an owner that owns no image has nothing
    /// to send again.
    fn sidecar_reconnected(&self, _sidecar: &str) {}
}

#[derive(Serialize)]
struct Request<'a> {
    surface: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    closed: bool,
    /// The correlation identifiers of the inputs that the request continues (docs/spec/sidecars.md#protocol).
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    cids: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Event {
    surface: String,
    body: Box<RawValue>,
    /// The correlation identifiers of the requests that this message answers (docs/spec/sidecars.md#protocol).
    #[serde(default)]
    cids: Vec<String>,
}

/// It first checks whether the line holds closed. When closed is present, the line is the answer to closed
/// (docs/spec/sidecars.md#messages).
#[derive(Deserialize)]
struct CloseProbe {
    closed: Option<bool>,
}

/// The answer of the sidecar to closed. error is the reason why it could not close.
#[derive(Deserialize)]
struct CloseAnswer {
    surface: String,
    closed: bool,
    error: Option<String>,
}

/// The surfaces for which the host sent closed and the sidecar has not answered yet (host.sidecars).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClosingSurface {
    /// The sidecar that received closed.
    pub sidecar: String,
    /// The id of the closed surface.
    pub surface: String,
}

/// A notification that is called outside the lock after closing changed.
type ClosingChanged = Arc<dyn Fn() + Send + Sync>;

/// Handles line when it is an answer to closed. It returns Ok(false) when it is not an answer, Ok(true) when it was
/// handled, and the reason when the protocol was violated. The reason why it could not close is written to the log.
fn close_answer<O: Owner>(
    state: &Arc<Mutex<State<O>>>,
    sidecar: &str,
    line: &[u8],
) -> Result<bool, String> {
    let probe: CloseProbe =
        serde_json::from_slice(line).map_err(|error| format!("invalid message: {error}"))?;
    if probe.closed.is_none() {
        return Ok(false);
    }
    let answer: CloseAnswer =
        serde_json::from_slice(line).map_err(|error| format!("invalid message: {error}"))?;
    if !answer.closed {
        return Err("invalid message: closed is not true".to_string());
    }
    let (pending, stopped, changed) = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the
        // call amends; the panic hook records the panic.
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        let pending = state
            .closing
            .get_mut(sidecar)
            .is_some_and(|surfaces| take(surfaces, &answer.surface));
        let stopped = !pending
            && state
                .stopping
                .get_mut(sidecar)
                .is_some_and(|stopping| take(&mut stopping.closing, &answer.surface));
        if state
            .closing
            .get(sidecar)
            .is_some_and(|surfaces| surfaces.is_empty())
        {
            state.closing.remove(sidecar);
        }
        (pending, stopped, state.closing_changed.clone())
    };
    if !pending && !stopped {
        return Err(format!("unexpected close answer for {}", answer.surface));
    }
    if let Some(error) = answer.error {
        log_error(
            &format!("sidecar {sidecar}"),
            format!("close {}: {error}", answer.surface),
        );
    }
    if !pending {
        return Ok(true);
    }
    if let Some(changed) = changed {
        changed();
    }
    Ok(true)
}

/// Lowers the count of key in counts by one and returns true when it did; a key whose count reaches 0 is removed.
fn take(counts: &mut std::collections::BTreeMap<String, usize>, key: &str) -> bool {
    let Some(count) = counts.get_mut(key) else {
        return false;
    };
    *count -= 1;
    if *count == 0 {
        counts.remove(key);
    }
    true
}

/// Moves the surfaces and the unanswered closes of the standard input and output sidecar name that stops into
/// stopping, by which its reader judges the output while it stops. The caller removes it from the running list.
/// Returns the closing notification when closing changed.
fn detach_stdio<O>(state: &mut State<O>, name: &str) -> Option<ClosingChanged> {
    let surfaces = state.running[name].surfaces.iter().cloned().collect();
    let closing = state
        .closing
        .get(name)
        .cloned()
        // default: without an entry in closing the sidecar has no unanswered close, so none is moved.
        .unwrap_or_default();
    state.stopping.insert(
        name.to_string(),
        Stopping {
            surfaces,
            closing,
            violated: false,
        },
    );
    forget_closing(state, name)
}

/// Whether process is a persistent service whose version differs from the installed version of the sidecar name. A
/// service that sent no version is of an earlier version.
fn is_outdated<O>(core: &Core<O>, name: &str, process: &Process) -> bool {
    process.persistent.as_ref().is_some_and(|connection| {
        connection.version.as_deref() != Some(core.version(name).as_str())
    })
}

/// Why the owner of a persistent service could not be closed, and whether the transport is still closed after it.
struct CloseFailure {
    text: String,
    send_close: bool,
}

/// Closes the owner of a persistent service and tells it to shut down, once for the connection: a caller that finds
/// the close done or running by another caller waits for it and returns `Ok(false)`, and the caller that does it
/// returns `Ok(true)`. A failed close is not done, so the next caller tries again.
fn close_persistent_owner(
    outbox: &SyncSender<Outgoing>,
    close_waiters: &ReplyWaiters,
    shutdown_waiters: &ReplyWaiters,
    connected: &AtomicBool,
    owner_closed: &Mutex<bool>,
    prefix: &str,
    deadline: std::time::Instant,
) -> Result<bool, CloseFailure> {
    // default: a lock that a panicking thread poisoned still holds the close state of the owner,
    // which the call amends; the panic hook records the panic.
    let mut closed = owner_closed.lock().unwrap_or_else(PoisonError::into_inner);
    if *closed {
        return Ok(false);
    }
    send_close_owner_and_shutdown(
        outbox,
        close_waiters,
        shutdown_waiters,
        connected,
        prefix,
        deadline,
    )?;
    *closed = true;
    Ok(true)
}

/// Registers the waiter of a request of a persistent connection, unless the connection is already lost. The read thread
/// clears `connected` under the lock of the waiters before it fails them, so a waiter registered after the loss is failed
/// here with `lost` and does not wait for its deadline.
fn register_waiter(
    waiters: &ReplyWaiters,
    connected: &AtomicBool,
    request: String,
    tx: SyncSender<Result<(), String>>,
    lost: &str,
) -> Result<(), String> {
    let mut waiters = waiters
        .lock()
        // default: a lock that a panicking thread poisoned still holds the waiters of the requests, which the call
        // amends; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    if !connected.load(Ordering::Acquire) {
        return Err(lost.to_string());
    }
    waiters.insert(request, tx);
    Ok(())
}

/// Sends close-owner and shutdown through the outbox of a persistent service and waits for each answer until the
/// deadline. The ids of the requests start with `prefix`.
fn send_close_owner_and_shutdown(
    outbox: &SyncSender<Outgoing>,
    close_waiters: &ReplyWaiters,
    shutdown_waiters: &ReplyWaiters,
    connected: &AtomicBool,
    prefix: &str,
    deadline: std::time::Instant,
) -> Result<(), CloseFailure> {
    let request = format!("{prefix}-close");
    let line = serde_json::json!({"operation": "close-owner", "request": request});
    let mut bytes = serde_json::to_vec(&line).map_err(|error| CloseFailure {
        text: format!("close-owner serialization: {error}"),
        send_close: false,
    })?;
    bytes.push(b'\n');
    let (tx, rx) = sync_channel(1);
    register_waiter(
        close_waiters,
        connected,
        request,
        tx,
        "persistent service disconnected before close-owner ack",
    )
    .map_err(|text| CloseFailure {
        text: format!("close owner: {text}"),
        send_close: true,
    })?;
    outbox
        .send(Outgoing::Line(QueuedLine::new(bytes)))
        .map_err(|error| CloseFailure {
            text: format!("send close-owner: {error}"),
            send_close: false,
        })?;
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    match rx.recv_timeout(remaining) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            return Err(CloseFailure {
                text: format!("close owner: {error}"),
                send_close: true,
            });
        }
        Err(error) => {
            return Err(CloseFailure {
                text: format!("close owner wait: {error}"),
                send_close: true,
            });
        }
    }
    let shutdown_request = format!("{prefix}-shutdown");
    let shutdown_line = serde_json::json!({"operation": "shutdown", "request": shutdown_request});
    let mut shutdown_bytes =
        serde_json::to_vec(&shutdown_line).expect("shutdown request serialization cannot fail");
    shutdown_bytes.push(b'\n');
    let (shutdown_tx, shutdown_rx) = sync_channel(1);
    register_waiter(
        shutdown_waiters,
        connected,
        shutdown_request,
        shutdown_tx,
        "persistent service disconnected before shutdown ack",
    )
    .map_err(|text| CloseFailure {
        text: format!("shutdown: {text}"),
        send_close: true,
    })?;
    outbox
        .send(Outgoing::Line(QueuedLine::new(shutdown_bytes)))
        .map_err(|error| CloseFailure {
            text: format!("send shutdown: {error}"),
            send_close: true,
        })?;
    let shutdown_remaining = deadline.saturating_duration_since(std::time::Instant::now());
    match shutdown_rx.recv_timeout(shutdown_remaining) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(CloseFailure {
            text: format!("shutdown: {error}"),
            send_close: true,
        }),
        Err(error) => Err(CloseFailure {
            text: format!("shutdown wait: {error}"),
            send_close: true,
        }),
    }
}

fn forget_closing<O>(state: &mut State<O>, sidecar: &str) -> Option<ClosingChanged> {
    state.closing.remove(sidecar)?;
    state.closing_changed.clone()
}

/// The result of one read of a line of a sidecar.
#[derive(Debug, PartialEq, Eq)]
pub enum MessageLine {
    /// A line with its line feed, a message.
    Complete,
    /// The output ended before a byte of a line.
    End,
    /// The output ended in a line of this many bytes without a line feed: the process ended while it wrote the line, so
    /// the line is not a message and the end of the output is the end of the connection (docs/spec/sidecars.md#messages).
    Unfinished(usize),
    /// The part of a line before its line feed exceeds the limit; nothing more is buffered.
    TooLong,
}

/// Reads one line of a sidecar into `line`, at most `limit` bytes and a line feed.
pub fn read_message_line(
    reader: &mut impl BufRead,
    limit: usize,
    line: &mut Vec<u8>,
) -> std::io::Result<MessageLine> {
    line.clear();
    let read = reader.take(limit as u64 + 1).read_until(b'\n', line)?;
    Ok(if read == 0 {
        MessageLine::End
    } else if line.last() == Some(&b'\n') {
        MessageLine::Complete
    } else if read > limit {
        MessageLine::TooLong
    } else {
        MessageLine::Unfinished(read)
    })
}

/// Records the line that a sidecar did not finish before its output ended.
fn log_unfinished_line(sidecar: &str, bytes: usize) {
    crate::application_log::log_info(
        &format!("sidecar {sidecar}"),
        format!(
            "the output ended in a line of {bytes} bytes without a line break, which is not a message"
        ),
    );
}

/// Records a sidecar message that is dropped because no window owns it, together with its body. A dropped transfer
/// image is answered `closed`, so the sidecar releases the frame and does not match a later answer of a reopened
/// surface of the same id to it (docs/spec/native-surfaces.md#image-regions).
fn drop_message(sender: &dyn ResponseSender, sidecar: &str, surface: &str, body: &RawValue) {
    crate::application_log::log_info(
        &format!("sidecar {sidecar}"),
        format!(
            "message for surface {surface} dropped: no window owns the surface: {}",
            body.get()
        ),
    );
    let Some((name, answer)) = closed_image_answer(body) else {
        return;
    };
    match sender.send(surface, &name, &answer) {
        Ok(()) => {}
        // The frames of a sidecar end with its process, so an ended sidecar needs no answer.
        Err(ResponseError::Ended(error)) => crate::application_log::log_info(
            &format!("sidecar {sidecar}"),
            format!("closed image answer of surface {surface} not sent: {error}"),
        ),
        Err(ResponseError::Failed(error)) => crate::application_log::log_error(
            &format!("sidecar {sidecar}"),
            format!("closed image answer of surface {surface}: {error}"),
        ),
    }
}

/// The answer `{image:{error:"closed",name,generation,raster,sequence}}` to a transfer image of a closed surface, with
/// the image name, or `None` when the body is not a transfer image.
pub fn closed_image_answer(body: &RawValue) -> Option<(String, Box<RawValue>)> {
    #[derive(Deserialize)]
    struct Image {
        name: String,
        generation: u64,
        raster: u64,
        sequence: u64,
        token: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct Envelope {
        image: Image,
    }
    // silent: a body that is not a transfer image is another message of the sidecar, which receives no closed answer.
    let image = serde_json::from_str::<Envelope>(body.get()).ok()?.image;
    if image.name.is_empty() || image.token.is_null() {
        return None;
    }
    let answer = serde_json::json!({"image": {
        "error": "closed", "name": image.name, "generation": image.generation,
        "raster": image.raster, "sequence": image.sequence}});
    // silent: a JSON value always serializes, so the error is never set.
    let answer = RawValue::from_string(answer.to_string()).ok()?;
    Some((image.name, answer))
}

/// The error of a reply that the bound of the pending replies refused.
fn refused_reply(sidecar: &str, limit: &str, surface: &str) -> String {
    format!(
        "sidecar {sidecar}: the pending replies reached {limit}, so a reply of surface {surface} is dropped"
    )
}

/// The response sender of the read thread. It sends responses to the outbox channel of the sidecar.
/// When the channel is full, the response is buffered in State.pending_replies.
struct ReadThreadResponseSender<O: Owner> {
    sidecar_name: String,
    tx: SyncSender<Outgoing>,
    state: Arc<Mutex<State<O>>>,
}

impl<O: Owner> ResponseSender for ReadThreadResponseSender<O> {
    fn send(&self, surface: &str, image: &str, body: &RawValue) -> Result<(), ResponseError> {
        #[derive(Serialize)]
        struct Response<'a> {
            surface: &'a str,
            body: &'a RawValue,
        }

        let response = Response { surface, body };
        let mut line = serde_json::to_vec(&response)
            .map_err(|e| ResponseError::Failed(format!("response serialization: {e}")))?;
        line.push(b'\n');

        match self
            .tx
            .try_send(Outgoing::Line(QueuedLine::new(line.clone())))
        {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                // When the channel is full, immutable responses are kept in the order of sending.
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which the response
                // buffer amends; the panic hook records the panic.
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                let key = format!("{}:{}:{}", surface, image, body.get());
                let size = line.len();
                if let Err(limit) = state
                    .pending_replies
                    .entry(self.sidecar_name.clone())
                    .or_default()
                    .add(line)
                {
                    record_buffer_drop(
                        &format!("sidecar {} pending replies", self.sidecar_name),
                        size,
                        &limit,
                    );
                    return Err(ResponseError::Failed(refused_reply(
                        &self.sidecar_name,
                        &limit,
                        surface,
                    )));
                }
                crate::application_log::log_info(
                    &format!("sidecar {}", self.sidecar_name),
                    format!("response queue full, buffering {key}"),
                );
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => Err(ResponseError::Ended(format!(
                "sidecar {} response channel is disconnected",
                self.sidecar_name
            ))),
        }
    }
}

/// Records the answer of the service that arrived after the request that waited for it ended. A failed answer was not
/// reported by that request, so it is an error line.
fn late_reply(sidecar: &str, operation: &str, result: Result<(), String>) {
    match result {
        Ok(()) => crate::application_log::log_info(
            &format!("sidecar {sidecar}"),
            format!("the {operation} reply arrived after its request ended"),
        ),
        Err(error) => log_error(
            &format!("sidecar {sidecar}"),
            format!("{operation}: {error}"),
        ),
    }
}

/// Closes the connection when the write thread of a persistent connection ends. If the service closed the connection
/// first, the socket is already not connected (ENOTCONN) and the read thread records that loss as a connection loss, so
/// that case is an observation.
fn shut_down_writer(name: &str, writer: &mut dyn PersistentStream) {
    match writer.shutdown() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotConnected => {
            crate::application_log::log_info(
                &format!("sidecar {name}"),
                "the connection closed before its writer shut down",
            )
        }
        Err(error) => log_error(
            &format!("sidecar {name}"),
            format!("writer shutdown: {error}"),
        ),
    }
}

fn write_line(
    stdin: &mut ChildStdin,
    name: &str,
    line: &QueuedLine,
    writing: &AtomicUsize,
) -> bool {
    let started = Instant::now();
    writing.store(line.bytes.len(), Ordering::Release);
    let written = stdin.write_all(&line.bytes);
    writing.store(0, Ordering::Release);
    if let Err(e) = written {
        log_error(&format!("sidecar {name}"), format!("write: {e}"));
        return false;
    }
    record_write_wait(name, line, started, Instant::now());
    true
}

fn write_pending_socket<O>(
    state: &Mutex<State<O>>,
    name: &str,
    stream: &mut dyn PersistentStream,
    writing: &AtomicUsize,
) -> bool {
    let (replies, closes) = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the writer amends; the
        // panic hook records the panic.
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        (
            state
                .pending_replies
                .remove(name)
                .map(|mut held| held.take())
                // default: a sidecar without held items has no returns and closes to write.
                .unwrap_or_default(),
            state
                .pending_closes
                .remove(name)
                .map(|mut held| held.take())
                // default: a sidecar without held items has no returns and closes to write.
                .unwrap_or_default(),
        )
    };
    replies
        .iter()
        .chain(closes.iter())
        .all(|line| write_socket_line(stream, name, line, writing))
}

fn write_socket_line(
    stream: &mut dyn PersistentStream,
    name: &str,
    line: &QueuedLine,
    writing: &AtomicUsize,
) -> bool {
    let started = Instant::now();
    writing.store(line.bytes.len(), Ordering::Release);
    let written = stream.write_all(&line.bytes).and_then(|_| stream.flush());
    writing.store(0, Ordering::Release);
    if let Err(error) = written {
        log_error(&format!("sidecar {name}"), format!("write: {error}"));
        return false;
    }
    record_write_wait(name, line, started, Instant::now());
    true
}

/// A line for a sidecar with the moment it was queued or held.
pub(crate) struct QueuedLine {
    pub(crate) bytes: Vec<u8>,
    queued: Instant,
}

impl QueuedLine {
    /// Stamps `bytes` with the moment it enters the write queue of a sidecar.
    pub(crate) fn new(bytes: Vec<u8>) -> QueuedLine {
        QueuedLine {
            bytes,
            queued: Instant::now(),
        }
    }
}

/// The waits of a line for a sidecar that the writer records (docs/spec/logging.md#entrances): a second in the queue or
/// 10 ms in the write.
const WRITE_QUEUED_LIMIT: Duration = Duration::from_secs(1);
const WRITE_BLOCKED_LIMIT: Duration = Duration::from_millis(10);

/// Stores the event `host.sidecar.write_wait` when `line` waited `WRITE_QUEUED_LIMIT` or more between its queueing and the
/// start of its write, or when the write from `started` to `ended` took `WRITE_BLOCKED_LIMIT` or more.
fn record_write_wait(name: &str, line: &QueuedLine, started: Instant, ended: Instant) {
    let queued = started.duration_since(line.queued);
    let written = ended.duration_since(started);
    if queued < WRITE_QUEUED_LIMIT && written < WRITE_BLOCKED_LIMIT {
        return;
    }
    emit_host(
        Level::Info,
        "host.sidecar.write_wait",
        serde_json::json!({"name": name, "bytes": line.bytes.len(), "queued_us": queued.as_micros() as u64, "write_us": written.as_micros() as u64}),
    );
}

/// Takes out the held items at once and writes the returns first and the closes last. The held items arise after the
/// queue is full, so they go out after the queue.
fn write_pending<O: Owner>(
    state: &Mutex<State<O>>,
    name: &str,
    stdin: &mut ChildStdin,
    writing: &AtomicUsize,
) -> bool {
    let (replies, closes) = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the writer amends; the
        // panic hook records the panic.
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        (
            state
                .pending_replies
                .remove(name)
                .map(|mut held| held.take())
                // default: a sidecar without held items has no returns and closes to write.
                .unwrap_or_default(),
            state
                .pending_closes
                .remove(name)
                .map(|mut held| held.take())
                // default: a sidecar without held items has no returns and closes to write.
                .unwrap_or_default(),
        )
    };
    replies
        .iter()
        .chain(closes.iter())
        .all(|line| write_line(stdin, name, line, writing))
}

/// The time to wait for the service to answer retain. It includes the time it takes to close the sessions.
const RETAIN_TIMEOUT: Duration = Duration::from_secs(10);
static RETAIN_REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The maximum number of bytes of one sidecar message line before the line feed (docs/spec/sidecars.md#messages). It
/// holds a schema snapshot of several MB with a margin of more than ten times, and it limits the memory held for one
/// message to this size.
const MESSAGE_LIMIT: usize = 64 << 20;

/// The code of the error of a reply that states a failure without a code of its own (docs/spec/logging.md#result-form).
const INTERNAL_CODE: i64 = -32603;

/// The write or read thread to start after the registration.
type Thread = Box<dyn FnOnce() + Send>;

/// A started sidecar and its threads.
struct Started {
    process: Process,
    threads: Vec<Thread>,
}

struct Process {
    child: Option<Child>,
    outbox: SyncSender<Outgoing>, // channel with capacity 256
    /// The size in bytes of the line that the writer is writing, and 0 between lines.
    writing: Arc<AtomicUsize>,
    persistent: Option<PersistentConnection>,
    /// The surfaces that sent a request to this process. They are the surfaces to which a failure is reported.
    surfaces: HashSet<String>,
}

type RetainWaiters = Arc<Mutex<HashMap<String, SyncSender<Result<usize, String>>>>>;
/// Receives the result of the service for every close and shutdown request.
type ReplyWaiters = Arc<Mutex<HashMap<String, SyncSender<Result<(), String>>>>>;

struct PersistentConnection {
    /// The version that the service sent in its hello reply, or `None` when the reply had none.
    version: Option<String>,
    close_waiters: ReplyWaiters,
    /// Receives the number of sessions that the service closed, or an error, for every retain request.
    retain_waiters: RetainWaiters,
    shutdown_waiters: ReplyWaiters,
    /// Whether the owner of this connection was closed and the service was told to shut down. The close of a
    /// replacement and the close of a stop run once between them.
    owner_closed: Arc<Mutex<bool>>,
    connected: Arc<AtomicBool>,
    /// The process of the service endpoint that this connection reached.
    service_pid: u32,
}

/// The versions of a persistent service that is being replaced.
struct Replacement {
    running: Option<String>,
    installed: String,
    /// The process of the service endpoint, which ends before the installed service starts.
    pid: u32,
    /// How long the host waits for that process to end.
    timeout: Duration,
}

struct State<O> {
    running: HashMap<String, Process>,
    /// The sidecars that are starting. A start is done outside the lock and announced with Core::started when it ends.
    starting: HashSet<String>,
    /// For each sidecar, the surfaces whose closed was sent and not answered, with the number of those closes. A
    /// surface closed again before the answer receives one answer per close.
    closing: std::collections::BTreeMap<String, std::collections::BTreeMap<String, usize>>,
    /// A notification that is called outside the lock after closing changed. The host announces host.sidecars.
    closing_changed: Option<ClosingChanged>,
    owners: HashMap<String, O>,
    // The project directory at the time a surface is first sent. A sidecar finds a session by root and surface, so even
    // after the project of the window changed, requests and closes of an already opened surface are sent with this
    // root.
    roots: HashMap<String, String>,
    stopped: bool,
    // pending_replies: buffers the immutable image responses of each sidecar in the order of sending.
    // pending_closes: buffers the close messages of the surfaces of each sidecar (surface → close message).
    pending_replies: HashMap<String, PendingLines>,
    pending_closes: HashMap<String, PendingLines>,
    // Persistent sidecars whose connection was lost and whose owning surfaces were not notified yet (V5-106). The start
    // that announces the loss consumes this record. The first start has no notification.
    unannounced_loss: std::collections::HashSet<String>,
    /// The persistent services that `replace` closes, with the running and the installed version, which the
    /// reconnection after the close writes to the log.
    replacing: HashMap<String, Replacement>,
    /// For each stopping standard-I/O sidecar, the record that the read thread writes until the end of the output
    /// (docs/spec/sidecars.md#messages).
    stopping: HashMap<String, Stopping>,
    /// The requests with correlation identifiers that wait for a reply (sidecar_reply.rs).
    requests: RequestLedger,
    /// The clock of the restart limit of the sidecars of either transport (docs/spec/sidecars.md#failure). A check injects it.
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
    /// The restart-limit record of each sidecar that has a counted failure.
    restarts: HashMap<String, RestartRecord>,
}

/// The record of a stopping standard-I/O sidecar. The read thread reads the output to its end even after stop emptied
/// the list of running sidecars.
#[derive(Default)]
struct Stopping {
    /// The surfaces that sent a request to this process. While stopping, the messages of those surfaces are not a
    /// violation.
    surfaces: HashSet<String>,
    /// The closes, with their number, that stop moved out of closing. The sidecar answers them on its way out, so
    /// such an answer is not a violation.
    closing: std::collections::BTreeMap<String, usize>,
    /// Reading stopped because the protocol was violated while stopping. An end that the closed pipe caused is not
    /// reported.
    violated: bool,
}

/// The part of the sidecar channel that threads share. When the read thread detects a lost connection, it must start
/// again through the same start path (V5-106), so the configuration and the state needed for the start are kept here.
struct Core<O> {
    /// The declared sidecars. An installation adds declarations while running, so they are locked separately from
    /// state.
    declarations: RwLock<Declarations>,
    config_directory: PathBuf,
    state: Arc<Mutex<State<O>>>,
    /// Announces every end of a start. The requests and stop of the same sidecar wait for it.
    started: Condvar,
    /// The upper limit of the time until a newly started persistent service prints its endpoint.
    ready_timeout: Duration,
}

/// A sidecar that uses the executable of a declared sidecar, whether it is persistent, and the basename of the
/// persistent executable.
#[derive(Default)]
struct Declarations {
    /// The sidecar and the path of its executable.
    declared: HashMap<String, PathBuf>,
    /// The version that installed.json records for each declared sidecar.
    versions: HashMap<String, String>,
    persistent: HashMap<String, bool>,
    basenames: HashMap<String, String>,
    /// The plugins that list each declared sidecar in dependencies.
    dependents: HashMap<String, Vec<String>>,
}

impl<O> Core<O> {
    /// The version that installed.json records for the declared sidecar name, or an empty text for an undeclared one.
    fn version(&self, name: &str) -> String {
        self.declarations
            .read()
            // default: a lock that a panicking thread poisoned still holds the sidecar declarations, which are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .versions
            .get(name)
            .cloned()
            // default: an undeclared sidecar has no installed version, and no service version equals the empty text.
            .unwrap_or_default()
    }

    /// The executable and the persistence of the declared sidecar name.
    fn declaration(&self, name: &str) -> Option<(PathBuf, bool)> {
        let declarations = self
            .declarations
            .read()
            // default: a lock that a panicking thread poisoned still holds the sidecar declarations, which are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let program = declarations.declared.get(name)?.clone();
        Some((program, declarations.persistent[name]))
    }
}

/// Manages the sidecar processes and the surface-owning windows of one application.
pub struct Sidecars<O: Owner> {
    core: Arc<Core<O>>,
    /// The Stop() deadline, which a test can inject. The default is 5 seconds.
    pub stop_timeout: Duration,
}

/// One installed sidecar. data is the content of its sidecar.json and folder is the folder that holds it.
#[derive(Clone, Debug)]
pub struct SidecarDeclaration {
    pub name: String,
    pub folder: PathBuf,
    pub data: Vec<u8>,
    /// The version that installed.json records for the sidecar.
    pub version: String,
    /// The ids of the plugins whose plugin.json lists the sidecar in dependencies (docs/spec/sidecars.md#failure).
    pub dependents: Vec<String>,
}

/// A persistent sidecar whose running service has another version than the installed one
/// (docs/spec/terminal-runtime.md#updates). `running` is `None` when the service sent no version; `sessions` counts
/// the open surfaces of the application that have sent to the service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OutdatedSidecar {
    pub sidecar: String,
    pub running: Option<String>,
    pub installed: String,
    pub sessions: usize,
}

#[cfg(feature = "diagnostics")]
impl<O: Owner> Sidecars<O> {
    /// Returns the sidecar sessions of the surfaces that owner owns, ordered by sidecar and surface. A surface that sent
    /// a request to a running sidecar is one session of that sidecar.
    pub fn sessions(&self, owner: &O) -> Vec<crate::object_counts::SidecarSession> {
        let key = owner.key();
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let mut sessions: Vec<crate::object_counts::SidecarSession> = state
            .running
            .iter()
            .flat_map(|(name, process)| process.surfaces.iter().map(move |surface| (name, surface)))
            .filter(|(_, surface)| {
                state
                    .owners
                    .get(surface.as_str())
                    .is_some_and(|current| current.key() == key)
            })
            .map(|(name, surface)| crate::object_counts::SidecarSession {
                sidecar: name.clone(),
                surface: surface.clone(),
            })
            .collect();
        sessions.sort();
        sessions
    }

    /// Returns the number of sidecar requests with correlation identifiers that wait for a reply and whose surface owner
    /// owns.
    pub fn pending_count(&self, owner: &O) -> usize {
        let key = owner.key();
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        state
            .requests
            .surfaces()
            .into_iter()
            .filter(|surface| {
                state
                    .owners
                    .get(surface.as_str())
                    .is_some_and(|current| current.key() == key)
            })
            .count()
    }
}

impl<O: Owner> Sidecars<O> {
    /// Creates the channel with the declared sidecars. The executable is the executable path inside each folder.
    /// Creates the sidecar channel with the canonical application configuration directory.
    pub fn new(
        declarations: &[SidecarDeclaration],
        config_directory: PathBuf,
    ) -> Result<Self, String> {
        let config_directory = config_directory
            .canonicalize()
            .map_err(|e| format!("config directory: {e}"))?;
        let sidecars = Self {
            core: Arc::new(Core {
                declarations: RwLock::new(Declarations::default()),
                config_directory,
                state: Arc::new(Mutex::new(State {
                    running: HashMap::new(),
                    starting: HashSet::new(),
                    closing: std::collections::BTreeMap::new(),
                    closing_changed: None,
                    owners: HashMap::new(),
                    roots: HashMap::new(),
                    stopped: false,
                    pending_replies: HashMap::new(),
                    pending_closes: HashMap::new(),
                    unannounced_loss: std::collections::HashSet::new(),
                    replacing: HashMap::new(),
                    stopping: HashMap::new(),
                    requests: RequestLedger::default(),
                    clock: Arc::new(Instant::now),
                    restarts: HashMap::new(),
                })),
                started: Condvar::new(),
                ready_timeout: READY_TIMEOUT,
            }),
            stop_timeout: Duration::from_secs(5),
        };
        sidecars.declare(declarations)?;
        Ok(sidecars)
    }

    /// Declares the installed sidecars (docs/spec/installation.md#applying-a-change). The running process of a
    /// standard input and output sidecar whose executable changed or that is no longer declared stops by the stop
    /// rules, so the next send starts the new executable. A persistent service uses the new executable from its next
    /// start. An invalid declaration fails without a change.
    pub fn declare(&self, declarations: &[SidecarDeclaration]) -> Result<(), String> {
        let changed = self.replace_declarations(declarations)?;
        let (processes, closing_changed) = {
            let mut state = self
                .core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which the declaration
                // amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            // A sidecar that is starting registers when its start ends, so the start is awaited before the running
            // list is read.
            while changed.iter().any(|name| state.starting.contains(name)) {
                state = self
                    .core
                    .started
                    .wait(state)
                    // default: a wait that a poisoned lock ends still returns the guard of the sidecar state, which the
                    // call amends; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner);
            }
            let mut closing_changed = None;
            let mut processes = Vec::new();
            for name in &changed {
                if !state
                    .running
                    .get(name)
                    .is_some_and(|process| process.persistent.is_none())
                {
                    continue;
                }
                closing_changed = detach_stdio(&mut state, name).or(closing_changed);
                let process = state.running.remove(name).expect("checked above");
                processes.push((name.clone(), process));
            }
            (processes, closing_changed)
        };
        if let Some(changed) = closing_changed {
            changed();
        }
        self.stop_processes(processes, false);
        Ok(())
    }

    /// Replaces the declarations with declarations and returns the declared sidecars whose executable changed or that
    /// are no longer declared. Nothing changes when a declaration is invalid.
    fn replace_declarations(
        &self,
        declarations: &[SidecarDeclaration],
    ) -> Result<Vec<String>, String> {
        #[derive(Deserialize)]
        struct Sidecar {
            executable: String,
            protocol: u64,
            #[serde(default)]
            transport: Option<String>,
        }
        let mut next = Declarations::default();
        for item in declarations {
            let name = item.name.clone();
            let path = item.folder.join("sidecar.json").display().to_string();
            let sidecar: Sidecar =
                serde_json::from_slice(&item.data).map_err(|e| format!("{path}: {e}"))?;
            if sidecar.protocol != 1 {
                return Err(format!(
                    "{path}: protocol {} is not supported",
                    sidecar.protocol
                ));
            }
            let is_persistent = match sidecar.transport.as_deref() {
                None => false,
                Some("persistent") => true,
                Some(value) => return Err(format!("{path}: transport {value} is not supported")),
            };
            let executable = Path::new(&sidecar.executable);
            let inside = executable
                .components()
                .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
            let file = executable.file_name().filter(|_| inside).ok_or_else(|| {
                format!(
                    "{path}: executable {} is not a path inside the package",
                    sidecar.executable
                )
            })?;
            if is_persistent {
                let basename = file.to_string_lossy().into_owned();
                if let Some(other) = next.basenames.insert(basename.clone(), name.clone()) {
                    return Err(format!(
                        "{path}: executable basename {basename} is already used by {other}"
                    ));
                }
            }
            next.declared
                .insert(name.clone(), item.folder.join(executable));
            next.versions.insert(name.clone(), item.version.clone());
            next.persistent.insert(name.clone(), is_persistent);
            next.dependents.insert(name, item.dependents.clone());
        }
        let mut current = self
            .core
            .declarations
            .write()
            // default: a lock that a panicking thread poisoned still holds the sidecar declarations, which the
            // declaration replaces; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let changed = current
            .declared
            .iter()
            .filter(|(name, program)| next.declared.get(*name) != Some(*program))
            .map(|(name, _)| name.clone())
            .collect();
        *current = next;
        Ok(changed)
    }

    /// Changes the upper limit of the time until a newly started persistent service prints its endpoint. A check gives
    /// a short limit instead of the default 30 seconds. Call it only right after creation, before another reference
    /// exists.
    pub fn with_ready_timeout(mut self, limit: Duration) -> Self {
        Arc::get_mut(&mut self.core)
            .expect("the ready timeout is set before the sidecars are shared")
            .ready_timeout = limit;
        self
    }

    /// Called when the host creates a surface of plugin. It clears the restart limit of each stopped sidecar that the
    /// plugin lists in dependencies, so the next request starts the sidecar (docs/spec/sidecars.md#failure).
    pub fn surface_opened(&self, plugin: &str, surface: &str) {
        let mut state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let cleared: Vec<String> = {
            let declarations = self
                .core
                .declarations
                .read()
                // default: a lock that a panicking thread poisoned still holds the sidecar declarations, which are only
                // read; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            state
                .restarts
                .iter()
                .filter(|(name, record)| {
                    record.stopped
                        && declarations
                            .dependents
                            .get(*name)
                            .is_some_and(|plugins| plugins.iter().any(|item| item == plugin))
                })
                .map(|(name, _)| name.clone())
                .collect()
        };
        for name in cleared {
            state.restarts.remove(&name);
            emit_host(
                Level::Debug,
                "host.trace.sidecar.restart-reset",
                serde_json::json!({"sidecar": name, "surface": surface}),
            );
        }
    }

    /// Changes the clock of the restart limit of the sidecars of either transport (docs/spec/sidecars.md#failure). A check
    /// injects a clock that it moves; the default is the monotonic clock. Call it only right after creation, before another
    /// reference exists.
    pub fn with_clock(self, clock: impl Fn() -> Instant + Send + Sync + 'static) -> Self {
        let clock: Arc<dyn Fn() -> Instant + Send + Sync> = Arc::new(clock);
        self.core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which the clock change
            // amends; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .clock = clock;
        self
    }

    /// Passes body that came from the surface surface of the window owner to the sidecar name. It is serialized outside
    /// the mutex and sent over a non-blocking channel, so a slow sidecar does not block other sends.
    pub fn send(
        &self,
        owner: &O,
        name: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        self.send_with_cids(owner, name, surface, body, &[])
    }

    /// Sends a page request that continues the inputs named by `cids`; the request line carries them as the field `cids`,
    /// and no field when `cids` is empty.
    pub fn send_with_cids(
        &self,
        owner: &O,
        name: &str,
        surface: &str,
        body: &RawValue,
        cids: &[String],
    ) -> Result<(), String> {
        let current = owner.root()?;
        let root = {
            let state = self
                .core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the surface roots, which are only read; the
                // panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            // default: a surface with no recorded directory starts from the current project root of the window.
            state.roots.get(surface).cloned().unwrap_or(current)
        };

        // The JSON serialization is done outside the mutex.
        let mut line = serde_json::to_vec(&Request {
            surface,
            root: Some(&root),
            closed: false,
            cids,
            body: Some(body),
        })
        .map_err(|e| e.to_string())?;
        line.push(b'\n');
        trace_message("sidecar.send", name, surface, body);

        let mut state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which the send reads and
            // amends; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        if state.stopped {
            return Err("sidecars are stopped".into());
        }
        if self.core.declaration(name).is_none() {
            return Err(format!("sidecar {name} is not declared by any plugin"));
        }
        if let Some(other) = state.owners.get(surface)
            && other.key() != owner.key()
        {
            return Err(format!("surface {surface} belongs to another window"));
        }
        let disconnected = state
            .running
            .get(name)
            .and_then(|process| process.persistent.as_ref())
            .is_some_and(|connection| !connection.connected.load(Ordering::Acquire));
        if disconnected {
            state.running.remove(name);
            crate::application_log::log_info(
                &format!("sidecar {name}"),
                "discarding disconnected persistent connection",
            );
        }
        // A refusal by the restart limit is reported to the owner after the unlock: as the failure event of a standard
        // input and output sidecar, and as the connection notice of a persistent service (docs/spec/sidecars.md#failure).
        if restart_refused(&mut state, name, surface) {
            drop(state);
            let persistent = self
                .core
                .declaration(name)
                .is_some_and(|(_, persistent)| persistent);
            if !persistent {
                owner.deliver_failure(Failure {
                    sidecar: name.to_string(),
                    surface: surface.to_string(),
                    reason: "restart limit".to_string(),
                });
            } else {
                match connection_notice(&Err(RESTART_LIMIT_REASON.to_string())) {
                    Ok(body) => owner.deliver(Message {
                        sidecar: name.to_string(),
                        surface: surface.to_string(),
                        body,
                    }),
                    Err(error) => log_error(
                        &format!("sidecar {name}"),
                        format!("connection notice serialization: {error}"),
                    ),
                }
            }
            return Err(format!("sidecar {name}: restart limit"));
        }
        // The first start, for which no loss was announced, has no notification. When the start consumes the record of
        // an earlier connection loss, this call sends the connection notification (V5-106). If the start fails, the
        // error of this send conveys that failure to the caller.
        let (mut state, started) = Core::ensure(&self.core, state, name, None)?;
        let restarted = started && state.unannounced_loss.remove(name);
        // The lock was released during the start, so the owner of the surface is checked again.
        if let Some(other) = state.owners.get(surface)
            && other.key() != owner.key()
        {
            return Err(format!("surface {surface} belongs to another window"));
        }
        state.owners.insert(surface.to_string(), owner.clone());
        state
            .roots
            .entry(surface.to_string())
            .or_insert_with(|| root.clone());
        let process = state.running.get_mut(name).expect("started above");
        // A new surface or a new service of an outdated sidecar changes host.sidecars, which is announced after the
        // unlock.
        let outdated_changed = (started || !process.surfaces.contains(surface))
            && is_outdated(&self.core, name, process);
        process.surfaces.insert(surface.to_string());

        // It sends to the channel without blocking. When the channel is full, it returns an "is not keeping up" error.
        let delivered = process
            .outbox
            .try_send(Outgoing::Line(QueuedLine::new(line)))
            .map_err(|_| format!("sidecar {name} is not keeping up"));
        if delivered.is_ok() && !cids.is_empty() {
            for _ in 0..state
                .requests
                .add(name, surface, cids, crate::event_log::monotonic_ns())
            {
                crate::buffer_bounds::record_buffer_drop(
                    "sidecar reply ledger",
                    0,
                    &format!("{} requests", crate::sidecar_reply::PENDING_REQUEST_LIMIT),
                );
            }
        }
        let changed = state.closing_changed.clone();
        drop(state);
        // The request is recorded once it is queued for the sidecar, so a request that was refused is not recorded.
        if delivered.is_ok() && !cids.is_empty() {
            crate::event_record::emit_host_cids(
                crate::event_log::Level::Info,
                "host.sidecar.request",
                cids,
                serde_json::json!({"name": name, "surface": surface, "bytes": body.get().len()}),
            );
        }
        if restarted {
            notify_connection(&self.core, name, Ok(()));
        }
        if let (true, Some(changed)) = (outdated_changed, changed) {
            changed();
        }
        delivered
    }

    /// Returns each persistent sidecar that is already running, with the surfaces that have sent to it, sorted by name.
    ///
    /// Even when the page removed the image registration from the host first, the recovery after a reload must
    /// initialize the persistent surface work.
    pub fn running_persistent(&self) -> Result<Vec<(String, Vec<String>)>, String> {
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the panic
            // hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let mut running: Vec<_> = state
            .running
            .iter()
            .filter(|(name, process)| {
                // default: a sidecar that did not declare persistent runs for each window.
                self.core
                    .declaration(name)
                    .is_some_and(|(_, persistent)| persistent)
                    && process
                        .persistent
                        .as_ref()
                        .is_some_and(|connection| connection.connected.load(Ordering::Acquire))
            })
            .map(|(name, process)| (name.clone(), process.surfaces.iter().cloned().collect()))
            .collect();
        running.sort();
        Ok(running)
    }

    /// Notifies all running sidecars of the surfaces of the window owner that are not in alive.
    pub fn retain(&self, owner: &O, alive: &dyn Fn(&str) -> bool) -> Result<(), String> {
        let mut state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the panic
            // hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let key = owner.key();
        let gone: Vec<String> = state
            .owners
            .iter()
            .filter(|(surface, current)| current.key() == key && !alive(surface))
            .map(|(surface, _)| surface.clone())
            .collect();

        let mut closed_any = false;
        for surface in gone {
            state.owners.remove(&surface);
            let root = state.roots.remove(&surface);

            let mut line = serde_json::to_vec(&Request {
                surface: &surface,
                root: root.as_deref(),
                closed: true,
                cids: &[],
                body: None,
            })
            .map_err(|e| e.to_string())?;
            line.push(b'\n');

            let names: Vec<String> = state.running.keys().cloned().collect();
            for name in names {
                *state
                    .closing
                    .entry(name)
                    .or_default()
                    .entry(surface.clone())
                    .or_default() += 1;
                closed_any = true;
            }
            // First collects the processes to which a channel send will be tried (to avoid a borrow conflict).
            let processes: Vec<(String, Result<(), TrySendError<Outgoing>>)> = state
                .running
                .iter()
                .map(|(name, process)| {
                    let result = process
                        .outbox
                        .try_send(Outgoing::Line(QueuedLine::new(line.clone())));
                    (name.clone(), result)
                })
                .collect();

            // Only the items for which the queue is full are buffered in order. An item whose connection is lost
            // reports a failure.
            for (name, result) in processes {
                if let Err(error) = result {
                    if matches!(error, TrySendError::Full(_)) {
                        if let Err(limit) = state
                            .pending_closes
                            .entry(name.clone())
                            .or_default()
                            .add(line.clone())
                        {
                            // The close is not sent, so no reply to it comes: the surface is not waited for. The sidecar
                            // keeps its session until it ends.
                            record_buffer_drop(
                                &format!("sidecar {name} pending closes"),
                                line.len(),
                                &limit,
                            );
                            if let Some(waiting) = state.closing.get_mut(&name)
                                && let Some(count) = waiting.get_mut(&surface)
                            {
                                *count -= 1;
                                if *count == 0 {
                                    waiting.remove(&surface);
                                }
                            }
                            continue;
                        }
                        crate::application_log::log_info(
                            &format!("sidecar {name}"),
                            format!("close {surface}: outbox full, buffered"),
                        );
                    } else {
                        log_error(
                            &format!("sidecar {name}"),
                            format!("close {surface}: the outbox is disconnected"),
                        );
                    }
                }
            }
        }
        let changed = state.closing_changed.clone();
        drop(state);
        if let (true, Some(changed)) = (closed_any, changed) {
            changed();
        }
        self.replace_idle();
        Ok(())
    }

    /// The persistent sidecars whose running service has another version than the installed one, sorted by sidecar
    /// (host.sidecars, docs/spec/terminal-runtime.md#updates).
    pub fn outdated(&self) -> Vec<OutdatedSidecar> {
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let mut list: Vec<OutdatedSidecar> = state
            .running
            .iter()
            .filter(|(name, process)| is_outdated(&self.core, name, process))
            .map(|(name, process)| OutdatedSidecar {
                sidecar: name.clone(),
                running: process
                    .persistent
                    .as_ref()
                    .and_then(|connection| connection.version.clone()),
                installed: self.core.version(name),
                sessions: process
                    .surfaces
                    .iter()
                    .filter(|surface| state.owners.contains_key(*surface))
                    .count(),
            })
            .collect();
        list.sort_by(|left, right| left.sidecar.cmp(&right.sidecar));
        list
    }

    /// Replaces the persistent service of the sidecar `name`, whose `hello` version differs from the installed
    /// version: it sends close-owner and shutdown and closes the transport, and the reconnection that follows starts
    /// the installed executable through the creation path and notifies the surfaces that sent to the sidecar
    /// (docs/spec/terminal-runtime.md#updates). A sidecar without a running service of another version is refused.
    pub fn replace(&self, name: &str) -> Result<(), String> {
        let (outbox, close_waiters, shutdown_waiters, connected, owner_closed) = {
            let mut state = self
                .core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which the replacement
                // amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            let refused = || {
                format!(
                    "sidecar {name}: no running service of another version than the installed one"
                )
            };
            if state.stopped {
                return Err(refused());
            }
            let process = state.running.get(name).ok_or_else(refused)?;
            if !is_outdated(&self.core, name, process) {
                return Err(refused());
            }
            let Some(connection) = process.persistent.as_ref() else {
                return Err(refused());
            };
            let handles = (
                process.outbox.clone(),
                Arc::clone(&connection.close_waiters),
                Arc::clone(&connection.shutdown_waiters),
                Arc::clone(&connection.connected),
                Arc::clone(&connection.owner_closed),
            );
            let running = connection.version.clone();
            let service_pid = connection.service_pid;
            if state.replacing.contains_key(name) {
                return Err(format!("sidecar {name}: a replacement is running"));
            }
            state.replacing.insert(
                name.to_string(),
                Replacement {
                    running,
                    installed: self.core.version(name),
                    pid: service_pid,
                    timeout: self.stop_timeout,
                },
            );
            handles
        };
        static REPLACEMENTS: AtomicU64 = AtomicU64::new(0);
        let prefix = format!(
            "{}-replace-{}",
            std::process::id(),
            REPLACEMENTS.fetch_add(1, Ordering::Relaxed)
        );
        let deadline = std::time::Instant::now() + self.stop_timeout;
        let closed = close_persistent_owner(
            &outbox,
            &close_waiters,
            &shutdown_waiters,
            &connected,
            &owner_closed,
            &prefix,
            deadline,
        );
        // The caller that did not close the owner leaves the transport to the one that did.
        let send_close = match &closed {
            Ok(done) => *done,
            Err(failure) => failure.send_close,
        };
        let failure = closed.err();
        if send_close && let Err(error) = outbox.send(Outgoing::Close) {
            log_error(
                &format!("sidecar {name}"),
                format!("close persistent transport: {error}"),
            );
        }
        match failure {
            None => Ok(()),
            Some(failure) => {
                self.core
                    .state
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call
                    // amends; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner)
                    .replacing
                    .remove(name);
                Err(format!("sidecar {name}: replace: {}", failure.text))
            }
        }
    }

    /// Replaces each outdated service that has no open surface of this application.
    fn replace_idle(&self)
    where
        O: 'static,
    {
        for item in self.outdated() {
            let busy = self
                .core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read;
                // the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .replacing
                .contains_key(&item.sidecar);
            if item.sessions != 0 || busy {
                continue;
            }
            let core = Arc::clone(&self.core);
            let stop_timeout = self.stop_timeout;
            crate::routine::spawn_named("sidecar-replace", move || {
                let sidecars = Sidecars { core, stop_timeout };
                if let Err(error) = sidecars.replace(&item.sidecar) {
                    log_error("replace", error);
                }
            });
        }
    }

    /// Returns the surfaces for which closed was sent and no answer was received, in the order of sidecar and surface
    /// (host.sidecars).
    pub fn closing(&self) -> Vec<ClosingSurface> {
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        state
            .closing
            .iter()
            .flat_map(|(sidecar, surfaces)| {
                surfaces.keys().map(move |surface| ClosingSurface {
                    sidecar: sidecar.clone(),
                    surface: surface.clone(),
                })
            })
            .collect()
    }

    /// Sets the notification to call outside the lock when closing changes.
    pub fn on_closing_changed(&self, changed: impl Fn() + Send + Sync + 'static) {
        self.core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .closing_changed = Some(Arc::new(changed));
    }

    /// Closes the sessions of this application in each persistent service that are not in surfaces (surface, root), and
    /// returns the number of closed sessions (docs/spec/terminal-runtime.md). A surface to which this process already
    /// sent a message is kept even if it is not in the list. When no service is running and there is no endpoint, there
    /// is no session, so it is skipped.
    pub fn retain_sessions(&self, surfaces: &[(String, String)]) -> Result<usize, String> {
        let mut total = 0;
        let mut names: Vec<String> = self
            .core
            .declarations
            .read()
            // default: a lock that a panicking thread poisoned still holds the sidecar declarations, which are only
            // read; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .persistent
            .iter()
            .filter(|(_, persistent)| **persistent)
            .map(|(name, _)| name.clone())
            .collect();
        names.sort();
        for name in names {
            let request = format!(
                "retain-{}-{}",
                std::process::id(),
                RETAIN_REQUESTS.fetch_add(1, Ordering::Relaxed)
            );
            let (waiter, answer) = sync_channel(1);
            {
                let mut state = self
                    .core
                    .state
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the sidecar state, which the start reads
                    // and amends; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner);
                if state.stopped {
                    return Err("sidecars are stopped".into());
                }
                let mut keep: Vec<serde_json::Value> = surfaces
                    .iter()
                    .map(|(surface, root)| serde_json::json!({"surface": surface, "root": root}))
                    .collect();
                keep.extend(
                    state.roots.iter().map(
                        |(surface, root)| serde_json::json!({"surface": surface, "root": root}),
                    ),
                );
                if !state.running.contains_key(&name) {
                    let (program, _) = self
                        .core
                        .declaration(&name)
                        .ok_or_else(|| format!("sidecar {name} is not declared"))?;
                    let basename = program
                        .file_name()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| {
                            format!("sidecar {name}: executable has no valid basename")
                        })?;
                    let endpoint = self
                        .core
                        .config_directory
                        .join("services")
                        .join(basename)
                        .join("endpoint.json");
                    match std::fs::metadata(&endpoint) {
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => {
                            return Err(format!("sidecar {name}: read endpoint: {error}"));
                        }
                    }
                    state = Core::ensure(&self.core, state, &name, None)?.0;
                }
                let process = state.running.get(&name).expect("started above");
                let connection = process
                    .persistent
                    .as_ref()
                    .ok_or_else(|| format!("sidecar {name} is not a persistent service"))?;
                connection
                    .retain_waiters
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the waiters of the retain replies,
                    // which the call amends; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(request.clone(), waiter);
                let mut line = serde_json::to_vec(&serde_json::json!({
                    "operation": "retain",
                    "request": request,
                    "surfaces": keep,
                }))
                .map_err(|e| e.to_string())?;
                line.push(b'\n');
                process
                    .outbox
                    .try_send(Outgoing::Line(QueuedLine::new(line)))
                    .map_err(|_| format!("sidecar {name} is not keeping up"))?;
            }
            total += answer
                .recv_timeout(RETAIN_TIMEOUT)
                .map_err(|_| {
                    format!("sidecar {name}: retain was not answered within {RETAIN_TIMEOUT:?}")
                })?
                .map_err(|error| format!("sidecar {name}: retain: {error}"))?;
        }
        Ok(total)
    }

    /// The size in bytes of the line that the writer of the running sidecar `name` is writing, and 0 between lines; a
    /// sidecar that reads nothing keeps its writer inside one line once its input is full.
    pub fn writing(&self, name: &str) -> Result<usize, String> {
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let process = state
            .running
            .get(name)
            .ok_or_else(|| format!("sidecar {name} is not running"))?;
        Ok(process.writing.load(Ordering::Acquire))
    }

    /// Whether a plugin declares the sidecar `name`; a sidecar that no plugin declares any more ended with the removal of
    /// its plugin.
    pub fn declared(&self, name: &str) -> bool {
        self.core.declaration(name).is_some()
    }

    /// Passes a response (such as an image return) to the sidecar. It has the same role as ResponseSender. When the
    /// channel is full, the response is buffered for each surface:image and the write thread sends it.
    pub fn send_response(
        &self,
        name: &str,
        surface: &str,
        image: &str,
        body: &RawValue,
    ) -> Result<(), ResponseError> {
        #[derive(Serialize)]
        struct Response<'a> {
            surface: &'a str,
            body: &'a RawValue,
        }

        let response = Response { surface, body };
        let mut line = serde_json::to_vec(&response).map_err(|e| {
            ResponseError::Failed(format!("sidecar {name}: response serialize: {e}"))
        })?;
        line.push(b'\n');

        let mut state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which the response
            // amends; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        if state.stopped {
            return Err(ResponseError::Failed("sidecars are stopped".into()));
        }
        let process = state
            .running
            .get(name)
            .ok_or_else(|| ResponseError::Ended(format!("sidecar {name} is not running")))?;

        // It sends to the channel without blocking. When the channel is full, it buffers.
        match process
            .outbox
            .try_send(Outgoing::Line(QueuedLine::new(line.clone())))
        {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                // The channel is full, so immutable responses are kept in the order of sending.
                let key = format!("{}:{}:{}", surface, image, body.get());
                let size = line.len();
                if let Err(limit) = state
                    .pending_replies
                    .entry(name.to_string())
                    .or_default()
                    .add(line)
                {
                    record_buffer_drop(&format!("sidecar {name} pending replies"), size, &limit);
                    return Err(ResponseError::Failed(refused_reply(name, &limit, surface)));
                }
                crate::application_log::log_info(
                    &format!("sidecar {name}"),
                    format!("response queue full, buffering {key}"),
                );
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => Err(ResponseError::Ended(format!(
                "sidecar {name} response channel is disconnected"
            ))),
        }
    }

    /// Terminates all sidecars. It sends the Close signal to the channel so that the write thread ends and closes
    /// stdin, waits for the process to end, and kills it by force when the deadline passes.
    pub fn stop(&self) {
        self.stop_all(false);
    }

    /// Stops the sidecars as `stop` does, except that a persistent service gets no close-owner and no shutdown: its
    /// connection ends and its sessions stay for the application that starts next (docs/spec/installation.md#application-update).
    pub fn detach(&self) {
        self.stop_all(true);
    }

    fn stop_all(&self, detach: bool) {
        let (processes, changed): (Vec<(String, Process)>, Option<ClosingChanged>) = {
            let mut state = self
                .core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which the stop
                // amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            state.stopped = true;
            // A sidecar that is starting is registered when it ends, so the list of running sidecars is emptied after
            // waiting for that start.
            while !state.starting.is_empty() {
                state = self
                    .core
                    .started
                    .wait(state)
                    // default: a wait that a poisoned lock ends still returns the guard of the sidecar state, which the
                    // call amends; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner);
            }
            // A standard-I/O sidecar ends, so it does not answer a close. A persistent service answers a close that was
            // sent before the stop earlier than the close-owner response, so that surface is kept until the answer or
            // the end of the connection (docs/spec/sidecars.md#messages).
            let stdio: Vec<String> = state
                .running
                .iter()
                .filter(|(_, process)| process.persistent.is_none())
                .map(|(name, _)| name.clone())
                .collect();
            let mut changed = None;
            for name in stdio {
                changed = detach_stdio(&mut state, &name).or(changed);
            }
            (state.running.drain().collect(), changed)
        };
        if let Some(changed) = changed {
            changed();
        }
        self.stop_processes(processes, detach);
    }

    /// Stops processes, which are out of the running list, by the stop rules and waits until they end
    /// (docs/spec/sidecars.md#declaration-and-startup). With `detach` a persistent service only loses its connection.
    fn stop_processes(&self, processes: Vec<(String, Process)>, detach: bool) {
        // Waits for all processes in parallel.
        let deadline = std::time::Instant::now() + self.stop_timeout;
        let mut handles = Vec::new();
        for (name, process) in processes {
            let state = Arc::clone(&self.core.state);
            let handle = crate::routine::spawn_named("sidecar-close", move || {
                if process.child.is_none() {
                    if let Some(persistent) = process.persistent {
                        if detach {
                            if let Err(error) = process.outbox.send(Outgoing::Close) {
                                log_error(
                                    &format!("sidecar {name}"),
                                    format!("close persistent transport: {error}"),
                                );
                            }
                            return;
                        }
                        let prefix = std::process::id().to_string();
                        let closed = close_persistent_owner(
                            &process.outbox,
                            &persistent.close_waiters,
                            &persistent.shutdown_waiters,
                            &persistent.connected,
                            &persistent.owner_closed,
                            &prefix,
                            deadline,
                        );
                        // The caller that did not close the owner leaves the transport to the one that did.
                        let send_close = match &closed {
                            Ok(done) => *done,
                            Err(failure) => failure.send_close,
                        };
                        if let Err(failure) = closed {
                            log_error(&format!("sidecar {name}"), failure.text);
                        }
                        if send_close && let Err(error) = process.outbox.send(Outgoing::Close) {
                            log_error(
                                &format!("sidecar {name}"),
                                format!("close persistent transport: {error}"),
                            );
                        }
                    }
                    return;
                }
                // Sends the Close signal. When the write thread receives it, it leaves the blocking loop and closes
                // stdin.
                match process.outbox.try_send(Outgoing::Close) {
                    Ok(()) => {}
                    Err(TrySendError::Full(close)) => {
                        // The channel is full: a blocking send is tried on a separate thread. This thread does not
                        // block stop().
                        let tx = process.outbox.clone();
                        let close_name = name.clone();
                        crate::routine::spawn_named("sidecar-close-send", move || {
                            if let Err(e) = tx.send(close) {
                                log_error(
                                    &format!("sidecar {close_name}"),
                                    format!("send close: {e}"),
                                );
                            }
                        });
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        // The channel is closed. The write thread has already ended, so nothing is sent.
                    }
                }

                let Some(mut child) = process.child else {
                    return;
                };

                // Waits based on SIGCHLD with the wait-timeout crate (no polling). The crate passes the remaining time
                // to poll rounded down to ms, so it can return up to 1 ms before the deadline. It waits again for the
                // time that remains until the deadline is reached, so it does not kill before the deadline.
                let waited = loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    match child.wait_timeout(remaining) {
                        Ok(None) if !remaining.is_zero() => continue,
                        other => break other,
                    }
                };
                // The report of the end omits an end that the pipe closed after a violation caused
                // (docs/spec/sidecars.md#declaration-and-startup).
                let violated = |state: &Arc<Mutex<State<O>>>| {
                    state
                        .lock()
                        // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only
                        // read; the panic hook records the panic.
                        .unwrap_or_else(PoisonError::into_inner)
                        .stopping
                        .get(&name)
                        .is_some_and(|stopping| stopping.violated)
                };
                let pid = child.id();
                // The stop ends the process in every branch below, so the sampler stops reading it here.
                crate::performance::process_remove(pid);
                let stop_exit = |status: &str| {
                    crate::event_record::emit_host(
                        crate::event_log::Level::Info,
                        "host.sidecar.exit",
                        serde_json::json!({"name": name, "pid": pid, "status": status, "stopping": true}),
                    );
                };
                match waited {
                    Ok(Some(status)) => {
                        stop_exit(&exit_text(status));
                        if !status.success() && !violated(&state) {
                            log_error(
                                &format!("sidecar {name}"),
                                format!("exited while stopping: {}", exit_text(status)),
                            );
                        }
                    }
                    Ok(None) => {
                        // The deadline passed. Kill by force.
                        match child.kill() {
                            Ok(()) => log_error(
                                &format!("sidecar {name}"),
                                "did not end within the stop timeout and was killed",
                            ),
                            Err(e) => log_error(&format!("sidecar {name}"), format!("kill: {e}")),
                        }
                        match child.wait() {
                            Ok(status) => stop_exit(&exit_text(status)),
                            Err(e) => log_error(
                                &format!("sidecar {name}"),
                                format!("wait after kill: {e}"),
                            ),
                        }
                    }
                    Err(e) => {
                        // A wait() error. The process has already ended or has already been waited for.
                        log_error(&format!("sidecar {name}"), format!("wait: {e}"));
                    }
                }
            });
            handles.push(handle);
        }

        // Waits until all threads complete.
        for handle in handles {
            if let Err(e) = handle.join() {
                log_error("sidecar stop", format!("thread join: {e:?}"));
            }
        }
    }
}

/// The upper limit of the time until the service answers hello (docs/spec/terminal-runtime.md).
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// The default upper limit of the time until a newly started persistent service prints its endpoint
/// (docs/spec/terminal-runtime.md).
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Reads the first line that a newly started service prints to stdout. When no line arrives within limit, it ends and
/// reaps that service and fails, and appends the failure of that cleanup after the error. The second value of the error
/// is true when no line arrived within limit, the start failure that the restart limit counts.
fn service_endpoint_line(
    name: &str,
    child: &mut Child,
    stdout: std::process::ChildStdout,
    limit: Duration,
) -> Result<String, (String, bool)> {
    let (sender, receiver) = sync_channel(1);
    let reader_name = name.to_string();
    crate::routine::spawn_named("sidecar-read-line", move || {
        let mut line = String::new();
        let read = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        // The receiving side ends when the limit passes, and that timeout is reported as the error of the start.
        if sender.send(read).is_err() {
            crate::application_log::log_info(
                &format!("sidecar {reader_name}"),
                "the service output ended after the ready bound",
            );
        }
    });
    match receiver.recv_timeout(limit) {
        Ok(read) => read.map_err(|e| (format!("sidecar {name}: service startup: {e}"), false)),
        Err(_) => {
            let message = format!(
                "sidecar {name}: the service did not print its endpoint within {}s",
                limit.as_secs()
            );
            // When the service ends, stdout is closed and the read thread ends too.
            if let Err(error) = child.kill() {
                return Err((
                    format!("{message}; ending the service failed: {error}"),
                    true,
                ));
            }
            if let Err(error) = child.wait() {
                return Err((
                    format!("{message}; reaping the service failed: {error}"),
                    true,
                ));
            }
            Err((message, true))
        }
    }
}

impl<O: Owner> Core<O> {
    /// Checks the running sidecar and, if there is none, starts and registers it. It is called while holding state and
    /// returns while holding it. The start waits for the process to start and for the connection and authentication of
    /// a persistent service, so it is done with the lock released. Meanwhile requests of other sidecars do not wait,
    /// and requests of the same sidecar wait for that start to end. The second value is whether this call started it.
    /// lost is the revival of a lost persistent connection that runs this start, None for a send or a retain. While the
    /// restart limit stops the sidecar, it starts nothing (docs/spec/terminal-runtime.md#service-transport).
    fn ensure<'a>(
        core: &'a Arc<Self>,
        mut state: MutexGuard<'a, State<O>>,
        name: &str,
        lost: Option<&Revival>,
    ) -> Result<(MutexGuard<'a, State<O>>, bool), String> {
        loop {
            if state.running.contains_key(name) {
                return Ok((state, false));
            }
            if state.stopped {
                return Err("sidecars are stopped".into());
            }
            if !state.starting.contains(name) {
                break;
            }
            state = core
                .started
                .wait(state)
                // default: a wait that a poisoned lock ends still returns the guard of the sidecar state, which the
                // start amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
        }
        if restart_stopped(&state, name) {
            return Err(format!("sidecar {name}: restart limit"));
        }
        state.starting.insert(name.to_string());
        drop(state);
        let started = Self::start(core, name, lost);
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the start amends; the
        // panic hook records the panic.
        let mut state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.starting.remove(name);
        core.started.notify_all();
        let Started { process, threads } = started?;
        // stop empties the list of running sidecars after it waited for the starts to end, so a start that ended while
        // stopping is also registered and stop cleans it up.
        state.running.insert(name.to_string(), process);
        for thread in threads {
            crate::routine::spawn_named("sidecar-transport", thread);
        }
        if state.stopped {
            return Err("sidecars are stopped".into());
        }
        Ok((state, true))
    }

    /// Starts a sidecar. A persistent declaration attaches to the service, and otherwise it is started as a child
    /// process of the window. The write and read threads are returned so that they are started after the registration.
    /// lost is the revival that runs the start of a persistent service, or None.
    fn start(core: &Arc<Self>, name: &str, lost: Option<&Revival>) -> Result<Started, String> {
        let (program, persistent) = core
            .declaration(name)
            .ok_or_else(|| format!("sidecar {name} is not declared by any plugin"))?;
        // default: a sidecar that did not declare persistent runs for each window.
        if persistent {
            return Self::start_persistent(core, name, &program, lost);
        }
        let mut threads: Vec<Thread> = Vec::new();
        let mut command = Command::new(&program);
        // The host has the folder `logs` of its configuration directory, where a sidecar writes its event file
        // (docs/spec/sidecars.md#log).
        command
            .arg("--log-dir")
            .arg(core.config_directory.join("logs"));
        let spawned_at = Instant::now();
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
        // The host reads the standard error line by line and writes each line as a record (docs/spec/sidecars.md#log).
        if let Some(stderr) = child.stderr.take() {
            let place = name.to_string();
            crate::routine::spawn_named("sidecar-stderr", move || {
                write_stderr_records(stderr, &place)
            });
        }
        crate::event_record::emit_host(
            crate::event_log::Level::Info,
            "host.sidecar.start",
            serde_json::json!({"name": name, "pid": child.id()}),
        );
        crate::performance::process_add("sidecar", name, child.id());
        let mut stdin = child.stdin.take().ok_or("sidecar stdin is missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout is missing")?;

        // Creates a synchronous channel with capacity 256.
        let (tx, rx) = sync_channel::<Outgoing>(256);

        // The write thread reads from the outbox channel and writes to stdin. The order is: (1) write everything in the
        // queue without blocking, (2) when the queue is empty, write all held items, (3) then receive from the channel
        // with blocking. In this way the held items (which arise only when the queue is full) go out after the messages
        // that were in the queue earlier, so the order is correct. When the thread ends because the channel is closed,
        // it also writes all held items before it closes stdin.
        let write_name = name.to_string();
        let state_clone = Arc::clone(&core.state);
        let writing = Arc::new(AtomicUsize::new(0));
        let write_writing = Arc::clone(&writing);

        threads.push(Box::new(move || {
            loop {
                loop {
                    match rx.try_recv() {
                        Ok(Outgoing::Line(line)) => {
                            if !write_line(&mut stdin, &write_name, &line, &write_writing) {
                                return;
                            }
                        }
                        Ok(Outgoing::Close) | Err(TryRecvError::Disconnected) => {
                            write_pending(&state_clone, &write_name, &mut stdin, &write_writing);
                            return;
                        }
                        Err(TryRecvError::Empty) => break,
                    }
                }
                if !write_pending(&state_clone, &write_name, &mut stdin, &write_writing) {
                    return;
                }
                match rx.recv() {
                    Ok(Outgoing::Line(line)) => {
                        if !write_line(&mut stdin, &write_name, &line, &write_writing) {
                            return;
                        }
                    }
                    Ok(Outgoing::Close) | Err(RecvError) => {
                        write_pending(&state_clone, &write_name, &mut stdin, &write_writing);
                        return;
                    }
                }
            }
        }));

        // The read thread reads from stdout and passes events, and handles a failure when the output ends or the
        // protocol is violated.
        let state = Arc::clone(&core.state);
        let sidecar = name.to_string();
        let tx_clone = tx.clone();
        let pid = child.id();
        threads.push(Box::new(move || {
            let mut ready = Some(ReadyClock {
                spawned: spawned_at,
                pid,
            });
            let mut reader = BufReader::new(stdout);
            let violation = relay(&mut reader, &state, &sidecar, &tx_clone, &mut ready);
            // The read end is closed so that a process that is still writing is not blocked in a write.
            drop(reader);
            drop(tx_clone);
            fail(&state, &sidecar, pid, violation);
        }));

        Ok(Started {
            process: Process {
                child: Some(child),
                outbox: tx,
                writing,
                persistent: None,
                surfaces: HashSet::new(),
            },
            threads,
        })
    }

    /// Counts a start failure of the creation path of the persistent service name for the restart limit and returns its
    /// text. lost is the revival that runs the start, or None.
    fn service_start_failure(
        core: &Arc<Self>,
        name: &str,
        lost: Option<&Revival>,
        text: String,
    ) -> String {
        // default: a lock that a panicking thread poisoned still holds the restart-limit records, which the count amends;
        // the panic hook records the panic.
        let mut state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
        count_service_failure(&mut state, name, lost);
        text
    }

    /// Connects to the persistent service name, and starts it when no live service has an endpoint. lost is the revival
    /// that runs it, or None: a revival that finds no live service counts the end of the service process before it
    /// spawns, and the restart limit can stop it there (docs/spec/terminal-runtime.md#service-transport).
    fn start_persistent(
        core: &Arc<Self>,
        name: &str,
        program: &Path,
        lost: Option<&Revival>,
    ) -> Result<Started, String> {
        #[derive(Deserialize)]
        struct Endpoint {
            protocol: u64,
            pid: u32,
            socket: String,
            token: String,
        }

        let config = &core.config_directory;
        let basename = program
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && *value != "." && *value != "..")
            .ok_or_else(|| format!("sidecar {name}: executable has no valid basename"))?;
        let service_dir = config.join("services").join(basename);
        current()?
            .create_private_directories(&service_dir)
            .map_err(|e| format!("sidecar {name}: create service directory: {e}"))?;
        current()?
            .secure_service_directory(&service_dir)
            .map_err(|e| format!("sidecar {name}: service directory permissions: {e}"))?;
        let endpoint_path = service_dir.join("endpoint.json");

        let mut child = None;
        let mut spawn_clock = None;
        let endpoint: Endpoint = match std::fs::read(&endpoint_path) {
            Ok(bytes) => {
                let endpoint: Endpoint = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("sidecar {name}: invalid endpoint: {e}"))?;
                if !current()?.service_process_exists(endpoint.pid)? {
                    std::fs::remove_file(&endpoint_path)
                        .map_err(|e| format!("sidecar {name}: remove stale endpoint: {e}"))?;
                    // It re-enters the only creation path. A stale endpoint is an explicit crash recovery case and not
                    // a fallback transport.
                    return Self::start_persistent(core, name, program, lost);
                }
                endpoint
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if lost.is_some() {
                    // default: a lock that a panicking thread poisoned still holds the restart-limit records, which the
                    // count amends; the panic hook records the panic.
                    let mut state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
                    if count_service_failure(&mut state, name, lost) {
                        return Err(RESTART_LIMIT_REASON.to_string());
                    }
                }
                // The service outlives this host, so it writes to its own log file and not to the standard error of the
                // host (docs/spec/hosts.md#application-log). There is no endpoint, so no service writes to that file.
                let service_log = crate::application_log::open_log(
                    &crate::application_log::service_log_path(config, basename),
                )
                .map_err(|error| format!("sidecar {name}: service log: {error}"))?;
                let mut command = Command::new(program);
                command
                    .arg("--service-dir")
                    .arg(&service_dir)
                    .arg("--log-dir")
                    .arg(config.join("logs"))
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::from(service_log));
                // A persistent service belongs to the configuration directory and not to the lifetime of this
                // application process. A new session is started so that the service does not end together with the
                // application when the application terminates abnormally.
                current()?
                    .new_session(&mut command)
                    .map_err(|e| format!("sidecar {name}: new session: {e}"))?;
                let spawned_at = Instant::now();
                let mut spawned = command
                    .spawn()
                    .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
                let stdout = spawned
                    .stdout
                    .take()
                    .ok_or("persistent service stdout is missing")?;
                let line = service_endpoint_line(name, &mut spawned, stdout, core.ready_timeout)
                    .map_err(|(text, timed_out)| {
                        if timed_out {
                            Self::service_start_failure(core, name, lost, text)
                        } else {
                            text
                        }
                    })?;
                if line.is_empty() {
                    return Err(Self::service_start_failure(
                        core,
                        name,
                        lost,
                        format!("sidecar {name}: service exited before endpoint"),
                    ));
                }
                let endpoint: Endpoint = serde_json::from_str(&line)
                    .map_err(|e| format!("sidecar {name}: service endpoint: {e}"))?;
                spawn_clock = Some(ReadyClock {
                    spawned: spawned_at,
                    pid: endpoint.pid,
                });
                child = Some(spawned);
                endpoint
            }
            Err(error) => {
                return Err(format!("sidecar {name}: read endpoint: {error}"));
            }
        };
        if endpoint.protocol != 1 {
            return Err(format!(
                "sidecar {name}: service protocol {} is not supported",
                endpoint.protocol
            ));
        }
        if endpoint.socket.is_empty() || endpoint.token.is_empty() || endpoint.pid == 0 {
            return Err(format!("sidecar {name}: service endpoint is incomplete"));
        }
        let mut stream = current()?
            .connect_service(&endpoint.socket)
            .map_err(|e| format!("sidecar {name}: connect authenticated service: {e}"))?;
        // The read deadline is set only for the hello round trip (V5-106). The requests and stop of the same sidecar
        // wait for this start, so a service that accepted the socket and does not answer must not stop those requests.
        // When the deadline passes, the connection is a failure, and the connection loss record makes the next start
        // try the same path again. When the round trip ends, the deadline is set back to waiting indefinitely for the
        // read thread that follows. macOS rejects 0 (clear) for SO_RCVTIMEO with EINVAL, so clearing is replaced by a
        // deadline of one day. The read thread that follows wakes up once a day with WouldBlock and waits again.
        const NO_READ_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);
        stream
            .set_read_deadline(Some(HELLO_TIMEOUT))
            .map_err(|e| format!("sidecar {name}: hello deadline: {e}"))?;
        let hello = serde_json::json!({
            "operation": "hello",
            "protocol": 1,
            "token": endpoint.token.clone(),
            "client": core.config_directory.to_string_lossy(),
        });
        let mut line = serde_json::to_vec(&hello).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stream
            .write_all(&line)
            .map_err(|e| format!("sidecar {name}: hello: {e}"))?;
        stream
            .flush()
            .map_err(|e| format!("sidecar {name}: hello flush: {e}"))?;
        let mut response = String::new();
        let response_stream = stream.try_clone().map_err(|e| e.to_string())?;
        let mut response_reader = BufReader::new(response_stream);
        response_reader
            .read_line(&mut response)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                    Self::service_start_failure(
                        core,
                        name,
                        lost,
                        format!(
                            "sidecar {name}: the service did not answer hello within {}s",
                            HELLO_TIMEOUT.as_secs()
                        ),
                    )
                }
                _ => format!("sidecar {name}: hello response: {e}"),
            })?;
        let response: serde_json::Value = serde_json::from_str(&response)
            .map_err(|e| format!("sidecar {name}: hello response: {e}"))?;
        if response.get("operation").and_then(|v| v.as_str()) != Some("hello") {
            return Err(format!(
                "sidecar {name}: authentication handshake failed: invalid hello response"
            ));
        }
        if response.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let reason = response
                .get("error")
                .and_then(|v| v.as_str())
                // default: when the sidecar error has no text, the same failure is reported with a generic text.
                .unwrap_or("invalid hello response");
            return Err(format!(
                "sidecar {name}: authentication handshake failed: {reason}"
            ));
        }
        if response.get("protocol").and_then(|v| v.as_u64()) != Some(1) {
            return Err(format!(
                "sidecar {name}: service protocol mismatch in hello response"
            ));
        }
        // A service that sends no version is of an earlier version (docs/spec/terminal-runtime.md#updates).
        let version = response
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        // The hello succeeded, so the read deadline is extended to one day. macOS rejects the SO_RCVTIMEO setting of a
        // socket that the peer closed with EINVAL, so a failure in this step is a closed connection: a service that
        // answers hello and closes soon is not a live connection.
        stream
            .set_read_deadline(Some(NO_READ_DEADLINE))
            .map_err(|e| format!("sidecar {name}: hello deadline extend: {e}"))?;

        let reader_stream = response_reader.into_inner();
        let (tx, rx) = sync_channel::<Outgoing>(256);
        let mut threads: Vec<Thread> = Vec::new();
        let close_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
        let shutdown_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
        let retain_waiters: RetainWaiters = Arc::new(Mutex::new(HashMap::new()));
        let connected = Arc::new(AtomicBool::new(true));
        let write_name = name.to_string();
        let write_state = Arc::clone(&core.state);
        let writing = Arc::new(AtomicUsize::new(0));
        let write_writing = Arc::clone(&writing);
        let writer = stream;
        let writer_connected = Arc::clone(&connected);
        threads.push(Box::new(move || {
            struct ConnectionGuard(Arc<AtomicBool>);
            impl Drop for ConnectionGuard {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _connection_guard = ConnectionGuard(writer_connected);
            let mut writer = writer;
            loop {
                loop {
                    match rx.try_recv() {
                        Ok(Outgoing::Line(line)) => {
                            if !write_socket_line(&mut *writer, &write_name, &line, &write_writing)
                            {
                                return;
                            }
                        }
                        Ok(Outgoing::Close) | Err(TryRecvError::Disconnected) => {
                            if !write_pending_socket(
                                &write_state,
                                &write_name,
                                &mut *writer,
                                &write_writing,
                            ) {
                                log_error(
                                    &format!("sidecar {write_name}"),
                                    "the pending lines were not written before close",
                                );
                            }
                            shut_down_writer(&write_name, &mut *writer);
                            return;
                        }
                        Err(TryRecvError::Empty) => break,
                    }
                }
                if !write_pending_socket(&write_state, &write_name, &mut *writer, &write_writing) {
                    return;
                }
                match rx.recv() {
                    Ok(Outgoing::Line(line)) => {
                        if !write_socket_line(&mut *writer, &write_name, &line, &write_writing) {
                            return;
                        }
                    }
                    Ok(Outgoing::Close) | Err(RecvError) => {
                        if !write_pending_socket(
                            &write_state,
                            &write_name,
                            &mut *writer,
                            &write_writing,
                        ) {
                            log_error(
                                &format!("sidecar {write_name}"),
                                "the pending lines were not written before disconnect",
                            );
                        }
                        shut_down_writer(&write_name, &mut *writer);
                        return;
                    }
                }
            }
        }));

        let state = Arc::clone(&core.state);
        let reader_core = Arc::clone(core);
        let sidecar = name.to_string();
        let waiters = Arc::clone(&close_waiters);
        let shutdown_waiters_for_reader = Arc::clone(&shutdown_waiters);
        let retain_waiters_for_reader = Arc::clone(&retain_waiters);
        let tx_clone = tx.clone();
        let reader_service_pid = endpoint.pid;
        let mut reader_ready = spawn_clock;
        let reader_connected = Arc::clone(&connected);
        threads.push(Box::new(move || {
            struct ConnectionGuard(Arc<AtomicBool>);
            impl Drop for ConnectionGuard {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _connection_guard = ConnectionGuard(Arc::clone(&reader_connected));
            let mut reader = BufReader::new(reader_stream);
            // None when the connection ends, and the reason when the service violates the protocol.
            // (docs/spec/terminal-runtime.md#service-transport).
            let violation = (|| -> Option<String> {
                let mut line = Vec::new();
                loop {
                    match read_message_line(&mut reader, MESSAGE_LIMIT, &mut line) {
                        Ok(MessageLine::Complete) => {
                            record_ready(&mut reader_ready, &sidecar);
                        }
                        Ok(MessageLine::End) => return None,
                        Ok(MessageLine::Unfinished(bytes)) => {
                            log_unfinished_line(&sidecar, bytes);
                            return None;
                        }
                        Ok(MessageLine::TooLong) => {
                            return Some(format!("message exceeds {MESSAGE_LIMIT} bytes"));
                        }
                        Err(error) => {
                            log_error(
                                &format!("sidecar {sidecar}"),
                                format!("persistent read: {error}"),
                            );
                            return None;
                        }
                    }
                    let value: serde_json::Value = match serde_json::from_slice(&line) {
                        Ok(value) => value,
                        Err(error) => return Some(format!("invalid message: {error}")),
                    };
                    let Some(object) = value.as_object() else {
                        return Some("invalid message: not a JSON object".to_string());
                    };
                    let operation = match object.get("operation") {
                        None => None,
                        Some(serde_json::Value::String(operation)) => Some(operation.as_str()),
                        Some(_) => {
                            return Some("invalid message: operation: not a string".to_string());
                        }
                    };
                    if let Some(operation @ ("retained" | "closed-owner" | "shutdown")) = operation
                    {
                        let reply = match reply_of(operation, object) {
                            Ok(reply) => reply,
                            Err(reason) => return Some(reason),
                        };
                        let request = reply.request;
                        match operation {
                            "retained" => {
                                if let Some(sender) = retain_waiters_for_reader
                                    .lock()
                                    // default: a lock that a panicking thread poisoned still holds the waiters of the
                                    // retain replies, which the reader amends; the panic hook records the panic.
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .remove(&request)
                                {
                                    let result = match reply.result {
                                        Ok(()) => Ok(reply.closed),
                                        Err(error) => Err(error),
                                    };
                                    if let Err(std::sync::mpsc::SendError(result)) =
                                        sender.send(result)
                                    {
                                        late_reply(&sidecar, "retain", result.map(|_| ()));
                                    }
                                }
                            }
                            "closed-owner" => {
                                if let Some(sender) = waiters
                                    .lock()
                                    // default: a lock that a panicking thread poisoned still holds the waiters of
                                    // the close-owner replies, which the reader amends; the panic hook records the
                                    // panic.
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .remove(&request)
                                    && let Err(std::sync::mpsc::SendError(result)) =
                                        sender.send(reply.result)
                                {
                                    late_reply(&sidecar, "close-owner", result);
                                }
                            }
                            _ => {
                                if let Some(sender) = shutdown_waiters_for_reader
                                    .lock()
                                    // default: a lock that a panicking thread poisoned still holds the waiters of the
                                    // shutdown replies, which the reader amends; the panic hook records the panic.
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .remove(&request)
                                    && let Err(std::sync::mpsc::SendError(result)) =
                                        sender.send(reply.result)
                                {
                                    late_reply(&sidecar, "shutdown", result);
                                }
                            }
                        }
                        continue;
                    }
                    match close_answer(&state, &sidecar, &line) {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(violation) => return Some(violation),
                    }
                    let event: Event = match serde_json::from_slice(&line) {
                        Ok(event) => event,
                        Err(error) => return Some(format!("invalid message: {error}")),
                    };
                    record_reply(&state, &sidecar, &event);
                    let owner = state
                        .lock()
                        // default: a lock that a panicking thread poisoned still holds the owner record, which is only
                        // read; the panic hook records the panic.
                        .unwrap_or_else(PoisonError::into_inner)
                        .owners
                        .get(&event.surface)
                        .cloned();
                    if let Some(owner) = owner {
                        let response_sender = ReadThreadResponseSender {
                            sidecar_name: sidecar.clone(),
                            tx: tx_clone.clone(),
                            state: Arc::clone(&state),
                        };
                        if try_handle_image_envelope(
                            &owner,
                            &sidecar,
                            &event.surface,
                            &event.body,
                            &response_sender,
                        ) {
                            continue;
                        }
                        trace_message("sidecar.receive", &sidecar, &event.surface, &event.body);
                        owner.deliver(Message {
                            sidecar: sidecar.clone(),
                            surface: event.surface,
                            body: event.body,
                        });
                    } else {
                        let response_sender = ReadThreadResponseSender {
                            sidecar_name: sidecar.clone(),
                            tx: tx_clone.clone(),
                            state: Arc::clone(&state),
                        };
                        drop_message(&response_sender, &sidecar, &event.surface, &event.body);
                    }
                }
            })();
            let mut was_current = false;
            let stopping;
            let stop;
            let mut owned = Vec::new();
            let mut changed = None;
            let mut stopped_requests = Vec::new();
            {
                // default: a lock that a panicking thread poisoned still holds the state of the sidecars, which the disconnect updates in
                // full; the panic hook records the panic.
                let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
                stopping = state.stopped;
                if stopping {
                    stopped_requests = state.requests.failed(&sidecar);
                }
                // A connection that ends for a protocol violation while the host is not stopping is a failure of the
                // service, which the restart limit counts here; the service keeps running
                // (docs/spec/terminal-runtime.md#service-transport).
                stop = violation.is_some() && !stopping && count_failure(&mut state, &sidecar);
                let is_current = state
                    .running
                    .get(&sidecar)
                    .and_then(|process| process.persistent.as_ref())
                    .is_some_and(|connection| {
                        Arc::ptr_eq(&connection.connected, &reader_connected)
                    });
                if is_current {
                    if let Some(process) = state.running.remove(&sidecar)
                        && violation.is_some()
                    {
                        owned = process
                            .surfaces
                            .iter()
                            .filter_map(|surface| {
                                state
                                    .owners
                                    .get(surface)
                                    .map(|owner| (surface.clone(), owner.clone()))
                            })
                            .collect();
                    }
                    state.unannounced_loss.insert(sidecar.clone());
                    changed = forget_closing(&mut state, &sidecar);
                    was_current = true;
                } else if state.stopped {
                    // This connection was removed from the running list by stop. A close that was not answered is
                    // finished by the service itself.
                    changed = forget_closing(&mut state, &sidecar);
                }
            }
            if let Some(changed) = changed {
                changed();
            }
            record_stopped_requests(&sidecar, stopped_requests);
            crate::event_record::emit_host(
                crate::event_log::Level::Info,
                "host.sidecar.disconnect",
                serde_json::json!({"name": sidecar, "pid": reader_service_pid, "stopping": stopping,
                    // default: a disconnect without a violation records an empty violation text.
                    "violation": violation.clone().unwrap_or_default()}),
            );
            crate::performance::process_remove(reader_service_pid);
            let close_error =
                Err("persistent service disconnected before close-owner ack".to_string());
            let error = Err("persistent service disconnected before shutdown ack".to_string());
            // The flag is cleared under both waiter locks: a request registers its waiter under one of these locks only
            // while the flag is set, so every registered waiter is failed here.
            let mut close_waiters = waiters
                .lock()
                // default: a lock that a panicking thread poisoned still holds the waiters of the close-owner replies,
                // which the reader amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            let mut shutdown_waiters = shutdown_waiters_for_reader
                .lock()
                // default: a lock that a panicking thread poisoned still holds the waiters of the shutdown replies,
                // which the reader amends; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            reader_connected.store(false, Ordering::Release);
            for (_, sender) in close_waiters.drain() {
                if sender.send(close_error.clone()).is_err() {
                    crate::application_log::log_info(
                        &format!("sidecar {sidecar}"),
                        "the close-owner failure arrived after its request ended",
                    );
                }
            }
            for (_, sender) in shutdown_waiters.drain() {
                if sender.send(error.clone()).is_err() {
                    crate::application_log::log_info(
                        &format!("sidecar {sidecar}"),
                        "the shutdown failure arrived after its request ended",
                    );
                }
            }
            if let Some(reason) = violation {
                // The service violated the protocol. The same message would end the next connection too, so it does not
                // connect again at once, and the next send connects again through the creation path
                // (docs/spec/terminal-runtime.md#service-transport).
                log_error(&format!("sidecar {sidecar}"), format!("failed: {reason}"));
                if stop {
                    report_restart_limit(&sidecar);
                }
                fail_requests(&state, &sidecar, &reason);
                for (surface, owner) in owned {
                    owner.deliver_failure(Failure {
                        sidecar: sidecar.clone(),
                        surface,
                        reason: reason.clone(),
                    });
                }
                return;
            }
            // The connection was lost. It connects again at once without waiting for the next send: if the service is
            // alive it attaches again, and if it died the cleanup of the stale endpoint in start_persistent spawns it
            // again (V5-106).
            if was_current {
                fail_requests(&state, &sidecar, "connection lost");
                revive_persistent(&reader_core, &sidecar);
            }
        }));
        crate::event_record::emit_host(
            crate::event_log::Level::Info,
            "host.sidecar.connect",
            serde_json::json!({"name": name, "pid": endpoint.pid, "spawned": child.is_some()}),
        );
        crate::performance::process_add("sidecar", name, endpoint.pid);
        // The termination of the application must not wait for the bootstrap child or kill it.
        drop(child);
        Ok(Started {
            process: Process {
                child: None,
                outbox: tx,
                writing,
                surfaces: HashSet::new(),
                persistent: Some(PersistentConnection {
                    version,
                    close_waiters,
                    retain_waiters,
                    shutdown_waiters,
                    owner_closed: Arc::new(Mutex::new(false)),
                    connected,
                    service_pid: endpoint.pid,
                }),
            },
            threads,
        })
    }
}

/// Waits until the process of the service that `replace` closed has ended, so the installed service starts after it
/// (docs/spec/terminal-runtime.md#updates). A process that does not end within the stop timeout fails the replacement:
/// the error line names the sidecar, and the reconnection that follows reaches the service that still runs, so the
/// sidecar stays outdated.
fn await_replaced_service<O: Owner>(core: &Arc<Core<O>>, name: &str) {
    let replaced = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the panic
        // hook records the panic.
        let state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
        state
            .replacing
            .get(name)
            .map(|replaced| (replaced.pid, replaced.timeout))
    };
    let Some((pid, timeout)) = replaced else {
        return;
    };
    let failure =
        match current().and_then(|platform| platform.wait_service_process_end(pid, timeout)) {
            Ok(true) => return,
            Ok(false) => format!("the service process {pid} did not end within {timeout:?}"),
            Err(error) => error,
        };
    log_error(&format!("sidecar {name}"), format!("replace: {failure}"));
    core.state
        .lock()
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .replacing
        .remove(name);
}

/// Connects a lost persistent connection again and notifies the owning surfaces of the result (V5-106). It does nothing
/// when another path already started it again or the channel is terminating. It tries once for one connection loss: a
/// failure is reported as a notification, and the next send passes through the same path again. However, the first
/// attempt in which the connection is refused is evidence that the endpoint no longer listens (the socket is dead even
/// when a recycled pid passes kill(pid, 0)). Only in a restart that has a connection loss record, it discards the
/// endpoint and tries once more. The contract of the send path is unchanged: the live-unreachable report of a cold send
/// does not replace the endpoint.
fn revive_persistent<O: Owner>(core: &Arc<Core<O>>, name: &str) {
    await_replaced_service(core, name);
    // One disconnect counts at most one failure of the restart limit, whichever attempt below finds it.
    let lost = Revival::default();
    let mut outcome = revive_attempt(core, name, &lost);
    if let Err(reason) = &outcome
        && refused_connect(reason, name)
    {
        let program = core.declaration(name).map(|(program, _)| program);
        let endpoint = program
            .as_deref()
            .and_then(|program| program.file_name())
            .and_then(|value| value.to_str())
            .map(|basename| {
                core.config_directory
                    .join("services")
                    .join(basename)
                    .join("endpoint.json")
            });
        if let Some(endpoint) = endpoint
            && let Err(error) = std::fs::remove_file(&endpoint)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            log_error(
                &format!("sidecar {name}"),
                format!("remove refused endpoint: {error}"),
            );
        }
        outcome = revive_attempt(core, name, &lost);
    }
    let (replaced, stopped) = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the
        // panic hook records the panic.
        let mut state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
        (state.replacing.remove(name), restart_stopped(&state, name))
    };
    // While the restart limit stops the sidecar, no revival runs and no connection notice is written.
    if stopped && matches!(outcome, Ok(false)) {
        return;
    }
    match (&outcome, replaced) {
        (Ok(true), Some(replaced)) => {
            // The replacement closed the connection on purpose and the installed service started: an expected state.
            let running = replaced.running.as_deref().unwrap_or("none"); // default: a service that sent no version has none to name
            crate::application_log::log_info(
                &format!("sidecar {name}"),
                format!("service {running} replaced by {}", replaced.installed),
            );
            let changed = core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read;
                // the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .closing_changed
                .clone();
            if let Some(changed) = changed {
                changed();
            }
        }
        _ => {
            if let Some((place, text)) = connection_loss_report(name, &outcome) {
                log_error(&place, text);
            }
        }
    }
    notify_connection(core, name, outcome.map(|_| ()));
}

/// The error line of a lost connection to a persistent service: the place and the text, or `None` when another path
/// had already reconnected and wrote it (docs/spec/diagnostics.md).
pub fn connection_loss_report(
    name: &str,
    outcome: &Result<bool, String>,
) -> Option<(String, String)> {
    let place = format!("sidecar {name}");
    match outcome {
        Ok(true) => Some((place, "connection lost; restarted".to_string())),
        Ok(false) => None,
        Err(reason) => Some((place, format!("connection lost; restart failed: {reason}"))),
    }
}

/// One restart of the disconnect lost. It is Ok(false) when another path already started it again or the restart limit
/// stops the sidecar, and Err when the start failed.
fn revive_attempt<O: Owner>(
    core: &Arc<Core<O>>,
    name: &str,
    lost: &Revival,
) -> Result<bool, String> {
    // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the panic
    // hook records the panic.
    let state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
    if state.stopped || state.running.contains_key(name) || restart_stopped(&state, name) {
        return Ok(false);
    }
    let (mut state, started) = Core::ensure(core, state, name, Some(lost))?;
    Ok(started && state.unannounced_loss.remove(name))
}

/// Whether it is the connection failure text of start_persistent. The text is built from the connect_service error of
/// this file.
fn refused_connect(reason: &str, name: &str) -> bool {
    reason.starts_with(&format!("sidecar {name}: connect authenticated service:"))
}

/// Notifies the owning surfaces of a persistent connection that was established again (V5-106). The window sends the
/// image configure of that sidecar again ([Owner::sidecar_reconnected]), and the surface receives the connection event
/// and opens its session again. If the start failed, it announces the connection loss and its reason.
fn notify_connection<O: Owner>(core: &Arc<Core<O>>, name: &str, outcome: Result<(), String>) {
    let surfaces: Vec<(String, O)> = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the panic
        // hook records the panic.
        let state = core.state.lock().unwrap_or_else(PoisonError::into_inner);
        state
            .owners
            .iter()
            .map(|(surface, owner)| (surface.clone(), owner.clone()))
            .collect()
    };
    let body = match connection_notice(&outcome) {
        Ok(body) => body,
        Err(error) => {
            log_error(
                &format!("sidecar {name}"),
                format!("connection notice serialization: {error}"),
            );
            return;
        }
    };
    let mut reconfigured: Vec<String> = Vec::new();
    for (surface, owner) in surfaces {
        if outcome.is_ok() && !reconfigured.contains(&owner.key()) {
            reconfigured.push(owner.key());
            owner.sidecar_reconnected(name);
        }
        owner.deliver(Message {
            sidecar: name.to_string(),
            surface,
            body: body.clone(),
        });
    }
}

/// The sidecar-message body of a persistent connection: connected, or not connected with the reason of the failure.
fn connection_notice(outcome: &Result<(), String>) -> Result<Box<RawValue>, serde_json::Error> {
    let value = match outcome {
        Ok(()) => serde_json::json!({"event": "connection", "connected": true}),
        Err(reason) => {
            serde_json::json!({"event": "connection", "connected": false, "reason": reason})
        }
    };
    RawValue::from_string(value.to_string())
}

/// One answer of a persistent connection (closed-owner, shutdown, retained).
struct Reply {
    request: String,
    result: Result<(), String>,
    closed: usize,
}

/// Checks the field types of an answer. If a type is wrong, it returns the reason to end the connection.
/// (docs/spec/terminal-runtime.md#service-transport).
fn reply_of(
    operation: &str,
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<Reply, String> {
    let request = match object.get("request") {
        Some(serde_json::Value::String(request)) if !request.is_empty() => request.clone(),
        _ => {
            return Err(format!(
                "invalid message: {operation} request is not a non-empty string"
            ));
        }
    };
    let ok = match object.get("ok") {
        Some(serde_json::Value::Bool(ok)) => *ok,
        _ => return Err(format!("invalid message: {operation} ok is not a boolean")),
    };
    let reason = match object.get("error") {
        None => None,
        Some(serde_json::Value::String(reason)) => Some(reason.clone()),
        Some(_) => {
            return Err(format!(
                "invalid message: {operation} error is not a string"
            ));
        }
    };
    let closed = if operation == "retained" && ok {
        match object.get("closed").and_then(serde_json::Value::as_u64) {
            Some(closed) => closed as usize,
            None => return Err("invalid message: retained closed is not a count".to_string()),
        }
    } else {
        0
    };
    let result = if ok {
        Ok(())
    } else {
        // default: when the service error has no text, the same failure is reported with the name of the operation.
        Err(reason.unwrap_or_else(|| format!("{operation} failed")))
    };
    Ok(Reply {
        request,
        result,
        closed,
    })
}

/// Passes the messages of the standard output to the owning window. It returns None when the output ends, and the
/// reason when the protocol is violated or the read fails. A line that exceeds MESSAGE_LIMIT bytes before its line feed
/// is not buffered any further and fails (docs/spec/sidecars.md#failure).
fn relay<O: Owner>(
    reader: &mut impl BufRead,
    state: &Arc<Mutex<State<O>>>,
    sidecar: &str,
    tx: &SyncSender<Outgoing>,
    ready: &mut Option<ReadyClock>,
) -> Option<String> {
    let mut line = Vec::new();
    loop {
        match read_message_line(reader, MESSAGE_LIMIT, &mut line) {
            Ok(MessageLine::Complete) => {}
            Ok(MessageLine::End) => return None,
            Ok(MessageLine::Unfinished(bytes)) => {
                log_unfinished_line(sidecar, bytes);
                return None;
            }
            Ok(MessageLine::TooLong) => {
                return Some(format!("message exceeds {MESSAGE_LIMIT} bytes"));
            }
            Err(error) => return Some(format!("read: {error}")),
        }
        record_ready(ready, sidecar);
        match close_answer(state, sidecar, &line) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(violation) => return Some(violation),
        }
        let event: Event = match serde_json::from_slice(&line) {
            Ok(event) => event,
            Err(error) => return Some(format!("invalid message: {error}")),
        };
        record_reply(state, sidecar, &event);
        let (owner, addressed) = {
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the
            // panic hook records the panic.
            let state = state.lock().unwrap_or_else(PoisonError::into_inner);
            let addressed = state
                .running
                .get(sidecar)
                .is_some_and(|process| process.surfaces.contains(&event.surface))
                || state
                    .stopping
                    .get(sidecar)
                    .is_some_and(|stopping| stopping.surfaces.contains(&event.surface));
            (state.owners.get(&event.surface).cloned(), addressed)
        };
        // A message for a surface that was never sent to this process is a protocol violation. A surface that was sent
        // to and has no owning window sent its message after it closed, so the message is discarded
        // (docs/spec/sidecars.md#messages).
        if !addressed {
            return Some(format!("unknown surface {}", event.surface));
        }
        let response_sender = ReadThreadResponseSender {
            sidecar_name: sidecar.to_string(),
            tx: tx.clone(),
            state: Arc::clone(state),
        };
        let Some(owner) = owner else {
            drop_message(&response_sender, sidecar, &event.surface, &event.body);
            continue;
        };
        // Checks and handles whether it is an image envelope.
        if try_handle_image_envelope(
            &owner,
            sidecar,
            &event.surface,
            &event.body,
            &response_sender,
        ) {
            continue;
        }
        trace_message("sidecar.receive", sidecar, &event.surface, &event.body);
        owner.deliver(Message {
            sidecar: sidecar.to_string(),
            surface: event.surface,
            body: event.body,
        });
    }
}

/// The spawn of a process that the host started, with its pid. The first message line that the process sends after the spawn is
/// written as the event `host.trace.sidecar.ready` (docs/spec/host-contract.md#contract-cases).
struct ReadyClock {
    spawned: Instant,
    pid: u32,
}

/// Writes `host.trace.sidecar.ready` with the time from the spawn to the first message line of the process in milliseconds, once for each spawn.
/// A process that the host did not spawn has no clock, so it writes nothing.
fn record_ready(clock: &mut Option<ReadyClock>, sidecar: &str) {
    let Some(clock) = clock.take() else {
        return;
    };
    emit_host(
        Level::Debug,
        "host.trace.sidecar.ready",
        serde_json::json!({
            "sidecar": sidecar,
            "pid": clock.pid,
            "ms": clock.spawned.elapsed().as_secs_f64() * 1000.0,
        }),
    );
}

/// Writes a request that the host sends to a sidecar, or a message that it receives, as a trace event with its whole
/// body (docs/spec/diagnostics.md). It writes nothing while the performance trace is off.
fn trace_message(event: &str, sidecar: &str, surface: &str, body: &RawValue) {
    crate::performance::observe("host", || {
        serde_json::json!({
            "event": event,
            "sidecar": sidecar,
            "surface": surface,
            // A raw value holds valid JSON, so it always converts.
            "body": serde_json::to_value(body).expect("a raw JSON value converts to a value"),
        })
    });
}

/// Writes the end of an ended sidecar as `exit status <code>` or `signal <number>`
/// (docs/spec/sidecars.md#declaration-and-startup). If the end cannot be read, the reason is written in the same place.
fn exit_text(status: std::process::ExitStatus) -> String {
    match crate::platform::current().and_then(|platform| platform.exit_status(status)) {
        Ok(text) => text,
        Err(error) => format!("exit status unreadable: {error}"),
    }
}

/// The sliding window and the number of counted failures of the restart limit of a sidecar of either transport
/// (docs/spec/sidecars.md#failure).
pub(crate) const RESTART_WINDOW: Duration = Duration::from_secs(300);
pub(crate) const RESTART_LIMIT: usize = 4;

/// The restart-limit record of one sidecar. `failures` are the times of the counted failures, oldest first. When the
/// limit stops the restarts, `stopped` is true. The plugin hosts count their failures with the same record
/// (docs/spec/plugin-host.md#restarts).
#[derive(Default)]
pub(crate) struct RestartRecord {
    failures: Vec<Instant>,
    stopped: bool,
}

impl RestartRecord {
    /// Counts a failure at now among the failures within RESTART_WINDOW, which the record keeps. It returns true when
    /// this failure is the RESTART_LIMIT-th counted one, which stops the restarts.
    pub(crate) fn count(&mut self, now: Instant) -> bool {
        self.failures
            .retain(|at| now.duration_since(*at) <= RESTART_WINDOW);
        self.failures.push(now);
        if self.failures.len() < RESTART_LIMIT {
            return false;
        }
        self.stopped = true;
        true
    }

    /// Returns true when the limit stopped the restarts.
    pub(crate) fn stopped(&self) -> bool {
        self.stopped
    }
}

/// The reason of the connection notice of a persistent service whose restarts the restart limit stopped
/// (docs/spec/terminal-runtime.md#service-transport).
const RESTART_LIMIT_REASON: &str = "restart limit";

/// The revival of one lost persistent connection. `counted` is true once a failure of that disconnect is counted,
/// because one disconnect counts at most one failure (docs/spec/terminal-runtime.md#service-transport).
#[derive(Default)]
struct Revival {
    counted: std::cell::Cell<bool>,
}

/// Counts a failure of the sidecar at the time of the clock of the state, among the failures within RESTART_WINDOW. It
/// returns true when this failure is the RESTART_LIMIT-th counted one, which stops the restarts.
fn count_failure<O>(state: &mut State<O>, sidecar: &str) -> bool {
    let now = (state.clock)();
    state
        .restarts
        .entry(sidecar.to_string())
        .or_default()
        .count(now)
}

/// Writes the stop of the restarts of the sidecar by the restart limit to the log and as an event.
fn report_restart_limit(sidecar: &str) {
    log_error(
        &format!("sidecar {sidecar}"),
        format!(
            "restart limit: {RESTART_LIMIT} failures within {} s",
            RESTART_WINDOW.as_secs()
        ),
    );
    emit_host(
        Level::Error,
        "host.sidecar.restart-limit",
        serde_json::json!({"sidecar": sidecar}),
    );
}

/// Counts a failure of the persistent service while the host is neither stopping its sidecars nor replacing the
/// sidecar, and reports the stop when it is the RESTART_LIMIT-th one. lost is the revival of the disconnect that the
/// failure belongs to, None for a start that a send or a retain runs; a disconnect whose failure is already counted
/// counts nothing more. It returns true when the restarts are stopped by this failure.
fn count_service_failure<O>(state: &mut State<O>, sidecar: &str, lost: Option<&Revival>) -> bool {
    if state.stopped
        || state.replacing.contains_key(sidecar)
        || lost.is_some_and(|lost| lost.counted.get())
    {
        return false;
    }
    if let Some(lost) = lost {
        lost.counted.set(true);
    }
    if !count_failure(state, sidecar) {
        return false;
    }
    report_restart_limit(sidecar);
    true
}

/// Whether the restart limit stops the restarts of the sidecar.
fn restart_stopped<O>(state: &State<O>, sidecar: &str) -> bool {
    state
        .restarts
        .get(sidecar)
        .is_some_and(|record| record.stopped)
}

/// Applies the restart limit to a request from surface to the sidecar, which has no running process, and returns true
/// when the sidecar is stopped: the request is refused and logged, whichever surface sent it. Only surface_opened clears
/// the stop.
fn restart_refused<O>(state: &mut State<O>, sidecar: &str, surface: &str) -> bool {
    let stopped = restart_stopped(state, sidecar);
    if stopped {
        log_error(
            &format!("sidecar {sidecar}"),
            format!("restart limit: request for {surface} refused"),
        );
    }
    stopped
}

/// Handles a standard-I/O sidecar whose output ended or whose protocol was violated. While terminating, stop waits for
/// the process. Otherwise it removes the process from the running sidecars, ends it, and reports the failure to the
/// owning window of each surface that sent to that process. The protocol state after a failure is undefined, so the
/// process is ended.
fn fail<O: Owner>(
    state: &Arc<Mutex<State<O>>>,
    sidecar: &str,
    pid: u32,
    violation: Option<String>,
) {
    let (process, owned, changed, stop) = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the
        // panic hook records the panic.
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        // A declaration change can stop this process and start a new one of the same name, so the pid tells whether
        // the running process is the process of this reader; otherwise this process is stopping.
        let current = state
            .running
            .get(sidecar)
            .and_then(|process| process.child.as_ref())
            .map(|child| child.id());
        if state.stopped || current != Some(pid) {
            // It is stopping. The violation is written to the log and no failure event is sent. stop decides the report
            // of the end. The requests that wait for a reply are recorded after the lock is released.
            let stopped_requests = state.requests.failed(sidecar);
            if let Some(violation) = violation {
                if let Some(stopping) = state.stopping.get_mut(sidecar) {
                    stopping.violated = true;
                }
                log_error(
                    &format!("sidecar {sidecar}"),
                    format!("failed: {violation}"),
                );
            }
            drop(state);
            record_stopped_requests(sidecar, stopped_requests);
            return;
        }
        let process = state.running.remove(sidecar).expect("checked by pid above");
        let changed = forget_closing(&mut state, sidecar);
        let stop = count_failure(&mut state, sidecar);
        let owned: Vec<(String, O)> = process
            .surfaces
            .iter()
            .filter_map(|surface| {
                state
                    .owners
                    .get(surface)
                    .map(|owner| (surface.clone(), owner.clone()))
            })
            .collect();
        (process, owned, changed, stop)
    };
    if let Some(changed) = changed {
        changed();
    }
    let Process { child, outbox, .. } = process;
    let mut failures = Vec::new();
    let exit = match child {
        Some(mut child) => {
            if let Err(error) = child.kill() {
                failures.push(format!("kill: {error}"));
            }
            match child.wait() {
                Ok(status) => exit_text(status),
                Err(error) => {
                    failures.push(format!("wait: {error}"));
                    "unknown exit status".to_string()
                }
            }
        }
        None => "no child process".to_string(),
    };
    crate::event_record::emit_host(
        crate::event_log::Level::Info,
        "host.sidecar.exit",
        serde_json::json!({"name": sidecar, "pid": pid, "status": exit, "stopping": false}),
    );
    crate::performance::process_remove(pid);
    // The write thread writes the held items and ends when all senders are gone.
    drop(outbox);
    // default: when there is no protocol violation, the end of the output is the cause of the failure
    // (docs/spec/sidecars.md#failure).
    let mut reason = violation.unwrap_or_else(|| format!("output closed: {exit}"));
    for failure in failures {
        reason = format!("{reason}; {failure}");
    }
    log_error(&format!("sidecar {sidecar}"), format!("failed: {reason}"));
    if stop {
        report_restart_limit(sidecar);
    }
    fail_requests(state, sidecar, &reason);
    for (surface, owner) in owned {
        owner.deliver_failure(Failure {
            sidecar: sidecar.to_string(),
            surface,
            reason: reason.clone(),
        });
    }
}

/// Stores `host.sidecar.reply` for a message of the sidecar when it names the correlation identifiers of requests or its body
/// states an error (sidecar_reply.rs).
fn record_reply<O>(state: &Arc<Mutex<State<O>>>, sidecar: &str, event: &Event) {
    let failure = error_of_body(event.body.get());
    if event.cids.is_empty() && failure.is_none() {
        return;
    }
    let mut cids: &[String] = &event.cids;
    if let Some(bad) = cids.iter().find(|cid| !crate::event_log::valid_cid(cid)) {
        log_error(
            &format!("sidecar {sidecar}"),
            format!(
                "the cids of a reply of surface {} are refused: {bad:?} is empty or holds a quote, a backslash or a control character",
                event.surface
            ),
        );
        cids = &[];
    }
    let elapsed = state
        .lock()
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .requests
        .take(cids, crate::event_log::monotonic_ns());
    let mut fields = serde_json::json!({
        "name": sidecar, "surface": event.surface, "bytes": event.body.get().len(), "ok": failure.is_none(),
    });
    if let Some(elapsed) = elapsed {
        fields["micros"] = (elapsed / 1000).into();
    }
    let mut level = crate::event_log::Level::Info;
    if let Some(failure) = failure {
        level = crate::event_log::Level::Warn;
        let (text, _) = crate::bounds::cut_text(
            &format!("{INTERNAL_CODE}: {failure}"),
            crate::bounds::CALL_TEXT_BYTES,
        );
        fields["error"] = text.into();
    }
    if cids.is_empty() {
        crate::event_record::emit_host(level, "host.sidecar.reply", fields);
    } else {
        crate::event_record::emit_host_cids(level, "host.sidecar.reply", cids, fields);
    }
}

/// Stores `host.sidecar.reply` as a failure for each surface of the sidecar that has requests waiting, with their identifiers and
/// the reason that the failure of the sidecar gives the page.
fn fail_requests<O>(state: &Arc<Mutex<State<O>>>, sidecar: &str, reason: &str) {
    let surfaces = state
        .lock()
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .requests
        .failed(sidecar);
    record_request_failures(sidecar, reason, surfaces);
}

/// Stores `host.sidecar.reply` as an error for each surface in surfaces, with the identifiers of its requests and the reason.
pub(crate) fn record_request_failures(
    sidecar: &str,
    reason: &str,
    surfaces: Vec<(String, Vec<String>)>,
) {
    let (text, _) = crate::bounds::cut_text(
        &format!("{INTERNAL_CODE}: {reason}"),
        crate::bounds::CALL_TEXT_BYTES,
    );
    for (surface, cids) in surfaces {
        crate::event_record::emit_host_cids(
            crate::event_log::Level::Warn,
            "host.sidecar.reply",
            &cids,
            serde_json::json!({"name": sidecar, "surface": surface, "bytes": 0, "ok": false, "error": text}),
        );
    }
}

/// Checks whether the event is an image envelope and handles it. It returns true for an envelope.
fn try_handle_image_envelope<O: Owner>(
    owner: &O,
    sidecar_name: &str,
    surface: &str,
    body: &RawValue,
    response_sender: &dyn ResponseSender,
) -> bool {
    // Checks whether it is an image envelope and requests the decision.
    owner.decide_image_envelope(sidecar_name, surface, body, response_sender)
}

/// The window used by the sidecar channel. It is distinguished by the window label and uses the project directory of
/// the window as root.
pub(crate) type WindowSidecars = Sidecars<Window>;

/// Returns the performance trace event of an answer to a frame of the surface: the image name and the answer as the
/// sidecar receives it, whether the frame was consumed or refused.
pub fn frame_answer_event(
    surface: &str,
    image: &str,
    response: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "event": "image.frame",
        "surface": surface,
        "name": image,
        "response": response,
    })
}

impl Owner for Window {
    fn key(&self) -> String {
        self.label().to_string()
    }
    fn root(&self) -> Result<String, String> {
        let context = window_data(self)?;
        let root = context
            .root
            .lock()
            // default: a lock that a panicking thread poisoned still holds the root of the window, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        Ok(root)
    }
    fn sidecar_reconnected(&self, sidecar: &str) {
        if let Err(error) = crate::composition::refresh_sidecar_rasters(self, sidecar) {
            log_error(
                &format!("sidecar {sidecar} reconnection reconfigure"),
                error,
            );
        }
    }
    fn deliver(&self, message: Message) {
        if let Err(error) = emit_window(self, "sidecar-message", message) {
            log_error("sidecar-message", error);
        }
    }
    fn deliver_failure(&self, failure: Failure) {
        if let Err(error) = emit_window(self, "sidecar-failure", failure) {
            log_error("sidecar-failure", error);
        }
    }
    fn decide_image_envelope(
        &self,
        sidecar_name: &str,
        surface: &str,
        body: &RawValue,
        response_sender: &dyn ResponseSender,
    ) -> bool {
        let data = match window_data(self) {
            Ok(data) => data,
            Err(e) => {
                log_error(
                    &format!("sidecar {sidecar_name}"),
                    format!("image envelope for {surface}: {e}"),
                );
                return false;
            }
        };
        let window = self.clone();
        crate::images::handle_envelope_with_recovery(
            body.get(),
            sidecar_name,
            surface,
            &data.images,
            |work: Box<dyn Fn() -> Result<(), String> + Send>| {
                crate::exposure::on_main(&window, work)
            },
            |image, response| {
                // Every answer to a frame, consumed or refused with its reason, is an image.frame event of the
                // performance trace, so a frame that the host does not present is visible in the timeline
                // (docs/spec/performance-trace.md).
                crate::performance::observe("host", || {
                    frame_answer_event(surface, image, &response)
                });
                let text = serde_json::to_string(&response)
                    .map_err(|e| ResponseError::Failed(e.to_string()))?;
                let body = RawValue::from_string(text)
                    .map_err(|e| ResponseError::Failed(e.to_string()))?;
                response_sender.send(surface, image, &body)
            },
            |reason| {
                if reason != "notFound" {
                    return Ok(());
                }
                crate::composition::refresh_image_rasters(&window)
            },
            || tauri::Manager::state::<WindowSidecars>(self).declared(sidecar_name),
        )
    }
}

/// Writes each line of the standard error of the sidecar `name` as a record of level `info`, layer `sidecar` and `name`
/// as the place. Bytes that are not UTF-8 are written as the replacement character, because a record is text. The
/// thread ends when the sidecar closes its standard error.
fn write_stderr_records(stderr: std::process::ChildStderr, name: &str) {
    use std::io::{BufRead, BufReader};
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => return,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim_end_matches(['\n', '\r']);
                crate::application_log::log_record("info", "sidecar", name, text);
            }
            Err(error) => {
                crate::application_log::log_error(
                    &format!("sidecar {name}"),
                    format!("standard error: {error}"),
                );
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "sidecars_lock_test.rs"]
mod lock_test;
