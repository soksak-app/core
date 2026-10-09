//! The event writer of the host (docs/spec/logging.md#writers).
//!
//! A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer thread assigns `seq`,
//! serializes the JSON line, writes batches and records the events that the queue refused as `log.dropped`.

use std::borrow::Cow;
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
    /// The size at which the writer starts a new file; the file that was full becomes generation 1.
    pub rotate_bytes: u64,
    /// The number of earlier files that are kept (`.1` is the newest); the oldest one is removed.
    pub generations: usize,
}

/// One event waiting for the writer. `seq` is assigned when the writer serializes it.
struct Pending {
    ts_us: u64,
    layer: Cow<'static, str>,
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

/// The bounds of the writer of a host: events and bytes of serialized fields waiting for the batch interval.
const HOST_QUEUE_EVENTS: usize = 8192;
const HOST_QUEUE_BYTES: usize = 16 << 20;
const HOST_BATCH_INTERVAL: Duration = Duration::from_millis(100);
const HOST_ROTATE_BYTES: u64 = 100 << 20;
const HOST_GENERATIONS: usize = 5;

/// The layers of the event contract (docs/spec/logging.md#event).
const LAYERS: [&str; 5] = ["native", "host", "page", "plugin", "sidecar"];

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is before the Unix epoch")
        .as_micros() as u64
}

