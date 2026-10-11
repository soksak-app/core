//! The event writer of the tool (docs/spec/logging.md#writers).
//!
//! A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer thread assigns `seq`,
//! serializes the JSON line, writes batches and records the events that the queue refused as `log.dropped`. A run of the
//! tool emits at most a handful of events (`log.open`, `sok.command`, `sok.panic`), so the file is not rotated.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Once, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use serde_json::value::{to_raw_value, RawValue};

/// The schema number of the lines that this writer writes. Schema 2 adds `mono_ns` to every line.
pub const SCHEMA: u64 = 2;

/// The layer and the role of the tool in the event contract.
const LAYER: &str = "sok";
const ROLE: &str = "sok";

/// The bounds of the writer of the tool (docs/spec/logging.md#bounds): events and bytes of serialized fields waiting for
/// the batch interval, the size of the fields of one event, and the head that an event over that size keeps.
const QUEUE_EVENTS: usize = 1024;
const QUEUE_BYTES: usize = 1 << 20;
const BATCH_INTERVAL: Duration = Duration::from_millis(100);
const FIELDS_LIMIT_BYTES: usize = 1 << 20;
const HEAD_BYTES: usize = 4096;

/// The slots of the queue that only requests use, so a flush or a stop is never refused because events filled the queue.
const RESERVED_FOR_REQUESTS: usize = 2;

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

/// One event waiting for the writer. `seq` is assigned when the writer serializes it.
struct Pending {
    ts_us: u64,
    /// The monotonic clock in nanoseconds (docs/spec/logging.md#event).
    mono_ns: u64,
    level: Level,
    event: String,
    /// The fields as JSON text, serialized once by the producer.
    fields: Box<RawValue>,
    bytes: usize,
    /// The size in bytes of the fields text before it was cut to its head, or `None` for an event that was not cut.
    truncated: Option<usize>,
}

/// What the queue carries: an event, or a request of the owner.
enum Message {
    Event(Pending),
    /// Write everything that is queued, then answer.
    Flush(SyncSender<()>),
    /// Write everything that is queued, then end.
    Stop,
}

/// The loss that the queue counted since the writer last recorded it.
struct Loss {
    events: AtomicU64,
    bytes: AtomicU64,
}

/// The writer of one run of the tool.
pub struct EventLog {
    sender: SyncSender<Message>,
    queued_events: Arc<AtomicUsize>,
    queued_bytes: Arc<AtomicUsize>,
    loss: Arc<Loss>,
    path: PathBuf,
    boot: String,
    writer: Mutex<Option<JoinHandle<()>>>,
}

/// The identifier of this run: the start time in seconds and the process identifier.
fn process_boot() -> String {
    format!("{}-{}", now_us() / 1_000_000, std::process::id())
}

fn now_us() -> u64 {
    // default: a clock before the epoch is a defect of the machine; the event then stores 0 and the audit refuses the line.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_micros() as u64)
}

/// The monotonic clock of the records (docs/spec/logging.md#event). A clock that cannot be read is a defect of the
/// platform: it is reported on the standard error (once, because every later event repeats it) and the event stores 0,
/// which the audit of the contract refuses.
fn monotonic_ns() -> u64 {
    static FAILURE: Once = Once::new();
    match crate::platform::current().and_then(|platform| platform.monotonic_nanos()) {
        Ok(nanos) => nanos,
        Err(error) => {
            FAILURE.call_once(|| {
                eprintln!("event writer: the monotonic clock cannot be read: {error}")
            });
            0
        }
    }
}

/// Cuts `text` to at most `limit` bytes on a character boundary and tells whether it was cut.
pub fn cut_text(text: &str, limit: usize) -> (&str, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// Returns the fields text of an event as the writer stores it. Fields over the size bound are replaced by
/// `{"head": <the first bytes of the text>}`, and the second result is the size of the text before the cut
/// (docs/spec/logging.md#bounds).
fn cap_fields(fields: Box<RawValue>) -> (Box<RawValue>, Option<usize>) {
    let size = fields.get().len();
    if size <= FIELDS_LIMIT_BYTES {
        return (fields, None);
    }
    let (head, _) = cut_text(fields.get(), HEAD_BYTES);
    match to_raw_value(&json!({ "head": head })) {
        Ok(cut) => (cut, Some(size)),
        Err(error) => {
            // A string serializes without failure, so this is a defect of the serializer; the event keeps its size and no head.
            eprintln!(
                "event writer: the head of an event over the size bound cannot be serialized: {error}"
            );
            (empty_fields(), Some(size))
        }
    }
}

fn empty_fields() -> Box<RawValue> {
    RawValue::from_string("{}".to_string()).expect("{} is JSON")
}

#[derive(Serialize)]
struct Record<'a> {
    ts_us: u64,
    mono_ns: u64,
    seq: u64,
    level: &'a str,
    layer: &'a str,
    event: &'a str,
    fields: &'a RawValue,
    /// The size in bytes of the fields before they were cut; absent for an event that was not cut.
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<usize>,
}

