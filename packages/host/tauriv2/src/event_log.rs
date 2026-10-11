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

use soksak_sok::event_classes::{class_of, Class};

use crate::bounds::{cut_text, Fields, EVENT_FIELDS_LIMIT_BYTES, EVENT_HEAD_BYTES};

/// The schema number of the lines that this writer writes.
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
    /// The size at which the writer starts a new file. Each of the two files of the writer (the main file and the debug file)
    /// rotates on its own: the file that was full becomes the next generation (`.1` is the first), and rotation removes no
    /// generation.
    pub rotate_bytes: u64,
    /// Moves whole records of the native ring into the buffer and returns the number of bytes written; `None` when the
    /// process has no native ring. `pull_loss` returns the events and bytes that the ring refused in a channel since the last
    /// call.
    pub pull: Option<Pull>,
    pub pull_loss: Option<PullLoss>,
    /// The policy file that the writer follows (`<config-dir>/log-policy.json`); `None` for a writer that has none.
    pub policy_path: Option<PathBuf>,
    /// The bound of the files of the runs in the folder (docs/spec/logging.md#retention): the writer removes the oldest runs when it
    /// starts and after each rotation while the files pass it.
    pub retention_bytes: u64,
}

/// The set of the files of a process that holds a set of levels (docs/spec/logging.md#files): `Other` holds error, warn and info
/// in the main file, and `Debug` holds debug and trace in the debug file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Other,
    Debug,
}

impl Channel {
    /// The channels in the order of their files.
    pub const ALL: [Channel; 2] = [Channel::Other, Channel::Debug];

    /// The channel that stores the level.
    pub fn of(level: Level) -> Channel {
        match level {
            Level::Debug | Level::Trace => Channel::Debug,
            Level::Error | Level::Warn | Level::Info => Channel::Other,
        }
    }

    /// The name of the channel in `log.dropped` and in the query.
    pub fn name(self) -> &'static str {
        match self {
            Channel::Other => "other",
            Channel::Debug => "debug",
        }
    }

    fn index(self) -> usize {
        match self {
            Channel::Other => 0,
            Channel::Debug => 1,
        }
    }
}

/// The pull of the native ring, called on the writer thread.
pub type Pull = Box<dyn Fn(&mut [u8]) -> Result<usize, String> + Send>;
/// The loss of the native ring in a channel since the last call, as events and bytes.
pub type PullLoss = Box<dyn Fn(Channel) -> (u64, u64) + Send>;

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
    /// The class that the catalog declares for the event; `None` for a name the catalog does not declare, which the line marks
    /// `undeclared`.
    class: Option<Class>,
    /// The fields as JSON text, serialized once by the producer.
    fields: Box<RawValue>,
    bytes: usize,
    /// The size in bytes of the fields text before it was cut to its head, or `None` for an event that was not cut.
    truncated: Option<usize>,
    /// When set, receives the `seq` of the line once the writer gave it one.
    placed: Option<SyncSender<u64>>,
}

impl Pending {
    /// An event that the writer itself creates (`log.open`, `log.rotated`, `log.dropped`), with both clocks read now.
    fn writer_event(level: Level, event: &str, fields: Box<RawValue>) -> Pending {
        Pending {
            ts_us: now_us(),
            mono_ns: monotonic_ns(),
            cids: Vec::new(),
            layer: Cow::Borrowed("host"),
            level,
            event: event.into(),
            class: class_of(event),
            fields,
            bytes: 0,
            truncated: None,
            placed: None,
        }
    }
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

/// The loss that the queue counted since the writer last recorded it, for each channel.
struct Loss {
    events: [AtomicU64; 2],
    bytes: [AtomicU64; 2],
}

/// The observer that the writer calls after it wrote a batch, with the path of the file and its size.
type WriteObserver = Box<dyn Fn(&Path, u64) + Send + Sync>;

pub struct EventLog {
    on_write: Arc<Mutex<Option<WriteObserver>>>,
    sender: SyncSender<Message>,
    queued_events: Arc<AtomicUsize>,
    queue_events: usize,
    queued_bytes: Arc<AtomicUsize>,
    queue_bytes: usize,
    loss: Arc<Loss>,
    path: PathBuf,
    debug_path: PathBuf,
    /// The policy in force and the count of the events that it refused.
    gate: Arc<crate::log_policy::Gate>,
    policy_path: Option<PathBuf>,
    boot: String,
    writer: Mutex<Option<JoinHandle<()>>>,
}

/// The bounds of the writer of a host: events and bytes of serialized fields waiting for the batch interval.
const HOST_QUEUE_EVENTS: usize = 8192;
const HOST_QUEUE_BYTES: usize = 16 << 20;
const HOST_BATCH_INTERVAL: Duration = Duration::from_millis(100);
const HOST_ROTATE_BYTES: u64 = 100 << 20;

/// The identifier of this run, shared by the files of the run: the start time in seconds and the process identifier.
fn process_boot() -> &'static str {
    static BOOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BOOT.get_or_init(|| {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is before the Unix epoch")
            .as_secs();
        format!("{seconds}-{}", std::process::id())
    })
}

