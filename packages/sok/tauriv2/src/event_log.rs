//! The event writer of the hosts and of the tool (docs/spec/logging.md#writers).
//!
//! A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer thread assigns `seq`,
//! serializes the JSON line, writes batches, rotates the file when it has a bound, and records the events that the queue
//! refused as `log.dropped`. The hosts and the tool start this writer with their own layer, role, clock and thread
//! entrance; a process with a source of events that cannot call into the writer (the native ring of a host) gives the
//! writer a `Pull`.

use std::borrow::Cow;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use serde_json::value::{to_raw_value, RawValue};

use crate::event_bounds::{cut_text, Fields, EVENT_FIELDS_LIMIT_BYTES, EVENT_HEAD_BYTES};

/// The schema number of the lines that this writer writes. Schema 2 adds `mono_ns` to every line.
pub const SCHEMA: u64 = 2;

/// The level of an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
            Level::Trace => "trace",
        }
    }
}

/// Starts the thread of the writer through the entrance of the process, which recovers a panic.
pub type Spawn = fn(Box<dyn FnOnce() + Send>) -> Result<JoinHandle<()>, String>;

/// What the writer passes to a `Pull`: it takes the events of the source and the losses of the source.
pub trait PullSink {
    /// Stores an event of the source as it is.
    fn accept(&mut self, event: RelayedEvent);
    /// Stores one `log.dropped` for `events` events of `bytes` bytes that the source lost, with the reason.
    fn lost(&mut self, events: u64, bytes: u64, reason: &str);
}

/// Takes the events of a source that cannot call into the writer. It runs on the thread of the writer at the batch interval
/// and when the writer flushes.
pub type Pull = Box<dyn FnMut(&mut dyn PullSink) + Send>;

/// How a writer is started.
pub struct Options {
    /// The `logs` folder.
    pub directory: PathBuf,
    /// The role of the process (`host`, `sok`).
    pub role: String,
    /// The identifier of this run.
    pub boot: String,
    /// The layer of the events that the writer and the process itself produce (`host`, `sok`).
    pub layer: &'static str,
    /// Reads the monotonic clock of the records (docs/spec/logging.md#event). A clock that cannot be read is reported by the
    /// clock itself and returns 0, which the audit of the contract refuses.
    pub clock: fn() -> u64,
    /// Starts the thread of the writer.
    pub spawn: Spawn,
    /// The bound of the queue in events.
    pub queue_events: usize,
    /// The bound of the queue in bytes of serialized fields.
    pub queue_bytes: usize,
    /// How long the writer waits for more events before it writes a batch.
    pub batch_interval: Duration,
    /// The size at which the writer starts a new file; the file that was full becomes generation 1. It is 0 for a writer that
    /// does not rotate, which then has no `generations`.
    pub rotate_bytes: u64,
    /// The number of earlier files that are kept (`.1` is the newest); the oldest one is removed.
    pub generations: usize,
    /// The source of events that cannot call into the writer; `None` when the process has none.
    pub pull: Option<Pull>,
}

/// One event waiting for the writer. `seq` is assigned when the writer serializes it.
struct Pending {
    ts_us: u64,
    /// The monotonic clock in nanoseconds (docs/spec/logging.md#event).
    mono_ns: u64,
    /// The correlation identifiers of the inputs the event belongs to; none for most events.
    cids: Vec<String>,
    layer: Cow<'static, str>,
    level: Level,
    event: String,
    /// The fields as JSON text, serialized once by the producer.
    fields: Box<RawValue>,
    bytes: usize,
    /// The size in bytes of the fields text before it was cut to its head, or `None` for an event that was not cut.
    truncated: Option<usize>,
    /// When set, receives the `seq` of the line once the writer gave it one.
    placed: Option<SyncSender<u64>>,
}

/// What the queue carries: an event, or a request of the owner. Two slots of the queue are reserved for requests, so a
/// flush or a stop is never refused because events filled the queue.
enum Message {
    Event(Pending),
    /// Write everything that is queued, then answer.
    Flush(SyncSender<()>),
    /// Write everything that is queued, then end.
    Stop,
}