impl EventLog {
    /// Starts the writer of the host in `logs/` of the configuration folder; the boot identifier is the start time in
    /// seconds and the process identifier.
    pub fn start_host(config: &Path) -> Result<EventLog, String> {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("clock is before the Unix epoch: {e}"))?
            .as_secs();
        EventLog::start(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: format!("{seconds}-{}", std::process::id()),
            queue_events: HOST_QUEUE_EVENTS,
            queue_bytes: HOST_QUEUE_BYTES,
            batch_interval: HOST_BATCH_INTERVAL,
            rotate_bytes: HOST_ROTATE_BYTES,
            generations: HOST_GENERATIONS,
        })
    }

    /// Creates the folder (mode 0700) and the file (mode 0600), writes `log.open` and starts the writer thread.
    pub fn start(options: Options) -> Result<EventLog, String> {
        if options.rotate_bytes == 0 {
            return Err("event writer: rotate_bytes must be positive".into());
        }
        if options.generations == 0 {
            return Err("event writer: generations must be positive".into());
        }
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
            layer: Cow::Borrowed("host"),
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
            let path_for_writer = path.clone();
            let rotate_bytes = options.rotate_bytes;
            let generations = options.generations;
            std::thread::Builder::new()
                .name("event-log-writer".into())
                .spawn(move || {
                    write_loop(
                        Output::new(file, path_for_writer, rotate_bytes, generations, &open),
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
        self.enqueue(now_us(), Cow::Borrowed("host"), level, event, fields)
    }

    /// Queues an event that another layer of this process produced, with the time and the layer it carries. The event
    /// name must start with the layer, so the name and the layer cannot disagree. Returns an error for a layer outside
    /// the contract or a name that does not start with it, and false, with the loss counted, when the queue has no room.
    pub fn emit_relayed(
        &self,
        ts_us: u64,
        layer: &str,
        level: Level,
        event: &str,
        fields: Box<RawValue>,
    ) -> Result<bool, String> {
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
            self.count_loss(event.len());
            return Ok(false);
        }
        Ok(self.enqueue(ts_us, Cow::Owned(layer.to_string()), level, event, fields))
    }

    fn enqueue(
        &self,
        ts_us: u64,
        layer: Cow<'static, str>,
        level: Level,
        event: &str,
        fields: Box<RawValue>,
    ) -> bool {
        let bytes = fields.get().len() + event.len();
        if self.queued_bytes.load(Ordering::Relaxed) + bytes > self.queue_bytes {
            self.count_loss(bytes);
            return false;
        }
        let pending = Pending {
            ts_us,
            layer,
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
        "{{\"ts_us\":{},\"seq\":{},\"level\":\"{}\",\"layer\":\"{}\",\"event\":{},\"fields\":{}}}",
        pending.ts_us,
        seq,
        pending.level.name(),
        pending.layer,
        serde_json::to_string(&pending.event).expect("a string serializes"),
        pending.fields.get()
    )
}

/// The file of the writer with its batch, its size and the sequence number of the last line.
struct Output {
    file: File,
    path: PathBuf,
    rotate_bytes: u64,
    generations: usize,
    /// The fields of `log.open`, written again at the start of every file.
    open_fields: String,
    batch: String,
    /// The bytes of the current file, written or waiting in the batch.
    size: u64,
    seq: u64,
}

impl Output {
    fn new(
        file: File,
        path: PathBuf,
        rotate_bytes: u64,
        generations: usize,
        open: &Pending,
    ) -> Output {
        Output {
            file,
            path,
            rotate_bytes,
            generations,
            open_fields: open.fields.get().to_string(),
            batch: String::new(),
            size: 0,
            seq: 0,
        }
    }

    /// Adds the line of an event with the next `seq`.
    fn append(&mut self, pending: &Pending) {
        self.seq += 1;
        let text = format!("{}\n", line(self.seq, pending));
        self.size += text.len() as u64;
        self.batch.push_str(&text);
    }

    /// Adds an event. A file that the line would take past the bound is closed first; the new file opens with
    /// `log.open` and the record of the rotation, so every file of the contract starts with `log.open` and `seq`
    /// continues.
    fn push(&mut self, pending: &Pending) {
        let next = line(self.seq + 1, pending).len() as u64 + 1;
        if self.size > 0 && self.size + next > self.rotate_bytes {
            self.flush();
            let full = self.size;
            if let Some(removed) = self.rotate() {
                self.size = 0;
                let open = Pending {
                    ts_us: now_us(),
                    layer: Cow::Borrowed("host"),
                    level: Level::Info,
                    event: "log.open".into(),
                    fields: RawValue::from_string(self.open_fields.clone())
                        .expect("the fields of log.open are JSON"),
                    bytes: 0,
                };
                self.append(&open);
                let rotated = Pending {
                    ts_us: now_us(),
                    layer: Cow::Borrowed("host"),
                    level: Level::Info,
                    event: "log.rotated".into(),
                    fields: to_raw_value(&json!({
                        "bytes": full,
                        "kept": self.generations,
                        "removed": removed,
                    }))
                    .expect("a json value serializes"),
                    bytes: 0,
                };
                self.append(&rotated);
            }
        }
        self.append(pending);
    }

    /// Writes the batch. A failed write is reported on the standard error; the writer keeps running for the next batch.
    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        if let Err(error) = self.file.write_all(self.batch.as_bytes()) {
            eprintln!("event writer: {error}");
        }
        self.batch.clear();
    }

    /// Moves the full file to generation 1 and the older generations one step up, removes the generation beyond the kept
    /// ones, and opens a new file. Returns None when a step failed (the failure is reported and the writer keeps the
    /// file it has), otherwise the name of the removed generation, if there was one.
    fn rotate(&mut self) -> Option<Option<String>> {
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
            .custom_flags(libc::O_CLOEXEC)
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

fn write_loop(
    mut out: Output,
    receiver: Receiver<Message>,
    queued_bytes: Arc<AtomicUsize>,
    queued_events: Arc<AtomicUsize>,
    loss: Arc<Loss>,
    interval: Duration,
    open: Pending,
) {
    out.push(&open);
    let record_loss = |out: &mut Output| {
        let events = loss.events.swap(0, Ordering::Relaxed);
        if events == 0 {
            return;
        }
        let bytes = loss.bytes.swap(0, Ordering::Relaxed);
        // The refused events had no seq. Their numbers are skipped, and log.dropped is stored after the range that it
        // names (docs/spec/logging.md#event).
        let from = out.seq + 1;
        out.seq += events;
        let dropped = Pending {
            layer: Cow::Borrowed("host"),
            ts_us: now_us(),
            level: Level::Warn,
            event: "log.dropped".into(),
            fields: to_raw_value(&json!({
                "from_seq": from,
                "to_seq": out.seq,
                "count": events,
                "bytes": bytes,
                "reason": "the queue was full",
            }))
            .expect("a json value serializes"),
            bytes: 0,
        };
        out.push(&dropped);
    };
    let take = |out: &mut Output, pending: &Pending| {
        queued_bytes.fetch_sub(pending.bytes, Ordering::Relaxed);
        queued_events.fetch_sub(1, Ordering::Relaxed);
        out.push(pending);
    };
    // Takes every event that is queued now, then the loss counted so far, and writes them.
    let drain = |out: &mut Output| -> Option<Message> {
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