/// The stderr file of this run under the logs folder of `config`.
pub fn standard_error_path(config: &Path) -> PathBuf {
    config
        .join("logs")
        .join(format!("host-{}.stderr", process_boot()))
}

/// The layers of the event contract (docs/spec/logging.md#event).
const LAYERS: [&str; 5] = ["native", "host", "page", "plugin", "sidecar"];

/// The monotonic clock of the records in nanoseconds, read from the platform so the host, the native layer and the page
/// share one clock. A platform that cannot read it is reported on the standard error and the clock is 0, which the audit
/// of the logs refuses.
pub fn monotonic_ns() -> u64 {
    match crate::platform::current().and_then(|system| system.monotonic_ns()) {
        Ok(nanoseconds) => nanoseconds,
        Err(error) => {
            eprintln!("event writer: the monotonic clock cannot be read: {error}");
            0
        }
    }
}

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

    /// Starts the writer of the host in `logs/` of the configuration folder; the boot identifier is the start time in
    /// seconds and the process identifier.
    pub fn start_host(config: &Path) -> Result<EventLog, String> {
        let system = crate::platform::current()?;
        // A platform that cannot pull the native ring fails here, at the start, instead of running without native events.
        system.pull_native_events(&mut [0u8; 1])?;
        system.set_event_boot(process_boot())?;
        system.observe_activity()?;
        EventLog::start(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: process_boot().to_string(),
            queue_events: HOST_QUEUE_EVENTS,
            queue_bytes: HOST_QUEUE_BYTES,
            batch_interval: HOST_BATCH_INTERVAL,
            rotate_bytes: HOST_ROTATE_BYTES,
            pull: Some(Box::new(|buffer| {
                crate::platform::current()?.pull_native_events(buffer)
            })),
            policy_path: Some(config.join("log-policy.json")),
            retention_bytes: crate::log_retention::HOST_RETENTION_BYTES,
            pull_loss: Some(Box::new(|channel| {
                match crate::platform::current()
                    .and_then(|system| system.take_native_event_loss(channel.index() as u8))
                {
                    Ok(loss) => loss,
                    Err(error) => {
                        eprintln!(
                            "event writer: the loss of the native ring cannot be read: {error}"
                        );
                        (0, 0)
                    }
                }
            })),
        })
    }

    /// Creates the folder (mode 0700) and the file (mode 0600), writes `log.open` and starts the writer thread.
    pub fn start(options: Options) -> Result<EventLog, String> {
        if options.rotate_bytes == 0 {
            return Err("event writer: rotate_bytes must be positive".into());
        }
        if options.retention_bytes == 0 {
            return Err("event writer: retention_bytes must be positive".into());
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
        let debug_path = options
            .directory
            .join(format!("{}-{}.debug.jsonl", options.role, options.boot));
        let file = open_log_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let on_write: Arc<Mutex<Option<WriteObserver>>> = Arc::new(Mutex::new(None));
        let (sender, receiver) = sync_channel(options.queue_events + RESERVED_FOR_REQUESTS);
        let queued_events = Arc::new(AtomicUsize::new(0));
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let loss = Arc::new(Loss {
            events: [AtomicU64::new(0), AtomicU64::new(0)],
            bytes: [AtomicU64::new(0), AtomicU64::new(0)],
        });
        let open = Pending::writer_event(
            Level::Info,
            "log.open",
            to_raw_value(&json!({
                "schema": SCHEMA,
                "pid": std::process::id(),
                "role": options.role,
                "boot": options.boot,
            }))
            .map_err(|e| format!("log.open: {e}"))?,
        );
        let gate = Arc::new(crate::log_policy::Gate::new());
        let writer = {
            let queued_bytes = Arc::clone(&queued_bytes);
            let queued_events = Arc::clone(&queued_events);
            let loss = Arc::clone(&loss);
            let interval = options.batch_interval;
            let path_for_writer = path.clone();
            let debug_path_for_writer = debug_path.clone();
            let observer = Arc::clone(&on_write);
            let rotate_bytes = options.rotate_bytes;
            let retention_directory = options.directory.clone();
            let retention_run = format!("{}-{}", options.role, options.boot);
            let retention_bytes = options.retention_bytes;
            let pull = options.pull;
            let pull_loss = options.pull_loss;
            let gate = Arc::clone(&gate);
            std::thread::Builder::new()
                .name("event-log-writer".into())
                .spawn(move || {
                    write_loop(
                        Output::new(
                            file,
                            path_for_writer,
                            debug_path_for_writer,
                            rotate_bytes,
                            Retention {
                                directory: retention_directory,
                                run: retention_run,
                                bytes: retention_bytes,
                            },
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
                        pull_loss,
                        gate,
                    )
                })
                .map_err(|e| format!("event writer thread: {e}"))?
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
            debug_path,
            gate,
            policy_path: options.policy_path,
            boot: options.boot,
            writer: Mutex::new(Some(writer)),
        })
    }

    /// The main file of this writer (error, warn and info).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The debug file of this writer (debug and trace); it exists once the first event of the channel `Debug` was written.
    pub fn debug_path(&self) -> &Path {
        &self.debug_path
    }

    /// The identifier of the run that this writer belongs to; with a `seq` it names a line of the log.
    pub fn boot(&self) -> &str {
        &self.boot
    }

    /// Queues an event of the layer `host`, waits until it is on disk, at most `deadline`, and returns its `seq`. The queue
    /// refusing the event is an error, so a caller that stores the position never stores one of a line that does not
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
            monotonic_ns(),
            Vec::new(),
            Cow::Borrowed("host"),
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

    /// Queues an event. Returns false, and counts the loss, when the queue has no room. It never waits. The fields are
    /// serialized once, and only after the queue is known to have room for another event.
    pub fn emit<T: Serialize>(&self, level: Level, event: &str, fields: &T) -> bool {
        // A closed gate serializes nothing; an event the catalog does not declare has no class and no gate.
        if let Some(class) = class_of(event) {
            if !self.gate(class, level) {
                return false;
            }
        }
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(Channel::of(level), 1, event.len() as u64);
            return false;
        }
        let fields = match Fields::of(fields) {
            Ok(fields) => fields,
            Err(error) => {
                // A value that cannot be serialized is a defect of the caller: it is recorded in place of the event.
                self.count_loss(Channel::of(level), 1, event.len() as u64);
                eprintln!("event writer: the fields of {event} cannot be serialized: {error}");
                return false;
            }
        };
        self.enqueue(
            now_us(),
            monotonic_ns(),
            Vec::new(),
            Cow::Borrowed("host"),
            level,
            event,
            fields,
            None,
        )
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
            self.count_loss(Channel::of(level), 1, event.len() as u64);
            eprintln!("event writer: {event} has the correlation identifier {bad:?}, which is empty or holds a quote, a backslash or a control character");
            return false;
        }
        if let Some(class) = class_of(event) {
            if !self.gate(class, level) {
                return false;
            }
        }
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(Channel::of(level), 1, event.len() as u64);
            return false;
        }
        let fields = match Fields::of(fields) {
            Ok(fields) => fields,
            Err(error) => {
                self.count_loss(Channel::of(level), 1, event.len() as u64);
                eprintln!("event writer: the fields of {event} cannot be serialized: {error}");
                return false;
            }
        };
        self.enqueue(
            now_us(),
            monotonic_ns(),
            cids.to_vec(),
            Cow::Borrowed("host"),
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
        if let Some(class) = class_of(event) {
            if !self.gate(class, level) {
                return Ok(false);
            }
        }
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(Channel::of(level), 1, event.len() as u64);
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
            self.count_loss(Channel::of(level), 1, bytes as u64);
            return false;
        }
        // A closed gate stores nothing and counts the event.
        if let Some(class) = class_of(event) {
            if !self.gate(class, level) {
                return false;
            }
        }
        let pending = Pending {
            ts_us,
            mono_ns,
            cids,
            layer,
            level,
            event: event.to_string(),
            class: class_of(event),
            fields,
            bytes,
            truncated,
            placed,
        };
        self.queue(pending)
    }

    /// Hands a counted event to the writer; a full queue refuses it and counts the loss.
    fn queue(&self, pending: Pending) -> bool {
        let (bytes, channel) = (pending.bytes, Channel::of(pending.level));
        self.queued_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.queued_events.fetch_add(1, Ordering::Relaxed);
        match self.sender.try_send(Message::Event(pending)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
                self.queued_events.fetch_sub(1, Ordering::Relaxed);
                self.count_loss(channel, 1, bytes as u64);
                false
            }
        }
    }

    /// Queues an event that the writer reports about itself (`log.policy`) from another thread. These events pass every gate: a
    /// policy that turns a class off must still be able to say that it did.
    pub(crate) fn enqueue_writer_event(
        &self,
        level: Level,
        name: &str,
        fields: Box<RawValue>,
    ) -> bool {
        // events: forwarded
        let mut pending = Pending::writer_event(level, name, fields);
        pending.bytes = pending.fields.get().len() + name.len();
        if self.queued_bytes.load(Ordering::Relaxed) + pending.bytes > self.queue_bytes {
            self.count_loss(Channel::of(level), 1, pending.bytes as u64);
            return false;
        }
        self.queue(pending)
    }

    /// The gate of this writer, shared with the producers of the host.
    pub(crate) fn gate_handle(&self) -> Arc<crate::log_policy::Gate> {
        Arc::clone(&self.gate)
    }

    /// The policy file that this writer follows, if it has one.
    pub fn policy_path(&self) -> Option<&Path> {
        self.policy_path.as_deref()
    }

    /// Adds events and bytes that a producer of this process refused before they reached the writer; the writer records
    /// them as a `log.dropped`.
    pub fn count_loss(&self, channel: Channel, events: u64, bytes: u64) {
        self.loss.events[channel.index()].fetch_add(events, Ordering::Relaxed);
        self.loss.bytes[channel.index()].fetch_add(bytes, Ordering::Relaxed);
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
    // A line has the class of its catalog entry; an event the catalog does not declare has none and says `undeclared`.
    let class = match pending.class {
        Some(class) => format!(",\"class\":\"{}\"", class.as_str()),
        None => String::new(),
    };
    let undeclared = if pending.class.is_none() {
        ",\"undeclared\":true"
    } else {
        ""
    };
    format!(
        "{{\"ts_us\":{},\"mono_ns\":{},\"seq\":{},\"level\":\"{}\"{},\"layer\":\"{}\",\"event\":{}{},\"fields\":{}{}{}}}",
        pending.ts_us,
        pending.mono_ns,
        seq,
        pending.level.name(),
        class,
        pending.layer,
        serde_json::to_string(&pending.event).expect("a string serializes"),
        cids,
        pending.fields.get(),
        undeclared,
        truncated
    )
}