/// The slots of the queue that only requests use.
const RESERVED_FOR_REQUESTS: usize = 2;

/// The loss that the queue counted since the writer last recorded it.
struct Loss {
    events: AtomicU64,
    bytes: AtomicU64,
}

/// The observer that the writer calls after it wrote a batch, with the path of the file and its size.
type WriteObserver = Box<dyn Fn(&Path, u64) + Send + Sync>;

/// The writer of one process.
pub struct EventLog {
    on_write: Arc<Mutex<Option<WriteObserver>>>,
    sender: SyncSender<Message>,
    queued_events: Arc<AtomicUsize>,
    queue_events: usize,
    queued_bytes: Arc<AtomicUsize>,
    queue_bytes: usize,
    loss: Arc<Loss>,
    path: PathBuf,
    boot: String,
    layer: &'static str,
    clock: fn() -> u64,
    writer: Mutex<Option<JoinHandle<()>>>,
}

/// The layers of the event contract that another layer of a process relays (docs/spec/logging.md#event).
const LAYERS: [&str; 5] = ["native", "host", "page", "plugin", "sidecar"];

/// Whether `cid` can be stored as a correlation identifier: it is not empty and holds no quote, no backslash and no
/// control character, so it is written as the text of a JSON string without escaping.
pub fn valid_cid(cid: &str) -> bool {
    !cid.is_empty()
        && cid
            .chars()
            .all(|c| c != '"' && c != '\\' && !c.is_control())
}

/// An event that another layer of this process produced, with the time, the monotonic clock, the layer and the
/// correlation identifiers it carries.
pub struct RelayedEvent {
    pub ts_us: u64,
    pub mono_ns: u64,
    pub layer: String,
    pub level: Level,
    pub event: String,
    pub cids: Vec<String>,
    /// The fields as the producer serialized them, up to the bound (docs/spec/logging.md#bounds).
    pub fields: Fields,
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is before the Unix epoch")
        .as_micros() as u64
}

impl EventLog {
    /// Sets the observer that the writer calls after it wrote a batch, with the path of the file and its size. It runs on the
    /// thread of the writer, so it must not wait.
    pub fn set_on_write(&self, observer: WriteObserver) {
        *self.on_write.lock().expect("the observer of the writes") = Some(observer);
    }