fn line(seq: u64, pending: &Pending) -> Result<String, serde_json::Error> {
    let mut text = serde_json::to_string(&Record {
        ts_us: pending.ts_us,
        mono_ns: pending.mono_ns,
        seq,
        level: pending.level.name(),
        layer: LAYER,
        event: &pending.event,
        fields: &pending.fields,
        truncated: pending.truncated,
    })?;
    text.push('\n');
    Ok(text)
}

impl EventLog {
    /// Creates the folder (mode 0700) and the file `logs/sok-<boot>.jsonl` (mode 0600, created new), writes `log.open` and
    /// starts the writer. `config` is the configuration folder.
    pub fn start(config: &Path) -> Result<EventLog, String> {
        let directory = config.join("logs");
        let reason = |path: &Path, error: std::io::Error| {
            format!("{}: {}", path.display(), crate::files::os_reason(&error))
        };
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
            .map_err(|error| reason(&directory, error))?;
        // A folder that existed before keeps its mode; the log folder of the contract is private.
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| reason(&directory, error))?;
        let boot = process_boot();
        let path = directory.join(format!("{ROLE}-{boot}.jsonl"));
        // The standard library opens the file close-on-exec, so a child process does not inherit it.
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| reason(&path, error))?;
        let (sender, receiver) = sync_channel(QUEUE_EVENTS + RESERVED_FOR_REQUESTS);
        let queued_events = Arc::new(AtomicUsize::new(0));
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let loss = Arc::new(Loss {
            events: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        });
        let open = Pending {
            ts_us: now_us(),
            mono_ns: monotonic_ns(),
            level: Level::Info,
            event: "log.open".into(),
            fields: to_raw_value(
                &json!({"schema": SCHEMA, "pid": std::process::id(), "role": ROLE, "boot": boot}),
            )
            .map_err(|error| error.to_string())?,
            bytes: 0,
            truncated: None,
        };
        let writer = {
            let (queued_events, queued_bytes, loss) =
                (queued_events.clone(), queued_bytes.clone(), loss.clone());
            crate::routine::spawn_named("event-log-writer", move || {
                write_loop(receiver, file, open, queued_events, queued_bytes, loss)
            })
        };
        Ok(EventLog {
            sender,
            queued_events,
            queued_bytes,
            loss,
            path,
            boot,
            writer: Mutex::new(Some(writer)),
        })
    }

    /// The file of this run.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The identifier of the run that this writer belongs to.
    pub fn boot(&self) -> &str {
        &self.boot
    }

    /// Queues an event. It returns false, and counts the loss, when the queue has no room. It never waits. The fields are
    /// serialized once, and only after the queue is known to have room for another event.
    pub fn emit<T: Serialize>(&self, level: Level, event: &str, fields: &T) -> bool {
        if self.queued_events.load(Ordering::SeqCst) >= QUEUE_EVENTS {
            self.count_loss(event.len());
            return false;
        }
        let fields = match to_raw_value(fields) {
            Ok(fields) => fields,
            Err(error) => {
                // A value that cannot be serialized is a defect of the caller; it is counted in place of the event.
                self.count_loss(event.len());
                eprintln!("event writer: the fields of {event} cannot be serialized: {error}");
                return false;
            }
        };
        let (fields, truncated) = cap_fields(fields);
        let bytes = fields.get().len() + event.len();
        if self.queued_bytes.load(Ordering::SeqCst) + bytes > QUEUE_BYTES {
            self.count_loss(bytes);
            return false;
        }
        let pending = Pending {
            ts_us: now_us(),
            mono_ns: monotonic_ns(),
            level,
            event: event.to_string(),
            fields,
            bytes,
            truncated,
        };
        self.queued_bytes.fetch_add(bytes, Ordering::SeqCst);
        self.queued_events.fetch_add(1, Ordering::SeqCst);
        match self.sender.try_send(Message::Event(pending)) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
                self.queued_events.fetch_sub(1, Ordering::SeqCst);
                self.count_loss(bytes);
                false
            }
        }
    }

    fn count_loss(&self, bytes: usize) {
        self.loss.events.fetch_add(1, Ordering::SeqCst);
        self.loss.bytes.fetch_add(bytes as u64, Ordering::SeqCst);
    }

    /// Writes everything that is queued and waits until it is on disk, at most `deadline`.
    pub fn flush(&self, deadline: Duration) -> Result<(), String> {
        let (answer, answered) = sync_channel(1);
        // A request has a reserved slot, so this send is not refused by a full queue of events.
        self.sender
            .try_send(Message::Flush(answer))
            .map_err(|_| "the event writer did not take the flush request".to_string())?;
        match answered.recv_timeout(deadline) {
            Ok(()) => Ok(()),
            Err(_) => Err(format!(
                "the event writer did not flush within {}s",
                deadline.as_secs_f64()
            )),
        }
    }

    /// Writes everything that is queued and ends the writer.
    pub fn close(&self) {
        // default: the lock guards only the handle of the writer, and a panic of another thread must not stop the close.
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(handle) = writer.take() else {
            return;
        };
        if self.sender.try_send(Message::Stop).is_err() {
            eprintln!("event writer: the writer did not take the stop request");
            return;
        }
        if handle.join().is_err() {
            eprintln!("event writer: the writer thread ended with a panic");
        }
    }
}