/// One file of the writer: the main file of the channel `Other` or the debug file of the channel `Debug`.
struct LogFile {
    path: PathBuf,
    /// `None` until the first line of the channel is written: the debug file is created when the first debug or trace event
    /// arrives, so a run that stores no such event leaves no empty file.
    file: Option<File>,
    /// The bytes of the current file, written or waiting in the batch.
    size: u64,
    /// The number of the last generation that rotation closed; 0 before the first rotation.
    generation: u32,
    batch: String,
}

impl LogFile {
    fn new(path: PathBuf, file: Option<File>) -> LogFile {
        LogFile {
            path,
            file,
            size: 0,
            generation: 0,
            batch: String::new(),
        }
    }
}

fn open_log_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC)
        .open(path)
}

/// The bound of the files of the runs and what the writer needs to apply it.
struct Retention {
    directory: PathBuf,
    /// The run of the writer (`<role>-<boot>`), which is never removed.
    run: String,
    bytes: u64,
}

/// The two files of the writer with the sequence number of the last line, which runs across both.
struct Output {
    retention: Retention,
    files: [LogFile; 2],
    rotate_bytes: u64,
    /// The fields of `log.open`, written again at the start of every file.
    open_fields: String,
    seq: u64,
    on_write: Arc<Mutex<Option<WriteObserver>>>,
}