    /// Creates the folder (mode 0700) and the file (mode 0600, created new), writes `log.open` and starts the writer thread.
    pub fn start(options: Options) -> Result<EventLog, String> {
        if (options.rotate_bytes == 0) != (options.generations == 0) {
            return Err(format!(
                "event writer: rotate_bytes {} and generations {} must both be positive, or both be 0 for a writer that does not rotate",
                options.rotate_bytes, options.generations
            ));
        }
        let reason = |path: &Path, error: std::io::Error| {
            format!("{}: {}", path.display(), crate::files::os_reason(&error))
        };
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&options.directory)
            .map_err(|e| reason(&options.directory, e))?;
        // A folder that existed before keeps its mode; the log folder of the contract is private.
        std::fs::set_permissions(&options.directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| reason(&options.directory, e))?;
        let path = options
            .directory
            .join(format!("{}-{}.jsonl", options.role, options.boot));
        // The standard library opens the file close-on-exec, so a child process does not inherit it.
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| reason(&path, e))?;
        let on_write: Arc<Mutex<Option<WriteObserver>>> = Arc::new(Mutex::new(None));
        let (sender, receiver) = sync_channel(options.queue_events + RESERVED_FOR_REQUESTS);
        let queued_events = Arc::new(AtomicUsize::new(0));
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let loss = Arc::new(Loss {
            events: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        });
        let open = Pending {
            ts_us: now_us(),
            mono_ns: (options.clock)(),
            cids: Vec::new(),
            layer: Cow::Borrowed(options.layer),
            level: Level::Info,
            event: "log.open".into(),
            fields: to_raw_value(&json!({
                "schema": SCHEMA,
                "pid": std::process::id(),
                "role": options.role,
                "boot": options.boot,
            }))
            .map_err(|e| format!("log.open: {e}"))?,
            bytes: 0,
            truncated: None,
            placed: None,
        };
        let writer = {
            let queued_bytes = Arc::clone(&queued_bytes);
            let queued_events = Arc::clone(&queued_events);
            let loss = Arc::clone(&loss);
            let interval = options.batch_interval;
            let path_for_writer = path.clone();
            let observer = Arc::clone(&on_write);
            let rotate_bytes = options.rotate_bytes;
            let generations = options.generations;
            let layer = options.layer;
            let clock = options.clock;
            let pull = options.pull;
            (options.spawn)(Box::new(move || {
                write_loop(
                    Output::new(
                        file,
                        path_for_writer,
                        rotate_bytes,
                        generations,
                        layer,
                        clock,
                        &open,
                        observer,
                    ),
                    receiver,
                    queued_bytes,
                    queued_events,
                    loss,
                    interval,
                    open,
                    pull,
                )
            }))?
        };
        Ok(EventLog {
            on_write,
            sender,
            queued_events,
            queue_events: options.queue_events,
            queued_bytes,
            queue_bytes: options.queue_bytes,
            loss,
            path,
            boot: options.boot,
            layer: options.layer,
            clock: options.clock,
            writer: Mutex::new(Some(writer)),
        })
    }

    /// The file this writer writes.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The identifier of the run that this writer belongs to; with a `seq` it names a line of the log.
    pub fn boot(&self) -> &str {
        &self.boot
    }

    /// Queues an event of the layer of the writer, waits until it is on disk, at most `deadline`, and returns its `seq`. The
    /// queue refusing the event is an error, so a caller that stores the position never stores one of a line that does not
    /// exist.
    pub fn emit_placed(
        &self,
        level: Level,
        event: &str,
        fields: Box<RawValue>,
        deadline: Duration,
    ) -> Result<u64, String> {
        self.emit_placed_fields(level, event, Fields::whole(fields), deadline)
    }

    /// Like `emit_placed` for fields that a producer serialized up to the bound.
    pub fn emit_placed_fields(
        &self,
        level: Level,
        event: &str,
        fields: Fields,
        deadline: Duration,
    ) -> Result<u64, String> {
        let (placed, receiver) = sync_channel(1);
        if !self.enqueue(
            now_us(),
            (self.clock)(),
            Vec::new(),
            Cow::Borrowed(self.layer),
            level,
            event,
            fields,
            Some(placed),
        ) {
            return Err(format!(
                "the event writer refused {event} because its queue was full"
            ));
        }
        self.flush(deadline)?;
        receiver
            .try_recv()
            .map_err(|_| format!("the event writer could not write {event}"))
    }

    /// Queues an event of the layer of the writer. Returns false, and counts the loss, when the queue has no room. It never
    /// waits. The fields are serialized once, and only after the queue is known to have room for another event.
    pub fn emit<T: Serialize>(&self, level: Level, event: &str, fields: &T) -> bool {
        self.emit_cids(level, event, &[], fields)
    }

    /// Queues an event like `emit` with the correlation identifiers of the inputs it belongs to. An identifier that is
    /// not valid is a defect of the caller: it is reported on the standard error, the event is counted as lost and the
    /// result is false.
    pub fn emit_cids<T: Serialize>(
        &self,
        level: Level,
        event: &str,
        cids: &[String],
        fields: &T,
    ) -> bool {
        if let Some(bad) = cids.iter().find(|cid| !valid_cid(cid)) {
            self.count_loss(1, event.len() as u64);
            eprintln!("event writer: {event} has the correlation identifier {bad:?}, which is empty or holds a quote, a backslash or a control character");
            return false;
        }
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(1, event.len() as u64);
            return false;
        }
        let fields = match Fields::of(fields) {
            Ok(fields) => fields,
            Err(error) => {
                // A value that cannot be serialized is a defect of the caller: it is recorded in place of the event.
                self.count_loss(1, event.len() as u64);
                eprintln!("event writer: the fields of {event} cannot be serialized: {error}");
                return false;
            }
        };
        self.enqueue(
            now_us(),
            (self.clock)(),
            cids.to_vec(),
            Cow::Borrowed(self.layer),
            level,
            event,
            fields,
            None,
        )
    }

    /// Queues an event that another layer of this process produced, with the time and the layer it carries. The event
    /// name must start with the layer, so the name and the layer cannot disagree. Returns an error for a layer outside
    /// the contract or a name that does not start with it, and false, with the loss counted, when the queue has no room.
    pub fn emit_relayed(&self, relayed: RelayedEvent) -> Result<bool, String> {
        let RelayedEvent {
            ts_us,
            mono_ns,
            layer,
            level,
            event,
            cids,
            fields,
        } = relayed;
        let (layer, event) = (layer.as_str(), event.as_str());
        if mono_ns == 0 {
            return Err(format!("the mono_ns of {event} must be positive"));
        }
        if let Some(bad) = cids.iter().find(|cid| !valid_cid(cid)) {
            return Err(format!(
                "the cid {bad:?} of {event} is empty or holds a quote, a backslash or a control character"
            ));
        }
        if !LAYERS.contains(&layer) {
            return Err(format!(
                "the layer {layer:?} of {event} is not one of {LAYERS:?}"
            ));
        }
        if !event.starts_with(layer) || !event[layer.len()..].starts_with('.') {
            return Err(format!(
                "the event {event:?} does not start with its layer {layer:?}"
            ));
        }
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(1, event.len() as u64);
            return Ok(false);
        }
        Ok(self.enqueue(
            ts_us,
            mono_ns,
            cids,
            Cow::Owned(layer.to_string()),
            level,
            event,
            fields,
            None,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &self,
        ts_us: u64,
        mono_ns: u64,
        cids: Vec<String>,
        layer: Cow<'static, str>,
        level: Level,
        event: &str,
        fields: Fields,
        placed: Option<SyncSender<u64>>,
    ) -> bool {
        // Fields that the producer cut at the bound are stored as they are; the others are cut here when they are over it.
        let (fields, truncated) = match fields.truncated {
            Some(size) => (fields.text, Some(size)),
            None => cap_fields(fields.text),
        };
        let bytes = fields.get().len() + event.len();
        if self.queued_bytes.load(Ordering::Relaxed) + bytes > self.queue_bytes {
            self.count_loss(1, bytes as u64);
            return false;
        }
        let pending = Pending {
            ts_us,
            mono_ns,
            cids,
            layer,
            level,
            event: event.to_string(),
            fields,
            bytes,
            truncated,
            placed,
        };
        self.queued_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.queued_events.fetch_add(1, Ordering::Relaxed);
        match self.sender.try_send(Message::Event(pending)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
                self.queued_events.fetch_sub(1, Ordering::Relaxed);
                self.count_loss(1, bytes as u64);
                false
            }
        }
    }

    /// Adds events and bytes that a producer of this process refused before they reached the writer; the writer records
    /// them as a `log.dropped`.
    pub fn count_loss(&self, events: u64, bytes: u64) {
        self.loss.events.fetch_add(events, Ordering::Relaxed);
        self.loss.bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    /// Writes everything that is queued and waits until it is on disk, at most `deadline`.
    pub fn flush(&self, deadline: Duration) -> Result<(), String> {
        let (done, wait) = sync_channel(1);
        // A request has a reserved slot, so this send is not refused by a full queue of events.
        self.sender
            .try_send(Message::Flush(done))
            .map_err(|e| format!("the event writer did not take the flush request: {e}"))?;
        wait.recv_timeout(deadline)
            .map_err(|_| format!("the event writer did not flush within {deadline:?}"))
    }

    /// Writes everything that is queued and ends the writer.
    pub fn close(&self) {
        // default: the lock guards only the handle of the writer, and a panic of another thread must not stop the close.
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(handle) = writer.take() else {
            return;
        };
        if let Err(error) = self.sender.try_send(Message::Stop) {
            eprintln!("event writer: the stop request was not taken: {error}");
            return;
        }
        if handle.join().is_err() {
            eprintln!("event writer: the writer thread panicked");
        }
    }
}

