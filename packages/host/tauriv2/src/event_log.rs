//! The event writer of the host (docs/spec/logging.md#writers).
//!
//! A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer thread assigns `seq`,
//! serializes the JSON line, writes batches and records the events that the queue refused as `log.dropped`.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use serde_json::value::{to_raw_value, RawValue};

/// The schema number of the lines that this writer writes.
pub const SCHEMA: u64 = 1;

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

/// How a writer is started.
pub struct Options {
    /// The `logs` folder.
    pub directory: PathBuf,
    /// The role of the process (`host`).
    pub role: String,
    /// The identifier of this run.
    pub boot: String,
    /// The bound of the queue in events.
    pub queue_events: usize,
    /// The bound of the queue in bytes of serialized fields.
    pub queue_bytes: usize,
    /// How long the writer waits for more events before it writes a batch.
    pub batch_interval: Duration,
}

/// One event waiting for the writer. `seq` is assigned when the writer serializes it.
struct Pending {
    ts_us: u64,
    level: Level,
    event: String,
    /// The fields as JSON text, serialized once by the producer.
    fields: Box<RawValue>,
    bytes: usize,
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

pub struct EventLog {
    sender: SyncSender<Message>,
    queued_events: Arc<AtomicUsize>,
    queue_events: usize,
    queued_bytes: Arc<AtomicUsize>,
    queue_bytes: usize,
    loss: Arc<Loss>,
    path: PathBuf,
    writer: Mutex<Option<JoinHandle<()>>>,
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is before the Unix epoch")
        .as_micros() as u64
}

impl EventLog {
    /// Creates the folder (mode 0700) and the file (mode 0600), writes `log.open` and starts the writer thread.
    pub fn start(options: Options) -> Result<EventLog, String> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&options.directory)
            .map_err(|e| format!("{}: {e}", options.directory.display()))?;
        // A folder that existed before keeps its mode; the log folder of the contract is private.
        std::fs::set_permissions(&options.directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: {e}", options.directory.display()))?;
        let path = options
            .directory
            .join(format!("{}-{}.jsonl", options.role, options.boot));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let (sender, receiver) = sync_channel(options.queue_events + RESERVED_FOR_REQUESTS);
        let queued_events = Arc::new(AtomicUsize::new(0));
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let loss = Arc::new(Loss {
            events: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        });
        let open = Pending {
            ts_us: now_us(),
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
        };
        let writer = {
            let queued_bytes = Arc::clone(&queued_bytes);
            let queued_events = Arc::clone(&queued_events);
            let loss = Arc::clone(&loss);
            let interval = options.batch_interval;
            std::thread::Builder::new()
                .name("event-log-writer".into())
                .spawn(move || {
                    write_loop(
                        file,
                        receiver,
                        queued_bytes,
                        queued_events,
                        loss,
                        interval,
                        open,
                    )
                })
                .map_err(|e| format!("event writer thread: {e}"))?
        };
        Ok(EventLog {
            sender,
            queued_events,
            queue_events: options.queue_events,
            queued_bytes,
            queue_bytes: options.queue_bytes,
            loss,
            path,
            writer: Mutex::new(Some(writer)),
        })
    }

    /// The file this writer writes.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Queues an event. Returns false, and counts the loss, when the queue has no room. It never waits. The fields are
    /// serialized once, and only after the queue is known to have room for another event.
    pub fn emit<T: Serialize>(&self, level: Level, event: &str, fields: &T) -> bool {
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(event.len());
            return false;
        }
        let fields = match to_raw_value(fields) {
            Ok(fields) => fields,
            Err(error) => {
                // A value that cannot be serialized is a defect of the caller: it is recorded in place of the event.
                self.count_loss(event.len());
                eprintln!("event writer: the fields of {event} cannot be serialized: {error}");
                return false;
            }
        };
        let bytes = fields.get().len() + event.len();
        if self.queued_bytes.load(Ordering::Relaxed) + bytes > self.queue_bytes {
            self.count_loss(bytes);
            return false;
        }
        let pending = Pending {
            ts_us: now_us(),
            level,
            event: event.to_string(),
            fields,
            bytes,
        };
        self.queued_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.queued_events.fetch_add(1, Ordering::Relaxed);
        match self.sender.try_send(Message::Event(pending)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
                self.queued_events.fetch_sub(1, Ordering::Relaxed);
                self.count_loss(bytes);
                false
            }
        }
    }

    fn count_loss(&self, bytes: usize) {
        self.loss.events.fetch_add(1, Ordering::Relaxed);
        self.loss.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
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
}