impl Output {
    fn new(
        main: File,
        main_path: PathBuf,
        debug_path: PathBuf,
        rotate_bytes: u64,
        retention: Retention,
        open: &Pending,
        on_write: Arc<Mutex<Option<WriteObserver>>>,
    ) -> Output {
        Output {
            retention,
            files: [
                LogFile::new(main_path, Some(main)),
                LogFile::new(debug_path, None),
            ],
            rotate_bytes,
            open_fields: open.fields.get().to_string(),
            seq: 0,
            on_write,
        }
    }

    /// Adds the line of an event with the next `seq` to the batch of a file.
    fn append(&mut self, channel: Channel, pending: &Pending) {
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
        let file = &mut self.files[channel.index()];
        file.size += text.len() as u64;
        file.batch.push_str(&text);
    }

    /// Adds an event to the file of its channel. A file that the line would take past the bound is closed first; the new file
    /// opens with `log.open` and the record of the rotation, so every file of the contract starts with `log.open` and `seq`
    /// continues.
    fn push(&mut self, pending: &Pending) {
        let channel = Channel::of(pending.level);
        if self.files[channel.index()].file.is_none() {
            match open_log_file(&self.files[channel.index()].path) {
                Ok(file) => {
                    self.files[channel.index()].file = Some(file);
                    let open = Pending::writer_event(
                        Level::Info,
                        "log.open",
                        RawValue::from_string(self.open_fields.clone())
                            .expect("the fields of log.open are JSON"),
                    );
                    self.append(channel, &open);
                }
                Err(error) => {
                    // The event is not written; its seq stays taken, so the audit shows the gap next to this report.
                    self.seq += 1;
                    eprintln!(
                        "event writer: {} cannot be written: {}: {error}",
                        pending.event,
                        self.files[channel.index()].path.display()
                    );
                    return;
                }
            }
        }
        let next = line(self.seq + 1, pending).len() as u64 + 1;
        let (size, bound) = (self.files[channel.index()].size, self.rotate_bytes);
        let mut rotated_file = false;
        if size > 0 && size + next > bound {
            self.flush_file(channel);
            if let Some(generation) = self.rotate(channel) {
                rotated_file = true;
                self.files[channel.index()].size = 0;
                let open = Pending::writer_event(
                    Level::Info,
                    "log.open",
                    RawValue::from_string(self.open_fields.clone())
                        .expect("the fields of log.open are JSON"),
                );
                self.append(channel, &open);
                let rotated = Pending::writer_event(
                    Level::Info,
                    "log.rotated",
                    to_raw_value(&json!({"bytes": size, "generation": generation}))
                        .expect("a json value serializes"),
                );
                self.append(channel, &rotated);
            }
        }
        self.append(channel, pending);
        // A rotation closes a file of the run, so the files may have passed the bound: the retention runs after the line that caused it.
        if rotated_file {
            self.prune();
        }
    }