impl Drop for EventLog {
    fn drop(&mut self) {
        self.close();
    }
}

/// Returns the fields text of an event as the writer stores it. Fields over `EVENT_FIELDS_LIMIT_BYTES` are replaced by
/// `{"head": <the first EVENT_HEAD_BYTES bytes of the text>}`, and the second result is the size of the text before the
/// cut; it is `None` for fields under the bound (docs/spec/logging.md#bounds).
fn cap_fields(fields: Box<RawValue>) -> (Box<RawValue>, Option<usize>) {
    let original = fields.get().len();
    if original <= EVENT_FIELDS_LIMIT_BYTES {
        return (fields, None);
    }
    let (head, _) = cut_text(fields.get(), EVENT_HEAD_BYTES);
    match to_raw_value(&json!({ "head": head })) {
        Ok(cut) => (cut, Some(original)),
        Err(error) => {
            // A string serializes without failure, so this is a defect of the serializer; the event keeps its size and no head.
            eprintln!(
                "event writer: the head of an event over the size bound cannot be serialized: {error}"
            );
            (
                RawValue::from_string("{}".to_string()).expect("{} is JSON"),
                Some(original),
            )
        }
    }
}

/// The line of one event, with the `seq` that the writer gives it.
fn line(seq: u64, pending: &Pending) -> String {
    // The fields are already JSON text, so the line is assembled without parsing them again. The size before a cut follows
    // the fields.
    let truncated = match pending.truncated {
        Some(size) => format!(",\"truncated\":{size}"),
        None => String::new(),
    };
    // The identifiers hold no quote, backslash or control character, so they are written without escaping.
    let cids = if pending.cids.is_empty() {
        String::new()
    } else {
        format!(",\"cids\":[\"{}\"]", pending.cids.join("\",\""))
    };
    format!(
        "{{\"ts_us\":{},\"mono_ns\":{},\"seq\":{},\"level\":\"{}\",\"layer\":\"{}\",\"event\":{}{},\"fields\":{}{}}}",
        pending.ts_us,
        pending.mono_ns,
        seq,
        pending.level.name(),
        pending.layer,
        serde_json::to_string(&pending.event).expect("a string serializes"),
        cids,
        pending.fields.get(),
        truncated
    )
}

