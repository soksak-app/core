//! The event writer of the hosts and of the tool (docs/spec/logging.md#writers).
//!
//! A producer pushes an event to a queue bounded by count and by bytes without waiting. One writer thread assigns `seq`,
//! serializes the JSON line, writes batches, rotates the files when it has a bound, and records the events that the queue
//! refused as `log.dropped`. The levels `error`, `warn` and `info` go to the main file and `debug` and `trace` to the debug
//! file, and `seq` runs across both. The policy of the event log (`log_policy`) is the gate of the producers. The hosts and the tool start this writer with their own layer, role, clock and thread
//! entrance; a process with a source of events that cannot call into the writer (the native ring of a host) gives the
//! writer a `Pull`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use serde_json::value::{RawValue, to_raw_value};

use crate::event_bounds::{EVENT_FIELDS_LIMIT_BYTES, EVENT_HEAD_BYTES, Fields, cut_text};
use crate::event_classes::{Class, class_of};
use crate::log_policy::Gate;

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
    /// The name of the level in the line of an event.
    pub fn name(self) -> &'static str {
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

    /// The position of the channel in `ALL`.
    pub fn index(self) -> usize {
        match self {
            Channel::Other => 0,
            Channel::Debug => 1,
        }
    }
}

/// What the writer passes to a `Pull`: it takes the events of the source and the losses of the source.
pub trait PullSink {
    /// Stores an event of the source as it is.
    fn accept(&mut self, event: RelayedEvent);
    /// Stores one `log.dropped` for `events` events of `bytes` bytes of a channel that the source lost, with the reason.
    fn lost(&mut self, events: u64, bytes: u64, reason: &str, channel: Channel);
}

/// Takes the events of a source that cannot call into the writer. It runs on the thread of the writer at the batch interval
/// and when the writer flushes.
pub type Pull = Box<dyn FnMut(&mut dyn PullSink) + Send>;

/// The retention hook of a writer (docs/spec/logging.md#retention). It runs on the thread of the writer after `log.open` and after
/// each rotation; when it removed a file or left the files over the bound it returns the level and the fields of the event
/// `log.pruned`, which the writer then stores.
pub type Prune = Box<dyn FnMut() -> Option<(Level, Box<RawValue>)> + Send>;

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
    /// The size at which the writer starts a new file. Each of the two files of the writer (the main file and the debug file)
    /// rotates on its own: the file that was full becomes the next generation (`.1` is the first), and rotation removes no
    /// generation. It is 0 for a writer that does not rotate.
    pub rotate_bytes: u64,
    /// The source of events that cannot call into the writer; `None` when the process has none.
    pub pull: Option<Pull>,
    /// The policy file that the writer follows (`<config-dir>/log-policy.json`); `None` for a writer that has none.
    pub policy_path: Option<PathBuf>,
    /// The retention of the files of the runs; `None` for a writer that has none.
    pub prune: Option<Prune>,
}