    /// Removes the oldest runs while the files of the runs pass the bound and stores the event `log.pruned` for a pass that removed
    /// a file or left the files over the bound (docs/spec/logging.md#retention).
    fn prune(&mut self) {
        // The pass counts what is on disk; the batch that waits for the interval is not in it, which is at most one batch.
        let bound = self.retention.bytes;
        let (result, failures) = match crate::log_retention::prune_runs(
            &self.retention.directory,
            &self.retention.run,
            bound,
        ) {
            Ok(result) => (result, Vec::new()),
            Err((result, failures)) => (result, failures),
        };
        for failure in &failures {
            eprintln!("event writer: retention: {failure}");
        }
        if result.files == 0 && result.remaining <= bound {
            return;
        }
        let level = if result.remaining > bound {
            Level::Warn
        } else {
            Level::Info
        };
        let pending = Pending::writer_event(
            level,
            "log.pruned",
            to_raw_value(&result.fields(bound)).expect("a json value serializes"),
        );
        self.push(&pending);
    }

    /// Stores one `log.dropped` after the range of `seq` that the refused events would have had; `channel` is the channel of the
    /// refused events. The refused events had no `seq`; their numbers are skipped (docs/spec/logging.md#event).
    fn dropped(&mut self, events: u64, bytes: u64, reason: &str, channel: Channel) {
        if events == 0 {
            return;
        }
        let from = self.seq + 1;
        self.seq += events;
        let pending = Pending::writer_event(
            Level::Warn,
            "log.dropped",
            to_raw_value(&json!({
                "from_seq": from,
                "to_seq": self.seq,
                "count": events,
                "bytes": bytes,
                "reason": reason,
                "channel": channel.name(),
            }))
            .expect("a json value serializes"),
        );
        self.push(&pending);
    }