/// The file of the writer with its batch, its size and the sequence number of the last line.
struct Output {
    file: File,
    path: PathBuf,
    rotate_bytes: u64,
    generations: usize,
    layer: &'static str,
    clock: fn() -> u64,
    /// The fields of `log.open`, written again at the start of every file.
    open_fields: String,
    batch: String,
    /// The bytes of the current file, written or waiting in the batch.
    size: u64,
    seq: u64,
    on_write: Arc<Mutex<Option<WriteObserver>>>,
}

impl Output {
    #[allow(clippy::too_many_arguments)]
    fn new(
        file: File,
        path: PathBuf,
        rotate_bytes: u64,
        generations: usize,
        layer: &'static str,
        clock: fn() -> u64,
        open: &Pending,
        on_write: Arc<Mutex<Option<WriteObserver>>>,
    ) -> Output {
        Output {
            file,
            path,
            rotate_bytes,
            generations,
            layer,
            clock,
            open_fields: open.fields.get().to_string(),
            batch: String::new(),
            size: 0,
            seq: 0,
            on_write,
        }
    }

    /// Adds the line of an event with the next `seq`.
    fn append(&mut self, pending: &Pending) {
        self.seq += 1;
        if let Some(placed) = &pending.placed {
            // The channel holds one value and a placed event is appended once, so the send does not wait; a refusal is
            // reported, and the caller then fails to read the position.
            if let Err(error) = placed.try_send(self.seq) {
                eprintln!(
                    "event writer: the position {} cannot be reported: {error}",
                    self.seq
                );
            }
        }
        let text = format!("{}\n", line(self.seq, pending));
        self.size += text.len() as u64;
        self.batch.push_str(&text);
    }