/// One event waiting for the writer. `seq` is assigned when the writer serializes it.
struct Pending {
    ts_us: u64,
    /// The monotonic clock in nanoseconds (docs/spec/logging.md#event).
    mono_ns: u64,
    /// The correlation identifiers of the inputs the event belongs to; none for most events.
    cids: Vec<String>,
    layer: Cow<'static, str>,
    /// The time origin of the document that wrote an event of the layer page or plugin; `None` for another layer.
    page: Option<String>,
    level: Level,
    event: String,
    /// The class that the catalog declares for the event, or lifecycle for an undeclared event of the layer plugin; `None`
    /// for another name that the catalog does not declare.
    class: Option<Class>,
    /// Whether the line marks the event `undeclared`: a name that no catalog declares (docs/spec/logging.md#event).
    undeclared: bool,
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
    fn writer_event(
        layer: &'static str,
        clock: fn() -> u64,
        level: Level,
        event: &str,
        fields: Box<RawValue>,
    ) -> Pending {
        let class = class_of(event);
        Pending {
            ts_us: now_us(),
            mono_ns: clock(),
            cids: Vec::new(),
            layer: Cow::Borrowed(layer),
            page: None,
            level,
            event: event.into(),
            undeclared: class.is_none(),
            class,
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

/// The interval between two reports of the counts of the gate (docs/spec/logging.md#policy).
const GATED_REPORT_INTERVAL: Duration = Duration::from_secs(1);

/// The loss that the queue counted since the writer last recorded it, for each channel.
struct Loss {
    events: [AtomicU64; 2],
    bytes: [AtomicU64; 2],
    /// The largest number of events waiting in the queue at a refusal since the writer last recorded the loss, for each channel.
    depth: [AtomicU64; 2],
}

/// Why the queue did not take an event: it had no room, or the policy does not store the event (docs/spec/logging.md#policy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    Queue,
    Policy,
}

impl Refusal {
    /// The reason that a refused placed event states in its error.
    fn reason(self) -> &'static str {
        match self {
            Refusal::Queue => "its queue was full",
            Refusal::Policy => "the policy does not store it",
        }
    }
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
    debug_path: PathBuf,
    /// The policy in force and the count of the events that it refused.
    gate: Arc<Gate>,
    policy_path: Option<PathBuf>,
    boot: String,
    layer: &'static str,
    clock: fn() -> u64,
    writer: Mutex<Option<JoinHandle<()>>>,
    /// The classes that the catalogs of the installed plugins declare (docs/spec/logging.md#plugin-catalogs).
    plugin_classes: RwLock<HashMap<String, Class>>,
}

/// The layers of the event contract that another layer of a process relays (docs/spec/logging.md#event).
const LAYERS: [&str; 5] = ["native", "host", "page", "plugin", "sidecar"];

/// Whether `cid` can be stored as a correlation identifier: it is not empty and holds no quote, no backslash and no
/// control character, so it is written as the text of a JSON string without escaping.
/// The events that pass every gate, so the policy never refuses them (docs/spec/logging.md#policy): `page.start`, which the
/// first module emits before the page policy reaches its gate; host stall records, the only record of a main-thread stall;
/// `host.view.killed`, which reports an ended view's unsent batch; and `host.test.start`/`host.test.end`, whose flushed
/// positions delimit a diagnostic window check under every selected policy.
pub fn passes_every_gate(event: &str) -> bool {
    matches!(
        event,
        "page.start"
            | "host.stall"
            | "host.stall.sampled"
            | "host.stall.dump"
            | "host.view.killed"
            | "host.test.start"
            | "host.test.end"
    )
}

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
    /// The time origin of the document that wrote the event; an event of the layer page or plugin requires it, and another
    /// layer has none (docs/spec/logging.md#event).
    pub page: Option<String>,
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
        // default: a lock that a panicking thread poisoned still holds the write observer, which the call replaces; the
        // panic hook records the panic.
        *self.on_write.lock().unwrap_or_else(PoisonError::into_inner) = Some(observer);
    }

    /// Creates the folder (mode 0700) and the file (mode 0600, created new), writes `log.open` and starts the writer thread.
    pub fn start(options: Options) -> Result<EventLog, String> {
        let system = crate::platform::current()?;
        system.prepare_log_directory(&options.directory)?;
        let path = options
            .directory
            .join(format!("{}-{}.jsonl", options.role, options.boot));
        let debug_path = options
            .directory
            .join(format!("{}-{}.debug.jsonl", options.role, options.boot));
        // The standard library opens the file close-on-exec, so a child process does not inherit it.
        let file = system.create_log_file(&path)?;
        let on_write: Arc<Mutex<Option<WriteObserver>>> = Arc::new(Mutex::new(None));
        let (sender, receiver) = sync_channel(options.queue_events + RESERVED_FOR_REQUESTS);
        let queued_events = Arc::new(AtomicUsize::new(0));
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let loss = Arc::new(Loss {
            events: [AtomicU64::new(0), AtomicU64::new(0)],
            bytes: [AtomicU64::new(0), AtomicU64::new(0)],
            depth: [AtomicU64::new(0), AtomicU64::new(0)],
        });
        // events: forwarded
        let open = Pending::writer_event(
            options.layer,
            options.clock,
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
        let gate = Arc::new(Gate::new());
        let writer = {
            let queued_bytes = Arc::clone(&queued_bytes);
            let queued_events = Arc::clone(&queued_events);
            let loss = Arc::clone(&loss);
            let interval = options.batch_interval;
            let path_for_writer = path.clone();
            let debug_path_for_writer = debug_path.clone();
            let observer = Arc::clone(&on_write);
            let rotate_bytes = options.rotate_bytes;
            let layer = options.layer;
            let clock = options.clock;
            let pull = options.pull;
            let prune = options.prune;
            let gate = Arc::clone(&gate);
            (options.spawn)(Box::new(move || {
                write_loop(
                    Output::new(
                        file,
                        path_for_writer,
                        debug_path_for_writer,
                        rotate_bytes,
                        layer,
                        clock,
                        &open,
                        observer,
                        prune,
                    ),
                    receiver,
                    queued_bytes,
                    queued_events,
                    loss,
                    interval,
                    open,
                    pull,
                    gate,
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
            debug_path,
            gate,
            policy_path: options.policy_path,
            boot: options.boot,
            layer: options.layer,
            clock: options.clock,
            writer: Mutex::new(Some(writer)),
            plugin_classes: RwLock::new(HashMap::new()),
        })
    }

    /// Replaces the classes of the plugin events, which the host reads from the catalogs of the enabled installed plugins
    /// when it starts and after each change of the installed plugins.
    pub fn set_plugin_classes(&self, classes: HashMap<String, Class>) {
        *self
            .plugin_classes
            .write()
            // default: the map holds only whole values, so a panic of another thread leaves no partial state.
            .unwrap_or_else(PoisonError::into_inner) = classes;
    }

    /// The class that the catalog declares for `event`: the core catalog, or the catalog of the installed plugin of a plugin
    /// event; `None` for a name that no catalog declares.
    fn class(&self, event: &str) -> Option<Class> {
        class_of(event).or_else(|| {
            self.plugin_classes
                .read()
                // default: the map holds only whole values, so a panic of another thread leaves no partial state.
                .unwrap_or_else(PoisonError::into_inner)
                .get(event)
                .copied()
        })
    }

    /// The class that the gate and the line give an event, and whether the line marks it `undeclared`: the class of the catalog;
    /// for an event of the layer plugin that no catalog declares, lifecycle with the marker (docs/spec/logging.md#principles).
    fn classify(&self, event: &str, layer: &str) -> (Option<Class>, bool) {
        match self.class(event) {
            Some(class) => (Some(class), false),
            None if layer == "plugin" => (Some(Class::Lifecycle), true),
            None => (None, true),
        }
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
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(Channel::of(level), 1, event.len() as u64);
            return Err(format!(
                "the event writer refused {event} because its queue was full"
            ));
        }
        if let Err(refusal) = self.enqueue(
            now_us(),
            (self.clock)(),
            Vec::new(),
            Cow::Borrowed(self.layer),
            None,
            level,
            event,
            fields,
            Some(placed),
        ) {
            return Err(format!(
                "the event writer refused {event} because {}",
                refusal.reason()
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
            self.count_loss(Channel::of(level), 1, event.len() as u64);
            eprintln!(
                "event writer: {event} has the correlation identifier {bad:?}, which is empty or holds a quote, a backslash or a control character"
            );
            return false;
        }
        // A closed gate serializes nothing; an event the catalog does not declare has no class and no gate, and an event
        // that passes every gate is never refused by the gate.
        if let Some(class) = self.class(event)
            && !passes_every_gate(event)
            && !self.gate(class, level)
        {
            return false;
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
            (self.clock)(),
            cids.to_vec(),
            Cow::Borrowed(self.layer),
            None,
            level,
            event,
            fields,
            None,
        )
        .is_ok()
    }

    /// Queues an event that another layer of this process produced, with the time and the layer it carries. The event
    /// name must start with the layer, so the name and the layer cannot disagree. Returns an error for a layer outside
    /// the contract or a name that does not start with it, and false, with the loss counted, when the queue has no room.
    pub fn emit_relayed(&self, relayed: RelayedEvent) -> Result<bool, String> {
        let RelayedEvent {
            ts_us,
            mono_ns,
            layer,
            page,
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
        let document_layer = layer == "page" || layer == "plugin";
        if document_layer != page.as_deref().is_some_and(|page| !page.is_empty()) {
            // default: an event without a page prints the empty text, as the Go writer prints it.
            let named = page.as_deref().unwrap_or("");
            return Err(format!(
                "the event {event} of the layer {layer} names the page {named:?}; only an event of the layer page or plugin names one, and it must"
            ));
        }
        // An event that passes every gate is named by passes_every_gate (docs/spec/logging.md#policy).
        let (class, _) = self.classify(event, layer);
        if let Some(class) = class
            && !passes_every_gate(event)
            && !self.gate(class, level)
        {
            return Ok(false);
        }
        if self.queued_events.load(Ordering::Relaxed) >= self.queue_events {
            self.count_loss(Channel::of(level), 1, event.len() as u64);
            return Ok(false);
        }
        Ok(self
            .enqueue(
                ts_us,
                mono_ns,
                cids,
                Cow::Owned(layer.to_string()),
                page,
                level,
                event,
                fields,
                None,
            )
            .is_ok())
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &self,
        ts_us: u64,
        mono_ns: u64,
        cids: Vec<String>,
        layer: Cow<'static, str>,
        page: Option<String>,
        level: Level,
        event: &str,
        fields: Fields,
        placed: Option<SyncSender<u64>>,
    ) -> Result<(), Refusal> {
        // Fields that the producer cut at the bound are stored as they are; the others are cut here when they are over it.
        let (fields, truncated) = match fields.truncated {
            Some(size) => (fields.text, Some(size)),
            None => cap_fields(fields.text),
        };
        let bytes = fields.get().len() + event.len();
        if self.queued_bytes.load(Ordering::Relaxed) + bytes > self.queue_bytes {
            self.count_loss(Channel::of(level), 1, bytes as u64);
            return Err(Refusal::Queue);
        }
        // A closed gate stores nothing and counts the event; an event that passes every gate is named by passes_every_gate.
        let (class, undeclared) = self.classify(event, &layer);
        if let Some(class) = class
            && !passes_every_gate(event)
            && !self.gate(class, level)
        {
            return Err(Refusal::Policy);
        }
        let pending = Pending {
            ts_us,
            mono_ns,
            cids,
            layer,
            page,
            level,
            event: event.to_string(),
            class,
            undeclared,
            fields,
            bytes,
            truncated,
            placed,
        };
        self.queue(pending)
    }

    /// Hands a counted event to the writer; a full queue refuses it and counts the loss.
    fn queue(&self, pending: Pending) -> Result<(), Refusal> {
        let (bytes, channel) = (pending.bytes, Channel::of(pending.level));
        self.queued_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.queued_events.fetch_add(1, Ordering::Relaxed);
        match self.sender.try_send(Message::Event(pending)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.queued_bytes.fetch_sub(bytes, Ordering::Relaxed);
                self.queued_events.fetch_sub(1, Ordering::Relaxed);
                self.count_loss(channel, 1, bytes as u64);
                Err(Refusal::Queue)
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
        let mut pending = Pending::writer_event(self.layer, self.clock, level, name, fields);
        pending.bytes = pending.fields.get().len() + name.len();
        if self.queued_bytes.load(Ordering::Relaxed) + pending.bytes > self.queue_bytes {
            self.count_loss(Channel::of(level), 1, pending.bytes as u64);
            return false;
        }
        self.queue(pending).is_ok()
    }

    /// Queues the event `log.closed` that the writer reports when a host process ends (docs/spec/logging.md#self-reports).
    /// `cause` is `exit`, `exit-request` or `signal`, and `signal` is the number of the termination signal of the cause
    /// `signal`. Returns false when the queue has no room.
    pub fn record_closed(&self, cause: &str, signal: Option<i32>) -> bool {
        let fields = match signal {
            Some(signal) => json!({"cause": cause, "signal": signal}),
            None => json!({"cause": cause}),
        };
        let fields = to_raw_value(&fields).expect("a json value serializes");
        self.enqueue_writer_event(Level::Info, "log.closed", fields)
    }

    /// The gate of this writer, shared with the producers of the process.
    pub fn gate_handle(&self) -> Arc<Gate> {
        Arc::clone(&self.gate)
    }

    /// The policy file that this writer follows, if it has one.
    pub fn policy_path(&self) -> Option<&Path> {
        self.policy_path.as_deref()
    }

    /// Adds events and bytes of a channel that a producer of this process refused before they reached the writer; the writer
    /// records them as a `log.dropped` that names the channel and the depth of the queue at the refusal.
    pub fn count_loss(&self, channel: Channel, events: u64, bytes: u64) {
        self.loss.events[channel.index()].fetch_add(events, Ordering::Relaxed);
        self.loss.bytes[channel.index()].fetch_add(bytes, Ordering::Relaxed);
        let depth = self.queued_events.load(Ordering::Relaxed) as u64;
        self.loss.depth[channel.index()].fetch_max(depth, Ordering::Relaxed);
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
    // A line has the class of its catalog entry; an event the catalog does not declare has none and says `undeclared`.
    let class = match pending.class {
        Some(class) => format!(",\"class\":\"{}\"", class.as_str()),
        None => String::new(),
    };
    let undeclared = if pending.undeclared {
        ",\"undeclared\":true"
    } else {
        ""
    };
    // The document that wrote an event of the layer page or plugin follows the layer.
    let page = match &pending.page {
        Some(page) => format!(
            ",\"page\":{}",
            serde_json::to_string(page).expect("a string serializes")
        ),
        None => String::new(),
    };
    format!(
        "{{\"ts_us\":{},\"mono_ns\":{},\"seq\":{},\"level\":\"{}\"{},\"layer\":\"{}\"{},\"event\":{}{},\"fields\":{}{}{}}}",
        pending.ts_us,
        pending.mono_ns,
        seq,
        pending.level.name(),
        class,
        pending.layer,
        page,
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
    // The platform opens the file with private access and close-on-exec, so a child process does not inherit it.
    crate::platform::current()
        .and_then(|system| system.append_log_file(path))
        .map_err(std::io::Error::other)
}

/// The two files of the writer with the sequence number of the last line, which runs across both.
struct Output {
    files: [LogFile; 2],
    rotate_bytes: u64,
    layer: &'static str,
    clock: fn() -> u64,
    /// The fields of `log.open`, written again at the start of every file.
    open_fields: String,
    seq: u64,
    on_write: Arc<Mutex<Option<WriteObserver>>>,
    prune: Option<Prune>,
}

impl Output {
    #[allow(clippy::too_many_arguments)]
    fn new(
        main: File,
        main_path: PathBuf,
        debug_path: PathBuf,
        rotate_bytes: u64,
        layer: &'static str,
        clock: fn() -> u64,
        open: &Pending,
        on_write: Arc<Mutex<Option<WriteObserver>>>,
        prune: Option<Prune>,
    ) -> Output {
        Output {
            files: [
                LogFile::new(main_path, Some(main)),
                LogFile::new(debug_path, None),
            ],
            rotate_bytes,
            layer,
            clock,
            open_fields: open.fields.get().to_string(),
            seq: 0,
            on_write,
            prune,
        }
    }

    /// The event of the layer of the writer that the writer itself produces.
    fn own(&self, level: Level, event: &str, fields: Box<RawValue>) -> Pending {
        // events: forwarded
        Pending::writer_event(self.layer, self.clock, level, event, fields)
    }

    /// The `log.open` that starts every file, with the fields of the run.
    fn open_event(&self) -> Pending {
        self.own(
            Level::Info,
            "log.open",
            RawValue::from_string(self.open_fields.clone())
                .expect("the fields of log.open are JSON"),
        )
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
                    let open = self.open_event();
                    self.append(channel, &open);
                }
                Err(error) => {
                    let path = self.files[channel.index()].path.display().to_string();
                    eprintln!(
                        "event writer: {} cannot be written: {path}: {error}",
                        pending.event
                    );
                    // The event is not written. Its seq is the gap, and log.dropped names the gap with the cause in the main file
                    // (docs/spec/logging.md#event). A log.dropped that cannot be opened has no further record.
                    if pending.event == "log.dropped" {
                        self.seq += 1;
                    } else {
                        let bytes = (pending.event.len() + pending.fields.get().len()) as u64;
                        self.dropped(
                            1,
                            bytes,
                            &format!("{path} cannot be opened: {error}"),
                            channel,
                            None,
                        );
                    }
                    return;
                }
            }
        }
        let next = line(self.seq + 1, pending).len() as u64 + 1;
        let size = self.files[channel.index()].size;
        let mut rotated_file = false;
        if self.rotate_bytes > 0 && size > 0 && size + next > self.rotate_bytes {
            self.flush_file(channel);
            if let Some(generation) = self.rotate(channel) {
                rotated_file = true;
                self.files[channel.index()].size = 0;
                let open = self.open_event();
                self.append(channel, &open);
                let rotated = self.own(
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

    /// Runs the retention of the writer and stores the event `log.pruned` for a pass that removed a file or left the files over the
    /// bound (docs/spec/logging.md#retention).
    fn prune(&mut self) {
        let Some(prune) = self.prune.as_mut() else {
            return;
        };
        if let Some((level, fields)) = prune() {
            let pending = self.own(level, "log.pruned", fields);
            self.push(&pending);
        }
    }

    /// Stores one `log.dropped` after the range of `seq` that the refused events would have had; `channel` is the channel of the
    /// refused events and `queued` the depth of the writer queue at their refusal, when the writer counted them.
    /// The refused events had no `seq`; their numbers are skipped (docs/spec/logging.md#event).
    fn dropped(
        &mut self,
        events: u64,
        bytes: u64,
        reason: &str,
        channel: Channel,
        queued: Option<u64>,
    ) {
        if events == 0 {
            return;
        }
        let from = self.seq + 1;
        self.seq += events;
        let mut fields = json!({
            "from_seq": from,
            "to_seq": self.seq,
            "count": events,
            "bytes": bytes,
            "reason": reason,
            "channel": channel.name(),
        });
        if let Some(queued) = queued {
            fields["queued"] = json!(queued);
        }
        let pending = self.own(
            Level::Warn,
            "log.dropped",
            to_raw_value(&fields).expect("a json value serializes"),
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
            // default: a lock that a panicking thread poisoned still holds the write observer, which the writer reads;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
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
        let moved = crate::log_index::rotate_log_indexes(&path, generation, || {
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
        if let Some(full) = file.file.replace(next)
            && let Err(error) = full.sync_all()
        {
            eprintln!("event writer: rotation could not sync the full file: {error}");
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

impl PullSink for Output {
    fn accept(&mut self, event: RelayedEvent) {
        let class = class_of(&event.event);
        self.push(&Pending {
            undeclared: class.is_none(),
            ts_us: event.ts_us,
            mono_ns: event.mono_ns,
            cids: event.cids,
            layer: Cow::Owned(event.layer),
            page: event.page,
            level: event.level,
            event: event.event,
            class,
            fields: event.fields.text,
            bytes: 0,
            truncated: event.fields.truncated,
            placed: None,
        });
    }

    fn lost(&mut self, events: u64, bytes: u64, reason: &str, channel: Channel) {
        self.dropped(events, bytes, reason, channel, None);
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
    gate: Arc<Gate>,
) {
    out.push(&open);
    out.prune();
    // No event source reaches the writer from the native ring: a native thread must not call into this process's Rust
    // code, so the writer pulls at its batch interval and when it flushes.
    let mut pull_source = |out: &mut Output| {
        if let Some(pull) = pull.as_mut() {
            pull(out);
        }
    };
    let record_loss = |out: &mut Output| {
        for channel in Channel::ALL {
            let events = loss.events[channel.index()].swap(0, Ordering::Relaxed);
            let bytes = loss.bytes[channel.index()].swap(0, Ordering::Relaxed);
            let queued = loss.depth[channel.index()].swap(0, Ordering::Relaxed);
            out.dropped(events, bytes, "the queue was full", channel, Some(queued));
        }
    };
    // The events that the gate refused are reported with the exact count for each class and level, each second and at a
    // flush or a stop (`force`): a report at each batch interval stored more events than a narrow policy removed.
    let mut gated_at = Instant::now();
    let mut report_gated = |out: &mut Output, force: bool| {
        if !force && gated_at.elapsed() < GATED_REPORT_INTERVAL {
            return;
        }
        gated_at = Instant::now();
        for (class, level, count) in gate.take_counts() {
            let fields = to_raw_value(
                &json!({"class": class.as_str(), "level": level.name(), "count": count}),
            )
            .expect("a json value serializes");
            let pending = out.own(Level::Info, "log.gated", fields);
            out.push(&pending);
        }
    };
    let take = |out: &mut Output, pending: &Pending| {
        queued_bytes.fetch_sub(pending.bytes, Ordering::Relaxed);
        queued_events.fetch_sub(1, Ordering::Relaxed);
        out.push(pending);
    };
    // Takes every event that is queued now, then the loss counted so far, and writes them; `force` also reports the counts
    // of the gate.
    let mut drain = |out: &mut Output, force: bool| -> Option<Message> {
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
        report_gated(out, force);
        out.flush();
        request
    };
    // The batch is written when the interval since the last write ends, also while events keep arriving: a wait that
    // restarted at each event would write nothing while events came faster than the interval.
    let mut due = Instant::now() + interval;
    // A flush or a stop that a write at the end of an interval found queued behind the events.
    let mut queued: Option<Message> = None;
    loop {
        let received = match queued.take() {
            Some(message) => Ok(message),
            None => receiver.recv_timeout(due.saturating_duration_since(Instant::now())),
        };
        let message = match received {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                // The interval ended: write what has gathered, and handle a request that was queued behind it.
                due = Instant::now() + interval;
                match drain(&mut out, false) {
                    Some(request) => request,
                    None => continue,
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                drain(&mut out, true);
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
                // Events that keep arriving after the interval ended do not postpone its write.
                if Instant::now() >= due {
                    due = Instant::now() + interval;
                    queued = drain(&mut out, false);
                }
            }
            Message::Flush(done) => {
                let following = drain(&mut out, true);
                if done.send(()).is_err() {
                    eprintln!("event writer: the flush was answered after its deadline");
                }
                if matches!(following, Some(Message::Stop)) {
                    return;
                }
            }
            Message::Stop => {
                drain(&mut out, true);
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "event_log_lock_test.rs"]
mod lock_test;

#[cfg(test)]
#[path = "event_log_loss_test.rs"]
mod loss_tests;