    /// Writes the batch of a file. A failed write is reported on the standard error; the writer keeps running for the next batch.
    fn flush_file(&mut self, channel: Channel) {
        let file = &mut self.files[channel.index()];
        if file.batch.is_empty() {
            return;
        }
        let Some(handle) = file.file.as_mut() else {
            return;
        };
        if let Err(error) = handle.write_all(file.batch.as_bytes()) {
            eprintln!("event writer: {error}");
        } else if let Some(observer) = self
            .on_write
            .lock()
            .expect("the observer of the writes")
            .as_ref()
        {
            observer(&file.path, file.size);
        }
        file.batch.clear();
    }

    /// Writes the batches of both files.
    fn flush(&mut self) {
        for channel in Channel::ALL {
            self.flush_file(channel);
        }
    }

    /// Closes the full file of a channel as the next generation (`<path>.<n>`, with n counted from 1 in the order of the
    /// rotations), opens a new file at the path, and moves the index file with the closed generation. No generation is removed or
    /// renamed. Returns the number of the generation, or `None` when a step failed (the failure is reported, the files are as
    /// they were, and the writer keeps the file it has).
    fn rotate(&mut self, channel: Channel) -> Option<u32> {
        let path = self.files[channel.index()].path.clone();
        let generation = self.files[channel.index()].generation + 1;
        let mut opened = None;
        let moved = soksak_sok::log_index::rotate_log_indexes(&path, generation, || {
            opened = Self::rotate_files(&path, generation);
            opened
                .as_ref()
                .map(drop)
                .ok_or_else(|| "the files were not rotated".to_string())
        });
        let next = opened?;
        if let Err(error) = moved {
            // The files rotated; only the index of the closed file is not complete, and a query builds it again.
            eprintln!("event writer: the index of the rotated file is not complete: {error}");
        }
        let file = &mut self.files[channel.index()];
        file.generation = generation;
        if let Some(full) = file.file.replace(next) {
            if let Err(error) = full.sync_all() {
                eprintln!("event writer: rotation could not sync the full file: {error}");
            }
        }
        Some(generation)
    }

    /// Renames the full file to generation `generation` and opens the new file; the failure of a step is reported here. When the new
    /// file cannot be opened the rename is undone, so the writer keeps writing the file at its path.
    fn rotate_files(path: &Path, generation: u32) -> Option<File> {
        let mut closed = path.as_os_str().to_os_string();
        closed.push(format!(".{generation}"));
        let closed = PathBuf::from(closed);
        if let Err(error) = std::fs::rename(path, &closed) {
            eprintln!(
                "event writer: rotation could not move {}: {error}",
                path.display()
            );
            return None;
        }
        match open_log_file(path) {
            Ok(file) => Some(file),
            Err(error) => {
                eprintln!(
                    "event writer: rotation could not open {}: {error}",
                    path.display()
                );
                if let Err(undo) = std::fs::rename(&closed, path) {
                    eprintln!(
                        "event writer: rotation could not undo the move of {}: {undo}",
                        path.display()
                    );
                }
                None
            }
        }
    }
}