    /// The event of the layer of the writer that the writer itself produces.
    fn own(&self, level: Level, event: &str, fields: Box<RawValue>) -> Pending {
        Pending {
            ts_us: now_us(),
            mono_ns: (self.clock)(),
            cids: Vec::new(),
            layer: Cow::Borrowed(self.layer),
            level,
            event: event.into(),
            fields,
            bytes: 0,
            truncated: None,
            placed: None,
        }
    }

    /// Adds an event. A file that the line would take past the bound is closed first; the new file opens with
    /// `log.open` and the record of the rotation, so every file of the contract starts with `log.open` and `seq`
    /// continues.
    fn push(&mut self, pending: &Pending) {
        let next = line(self.seq + 1, pending).len() as u64 + 1;
        if self.rotate_bytes > 0 && self.size > 0 && self.size + next > self.rotate_bytes {
            self.flush();
            let full = self.size;
            if let Some(removed) = self.rotate() {
                self.size = 0;
                let open = self.own(
                    Level::Info,
                    "log.open",
                    RawValue::from_string(self.open_fields.clone())
                        .expect("the fields of log.open are JSON"),
                );
                self.append(&open);
                let rotated = self.own(
                    Level::Info,
                    "log.rotated",
                    to_raw_value(&json!({
                        "bytes": full,
                        "kept": self.generations,
                        "removed": removed,
                    }))
                    .expect("a json value serializes"),
                );
                self.append(&rotated);
            }
        }
        self.append(pending);
    }

    /// Stores one `log.dropped` after the range of `seq` that the refused events would have had. The refused events had no
    /// `seq`; their numbers are skipped (docs/spec/logging.md#event).
    fn dropped(&mut self, events: u64, bytes: u64, reason: &str) {
        if events == 0 {
            return;
        }
        let from = self.seq + 1;
        self.seq += events;
        let pending = self.own(
            Level::Warn,
            "log.dropped",
            to_raw_value(&json!({
                "from_seq": from,
                "to_seq": self.seq,
                "count": events,
                "bytes": bytes,
                "reason": reason,
            }))
            .expect("a json value serializes"),
        );
        self.push(&pending);
    }

    /// Writes the batch. A failed write is reported on the standard error; the writer keeps running for the next batch.
    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        if let Err(error) = self.file.write_all(self.batch.as_bytes()) {
            eprintln!("event writer: {error}");
        } else if let Some(observer) = self
            .on_write
            .lock()
            .expect("the observer of the writes")
            .as_ref()
        {
            observer(&self.path, self.size);
        }
        self.batch.clear();
    }

    /// Moves the full file to generation 1 and the older generations one step up, removes the generation beyond the kept
    /// ones, and opens a new file. Returns None when a step failed (the failure is reported and the writer keeps the
    /// file it has), otherwise the name of the removed generation, if there was one.
    fn rotate(&mut self) -> Option<Option<String>> {
        let path = self.path.clone();
        let generations = self.generations as u32;
        let mut outcome = None;
        let moved = crate::log_index::rotate_log_indexes(&path, generations, || {
            outcome = self.rotate_files();
            outcome
                .as_ref()
                .map(drop)
                .ok_or_else(|| "the files were not rotated".to_string())
        });
        if let (Some(_), Err(error)) = (&outcome, moved) {
            // The files rotated; only the index of the closed file is not complete, and a query builds it again.
            eprintln!("event writer: the index of the rotated file is not complete: {error}");
        }
        outcome
    }

    /// Renames the generations and opens the new file, as `rotate` describes; the failure of a step is reported here.
    fn rotate_files(&mut self) -> Option<Option<String>> {
        let path = self.path.clone();
        let generation = |n: usize| {
            let mut name = path.clone().into_os_string();
            name.push(format!(".{n}"));
            PathBuf::from(name)
        };
        let oldest = generation(self.generations);
        let removed = match std::fs::remove_file(&oldest) {
            Ok(()) => oldest
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                eprintln!(
                    "event writer: rotation could not remove {}: {error}",
                    oldest.display()
                );
                return None;
            }
        };
        for n in (1..self.generations).rev() {
            match std::fs::rename(generation(n), generation(n + 1)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    eprintln!(
                        "event writer: rotation could not move {}: {error}",
                        generation(n).display()
                    );
                    return None;
                }
            }
        }
        if let Err(error) = std::fs::rename(&path, generation(1)) {
            eprintln!(
                "event writer: rotation could not move {}: {error}",
                path.display()
            );
            return None;
        }
        // The new file is opened before the old one is released, so a failure leaves the writer with a file to write.
        let next = match OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) => {
                eprintln!(
                    "event writer: rotation could not open {}: {error}",
                    path.display()
                );
                return None;
            }
        };
        let full = std::mem::replace(&mut self.file, next);
        if let Err(error) = full.sync_all() {
            eprintln!("event writer: rotation could not sync the full file: {error}");
        }
        Some(removed)
    }
}