/// The state of the writer thread: the file, the batch waiting to be written and the next `seq`.
struct Output {
    file: File,
    batch: String,
    seq: u64,
}

impl Output {
    fn push(&mut self, pending: &Pending) {
        self.seq += 1;
        match line(self.seq, pending) {
            // The line is not written; the seq stays taken, so the audit shows the gap next to this report.
            Err(error) => eprintln!("event writer: {} cannot be written: {error}", pending.event),
            Ok(text) => self.batch.push_str(&text),
        }
    }

    /// Stores one `log.dropped` after the range of `seq` that the refused events would have had.
    fn record_loss(&mut self, loss: &Loss) {
        let events = loss.events.swap(0, Ordering::SeqCst);
        let bytes = loss.bytes.swap(0, Ordering::SeqCst);
        if events == 0 {
            return;
        }
        // The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
        // names (docs/spec/logging.md#event).
        let from = self.seq + 1;
        self.seq += events;
        let fields = json!({"from_seq": from, "to_seq": self.seq, "count": events, "bytes": bytes, "reason": "the queue was full"});
        match to_raw_value(&fields) {
            Ok(fields) => self.push(&Pending {
                ts_us: now_us(),
                mono_ns: monotonic_ns(),
                level: Level::Warn,
                event: "log.dropped".into(),
                fields,
                bytes: 0,
                truncated: None,
            }),
            Err(error) => eprintln!("event writer: log.dropped cannot be written: {error}"),
        }
    }

    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        // A failed write is reported on the standard error; the writer keeps running for the next batch.
        if let Err(error) = self.file.write_all(self.batch.as_bytes()) {
            eprintln!("event writer: {error}");
        }
        self.batch.clear();
    }

    fn write(&mut self, loss: &Loss) {
        self.record_loss(loss);
        self.flush();
    }
}

fn write_loop(
    receiver: Receiver<Message>,
    file: File,
    open: Pending,
    queued_events: Arc<AtomicUsize>,
    queued_bytes: Arc<AtomicUsize>,
    loss: Arc<Loss>,
) {
    let mut output = Output {
        file,
        batch: String::new(),
        seq: 0,
    };
    output.push(&open);
    let take = |output: &mut Output, pending: Pending| {
        queued_bytes.fetch_sub(pending.bytes, Ordering::SeqCst);
        queued_events.fetch_sub(1, Ordering::SeqCst);
        output.push(&pending);
    };
    loop {
        match receiver.recv_timeout(BATCH_INTERVAL) {
            Ok(Message::Event(pending)) => {
                let urgent = pending.level == Level::Error;
                take(&mut output, pending);
                if urgent {
                    output.write(&loss);
                }
            }
            Ok(Message::Flush(answer)) => {
                // The queue is in order, so every event before the request is already taken.
                output.write(&loss);
                if answer.send(()).is_err() {
                    eprintln!("event writer: the owner of a flush request is gone");
                }
            }
            Ok(Message::Stop) => {
                output.write(&loss);
                return;
            }
            Err(RecvTimeoutError::Timeout) => output.write(&loss),
            Err(RecvTimeoutError::Disconnected) => {
                output.write(&loss);
                return;
            }
        }
    }
}