/// The size of the buffer of one pull, and the passes of one pull: a flood of native events cannot hold the writer, and the
/// records left in the ring wait for the next pull.
const NATIVE_PULL_BYTES: usize = 256 << 10;
const NATIVE_PULL_PASSES: usize = 64;

/// The bytes of a native record before the name: the wall clock (8), the monotonic clock (8), the level (1), the class (1), the
/// length of the name (1) and the length of the cids (2).
const NATIVE_HEADER_BYTES: usize = 21;

/// Decodes the record at the start of `buffer`: a 4-byte length, then the time in microseconds (8 bytes), the monotonic
/// clock in nanoseconds (8), the level (1 byte), the class (1 byte), the length of the name (1 byte), the length of the cids
/// (2), the name, the cids as a list separated by commas and the fields as JSON text, in the byte order of the host.
/// Returns the number of bytes the record takes with the event or the reason it is refused. When the length itself is wrong
/// the number of bytes is 0, so the caller abandons the rest of the buffer. The class that the library gave is checked against
/// the catalog: a record of a declared event with another class is refused, so a producer that disagrees with the catalog is
/// counted and reported.
fn native_event_of(buffer: &[u8]) -> Result<(usize, Pending), (usize, String)> {
    if buffer.len() < 4 {
        return Err((
            0,
            format!(
                "{} bytes are left, which is less than a length",
                buffer.len()
            ),
        ));
    }
    let length = u32::from_ne_bytes(buffer[..4].try_into().expect("four bytes")) as usize;
    if length < NATIVE_HEADER_BYTES || 4 + length > buffer.len() {
        return Err((
            0,
            format!(
                "the length {length} does not fit {} bytes",
                buffer.len() - 4
            ),
        ));
    }
    let total = 4 + length;
    let body = &buffer[4..total];
    let level = match body[16] {
        0 => Level::Error,
        1 => Level::Warn,
        2 => Level::Info,
        3 => Level::Debug,
        4 => Level::Trace,
        other => return Err((total, format!("the level {other} is not defined"))),
    };
    let given = match Class::ALL.get(body[17] as usize) {
        Some(class) => *class,
        None => return Err((total, format!("the class {} is not defined", body[17]))),
    };
    let name_length = body[18] as usize;
    let cids_length = u16::from_ne_bytes(body[19..21].try_into().expect("two bytes")) as usize;
    if NATIVE_HEADER_BYTES + name_length + cids_length > body.len() {
        return Err((
            total,
            format!(
                "the name of {name_length} bytes and the cids of {cids_length} bytes do not fit the record"
            ),
        ));
    }
    let name =
        String::from_utf8_lossy(&body[NATIVE_HEADER_BYTES..NATIVE_HEADER_BYTES + name_length])
            .into_owned();
    if !name.starts_with("native.") {
        return Err((
            total,
            format!("the event {name:?} does not start with its layer \"native\""),
        ));
    }
    let cids_text = String::from_utf8_lossy(
        &body[NATIVE_HEADER_BYTES + name_length..NATIVE_HEADER_BYTES + name_length + cids_length],
    );
    let cids: Vec<String> = if cids_text.is_empty() {
        Vec::new()
    } else {
        cids_text.split(',').map(str::to_string).collect()
    };
    if let Some(bad) = cids.iter().find(|cid| !valid_cid(cid)) {
        return Err((
            total,
            format!("the cid {bad:?} of {name} is empty or holds a quote, a backslash or a control character"),
        ));
    }
    let mono_ns = u64::from_ne_bytes(body[8..16].try_into().expect("eight bytes"));
    if mono_ns == 0 {
        return Err((total, format!("the mono_ns of {name} is 0")));
    }
    let class = class_of(&name);
    if let Some(declared) = class {
        if declared != given {
            return Err((
                total,
                format!(
                    "the record of {name} has the class {}, and the catalog declares {}",
                    given.as_str(),
                    declared.as_str()
                ),
            ));
        }
    }
    let fields = &body[NATIVE_HEADER_BYTES + name_length + cids_length..];
    let fields = std::str::from_utf8(fields)
        // default: text that is not UTF-8 or not a JSON object becomes the error below, which names the event and the record.
        .ok()
        .filter(|text| text.starts_with('{'))
        // default: invalid fields become the error below, which names the event.
        .and_then(|text| RawValue::from_string(text.to_string()).ok())
        .ok_or_else(|| (total, format!("the fields of {name} are not a JSON object")))?;
    Ok((
        total,
        Pending {
            ts_us: u64::from_ne_bytes(body[..8].try_into().expect("eight bytes")),
            mono_ns,
            cids,
            layer: Cow::Borrowed("native"),
            level,
            class,
            event: name,
            fields,
            bytes: 0,
            truncated: None,
            placed: None,
        },
    ))
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
    pull: Option<Pull>,
    pull_loss: Option<PullLoss>,
    gate: Arc<crate::log_policy::Gate>,
) {
    out.push(&open);
    out.prune();
    // No event source reaches the writer from the native ring: a native thread must not call into this process's Rust
    // code, so the writer pulls at its batch interval and when it flushes.
    let mut pulled = Vec::new();
    let mut pull_native = |out: &mut Output| {
        let Some(pull) = pull.as_ref() else {
            return;
        };
        if pulled.is_empty() {
            pulled.resize(NATIVE_PULL_BYTES, 0u8);
        }
        let (mut refused, mut refused_bytes) = (0u64, 0u64);
        'passes: for _ in 0..NATIVE_PULL_PASSES {
            let n = match pull(&mut pulled) {
                Ok(0) => break,
                Ok(n) => n,
                Err(error) => {
                    eprintln!("event writer: the pull of the native ring failed: {error}");
                    break;
                }
            };
            let mut offset = 0;
            while offset < n {
                match native_event_of(&pulled[offset..n]) {
                    Ok((length, event)) => {
                        out.push(&event);
                        offset += length;
                    }
                    Err((length, error)) => {
                        // The rest of the buffer cannot be located after a record whose length is wrong.
                        eprintln!("event writer: a native record was refused: {error}");
                        refused += 1;
                        refused_bytes += (n - offset) as u64;
                        if length == 0 {
                            continue 'passes;
                        }
                        offset += length;
                    }
                }
            }
        }
        // A record that cannot be decoded has no level, so its loss is counted in the channel `Other`.
        out.dropped(
            refused,
            refused_bytes,
            "a native record was refused",
            Channel::Other,
        );
        if let Some(pull_loss) = pull_loss.as_ref() {
            for channel in Channel::ALL {
                let (events, bytes) = pull_loss(channel);
                out.dropped(events, bytes, "the native ring was full", channel);
            }
        }
    };
    let record_loss = |out: &mut Output| {
        for channel in Channel::ALL {
            let events = loss.events[channel.index()].swap(0, Ordering::Relaxed);
            let bytes = loss.bytes[channel.index()].swap(0, Ordering::Relaxed);
            out.dropped(events, bytes, "the queue was full", channel);
        }
        // The events that the gate refused are reported with the exact count for each class and level.
        for (class, level, count) in gate.take_counts() {
            match to_raw_value(
                &json!({"class": class.as_str(), "level": level.name(), "count": count}),
            ) {
                Ok(fields) => out.push(&Pending::writer_event(Level::Info, "log.gated", fields)),
                Err(error) => eprintln!("event writer: log.gated cannot be written: {error}"),
            }
        }
    };
    let take = |out: &mut Output, pending: &Pending| {
        queued_bytes.fetch_sub(pending.bytes, Ordering::Relaxed);
        queued_events.fetch_sub(1, Ordering::Relaxed);
        out.push(pending);
    };
    // Takes every event that is queued now, then the loss counted so far, and writes them.
    let mut drain = |out: &mut Output| -> Option<Message> {
        pull_native(out);
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