impl PullSink for Output {
    fn accept(&mut self, event: RelayedEvent) {
        self.push(&Pending {
            ts_us: event.ts_us,
            mono_ns: event.mono_ns,
            cids: event.cids,
            layer: Cow::Owned(event.layer),
            level: event.level,
            event: event.event,
            fields: event.fields.text,
            bytes: 0,
            truncated: event.fields.truncated,
            placed: None,
        });
    }

    fn lost(&mut self, events: u64, bytes: u64, reason: &str) {
        self.dropped(events, bytes, reason);
    }
}

#[allow(clippy::too_many_arguments)]
fn write_loop(
    mut out: Output,
    receiver: Receiver<Message>,
    queued_bytes: Arc<AtomicUsize>,
    queued_events: Arc<AtomicUsize>,
    loss: Arc<Loss>,
    interval: Duration,
    open: Pending,
    mut pull: Option<Pull>,
) {
    out.push(&open);
    // No event source reaches the writer from the native ring: a native thread must not call into this process's Rust
    // code, so the writer pulls at its batch interval and when it flushes.
    let mut pull_source = |out: &mut Output| {
        if let Some(pull) = pull.as_mut() {
            pull(out);
        }
    };
    let record_loss = |out: &mut Output| {
        let events = loss.events.swap(0, Ordering::Relaxed);
        let bytes = loss.bytes.swap(0, Ordering::Relaxed);
        out.dropped(events, bytes, "the queue was full");
    };
    let take = |out: &mut Output, pending: &Pending| {
        queued_bytes.fetch_sub(pending.bytes, Ordering::Relaxed);
        queued_events.fetch_sub(1, Ordering::Relaxed);
        out.push(pending);
    };
    // Takes every event that is queued now, then the loss counted so far, and writes them.
    let mut drain = |out: &mut Output| -> Option<Message> {
        pull_source(out);
        let mut request = None;
        while let Ok(message) = receiver.try_recv() {
            match message {
                Message::Event(pending) => take(out, &pending),
                other => {
                    request = Some(other);
                    break;
                }
            }
        }
        record_loss(out);
        out.flush();
        request
    };
    loop {
        let message = match receiver.recv_timeout(interval) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                // The interval ended: write what has gathered, and handle a request that was queued behind it.
                match drain(&mut out) {
                    Some(request) => request,
                    None => continue,
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                drain(&mut out);
                return;
            }
        };
        match message {
            Message::Event(pending) => {
                let urgent = pending.level == Level::Error;
                take(&mut out, &pending);
                if urgent {
                    record_loss(&mut out);
                    out.flush();
                }
            }
            Message::Flush(done) => {
                let following = drain(&mut out);
                if done.send(()).is_err() {
                    eprintln!("event writer: the flush was answered after its deadline");
                }
                if matches!(following, Some(Message::Stop)) {
                    return;
                }
            }
            Message::Stop => {
                drain(&mut out);
                return;
            }
        }
    }
}