impl Drop for EventLog {
    fn drop(&mut self) {
        if let Err(error) = self.sender.try_send(Message::Stop) {
            eprintln!("event writer: the stop request was not taken: {error}");
        }
        if let Ok(mut writer) = self.writer.lock() {
            if let Some(handle) = writer.take() {
                if handle.join().is_err() {
                    eprintln!("event writer: the writer thread panicked");
                }
            }
        }
    }
}

/// The line of one event, with the `seq` that the writer gives it.
fn line(seq: u64, pending: &Pending) -> String {
    // The fields are already JSON text, so the line is assembled without parsing them again.
    format!(
        "{{\"ts_us\":{},\"seq\":{},\"level\":\"{}\",\"layer\":\"host\",\"event\":{},\"fields\":{}}}",
        pending.ts_us,
        seq,
        pending.level.name(),
        serde_json::to_string(&pending.event).expect("a string serializes"),
        pending.fields.get()
    )
}

fn write_loop(
    mut file: File,
    receiver: Receiver<Message>,
    queued_bytes: Arc<AtomicUsize>,
    queued_events: Arc<AtomicUsize>,
    loss: Arc<Loss>,
    interval: Duration,
    open: Pending,
) {
    let mut seq = 0u64;
    let mut batch = String::new();
    let push = |batch: &mut String, seq: &mut u64, pending: &Pending| {
        *seq += 1;
        batch.push_str(&line(*seq, pending));
        batch.push('\n');
    };
    push(&mut batch, &mut seq, &open);
    let record_loss = |batch: &mut String, seq: &mut u64| {
        let events = loss.events.swap(0, Ordering::Relaxed);
        if events == 0 {
            return;
        }
        let bytes = loss.bytes.swap(0, Ordering::Relaxed);
        // The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
        // names (docs/spec/logging.md#event).
        let from = *seq + 1;
        *seq += events;
        let dropped = Pending {
            ts_us: now_us(),
            level: Level::Warn,
            event: "log.dropped".into(),
            fields: to_raw_value(&json!({
                "from_seq": from,
                "to_seq": *seq,
                "count": events,
                "bytes": bytes,
                "reason": "the queue was full",
            }))
            .expect("a json value serializes"),
            bytes: 0,
        };
        *seq += 1;
        batch.push_str(&line(*seq, &dropped));
        batch.push('\n');
    };
    let write = |file: &mut File, batch: &mut String| {
        if batch.is_empty() {
            return;
        }
        // A failed write is reported on the standard error; the writer keeps running for the next batch.
        if let Err(error) = file.write_all(batch.as_bytes()) {
            eprintln!("event writer: {error}");
        }
        batch.clear();
    };
    let take = |batch: &mut String, seq: &mut u64, pending: &Pending| {
        queued_bytes.fetch_sub(pending.bytes, Ordering::Relaxed);
        queued_events.fetch_sub(1, Ordering::Relaxed);
        push(batch, seq, pending);
    };
    // Takes every event that is queued now, then the loss counted so far, and writes them.
    let drain = |file: &mut File, batch: &mut String, seq: &mut u64| -> Option<Message> {
        let mut request = None;
        while let Ok(message) = receiver.try_recv() {
            match message {
                Message::Event(pending) => take(batch, seq, &pending),
                other => {
                    request = Some(other);
                    break;
                }
            }
        }
        record_loss(batch, seq);
        write(file, batch);
        request
    };
    loop {
        let message = match receiver.recv_timeout(interval) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                // The interval ended: write what has gathered, and handle a request that was queued behind it.
                match drain(&mut file, &mut batch, &mut seq) {
                    Some(request) => request,
                    None => continue,
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                drain(&mut file, &mut batch, &mut seq);
                return;
            }
        };
        match message {
            Message::Event(pending) => {
                let urgent = pending.level == Level::Error;
                take(&mut batch, &mut seq, &pending);
                if urgent {
                    record_loss(&mut batch, &mut seq);
                    write(&mut file, &mut batch);
                }
            }
            Message::Flush(done) => {
                let following = drain(&mut file, &mut batch, &mut seq);
                if done.send(()).is_err() {
                    eprintln!("event writer: the flush was answered after its deadline");
                }
                if matches!(following, Some(Message::Stop)) {
                    return;
                }
            }
            Message::Stop => {
                drain(&mut file, &mut batch, &mut seq);
                return;
            }
        }
    }
}
