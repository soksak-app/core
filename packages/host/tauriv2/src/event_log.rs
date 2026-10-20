//! The event writer of the host (docs/spec/logging.md#writers).
//!
//! The queue, the bounds, `seq`, the batch, the loss record, the flush, the rotation, the files split by level, the class of the
//! line and the gate of the policy are the writer of the tool crate (`soksak_sok::event_log`), which the tool starts with its own
//! layer and role. The host adds the layer, the clock and the entrance of its threads, the pull of the native ring with the
//! decoding of its records, the retention of the files of the runs, the policy file, and the start in the `logs` folder of the
//! configuration folder.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::value::{RawValue, to_raw_value};
use soksak_sok::event_classes::{Class, class_of};
use soksak_sok::event_log::{Options as WriterOptions, PullSink};

pub use soksak_sok::event_log::{Channel, EventLog, Level, RelayedEvent, SCHEMA, valid_cid};

use crate::bounds::Fields;

/// How a writer of the host is started.
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

/// The pull of the native ring, called on the writer thread.
pub type Pull = Box<dyn Fn(&mut [u8]) -> Result<usize, String> + Send>;
/// The loss of the native ring in a channel since the last call, as events and bytes.
pub type PullLoss = Box<dyn Fn(Channel) -> (u64, u64) + Send>;

/// The bounds of the writer of a host: events and bytes of serialized fields waiting for the batch interval.
const HOST_QUEUE_EVENTS: usize = 8192;
const HOST_QUEUE_BYTES: usize = 16 << 20;
const HOST_BATCH_INTERVAL: Duration = Duration::from_millis(100);
const HOST_ROTATE_BYTES: u64 = 100 << 20;

/// The identifier of this run, shared by the files of the run: the start time in seconds and the process identifier.
pub(crate) fn process_boot() -> &'static str {
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

/// Starts the writer of the host in `logs/` of the configuration folder; the boot identifier is the start time in
/// seconds and the process identifier.
pub fn start_host(config: &Path) -> Result<EventLog, String> {
    let system = crate::platform::current()?;
    // A platform that cannot pull the native ring fails here, at the start, instead of running without native events.
    system.pull_native_events(&mut [0u8; 1])?;
    system.set_event_boot(process_boot())?;
    system.observe_activity()?;
    start(Options {
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
                    eprintln!("event writer: the loss of the native ring cannot be read: {error}");
                    (0, 0)
                }
            }
        })),
    })
}

/// Ends the event log of a process that is shutting down: `flush_observers` stores the tail of the counted sources of the native
/// observers in the native ring, and the flush writes it with everything that is queued. A failed flush of the observers does not
/// skip the flush of the writer; the result names the failure of each.
pub fn flush_event_log(
    log: &EventLog,
    flush_observers: impl FnOnce() -> Result<(), String>,
    deadline: Duration,
) -> Result<(), String> {
    let observers = flush_observers().map_err(|error| format!("flush native observers: {error}"));
    let writer = log.flush(deadline);
    match (observers, writer) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(observers), Err(writer)) => Err(format!("{observers}; {writer}")),
    }
}

/// Starts the writer of the layer `host`. A writer of the host always rotates and always applies the retention.
pub fn start(options: Options) -> Result<EventLog, String> {
    if options.rotate_bytes == 0 {
        return Err("event writer: rotate_bytes must be positive".into());
    }
    if options.retention_bytes == 0 {
        return Err("event writer: retention_bytes must be positive".into());
    }
    let pull = options
        .pull
        .map(|pull| native_puller(pull, options.pull_loss));
    let prune = retention(
        options.directory.clone(),
        format!("{}-{}", options.role, options.boot),
        options.retention_bytes,
    );
    EventLog::start(WriterOptions {
        directory: options.directory,
        role: options.role,
        boot: options.boot,
        layer: "host",
        clock: monotonic_ns,
        spawn: |body| {
            std::thread::Builder::new()
                .name("event-log-writer".into())
                .spawn(body)
                .map_err(|e| format!("event writer thread: {e}"))
        },
        queue_events: options.queue_events,
        queue_bytes: options.queue_bytes,
        batch_interval: options.batch_interval,
        rotate_bytes: options.rotate_bytes,
        pull,
        policy_path: options.policy_path,
        prune: Some(prune),
    })
}

/// The retention hook of the writer: it removes the oldest runs while the files of the runs pass `bytes` (the run named `run`
/// is never removed) and returns the event `log.pruned` for a pass that removed a file or left the files over the bound.
fn retention(directory: PathBuf, run: String, bytes: u64) -> soksak_sok::event_log::Prune {
    Box::new(move || {
        // The pass counts what is on disk; the batch that waits for the interval is not in it, which is at most one batch.
        let (result, failures) = match crate::log_retention::prune_runs(&directory, &run, bytes) {
            Ok(result) => (result, Vec::new()),
            Err((result, failures)) => (result, failures),
        };
        for failure in &failures {
            eprintln!("event writer: retention: {failure}");
        }
        if result.files == 0 && result.remaining <= bytes {
            return None;
        }
        let level = if result.remaining > bytes {
            Level::Warn
        } else {
            Level::Info
        };
        Some((
            level,
            to_raw_value(&result.fields(bytes)).expect("a json value serializes"),
        ))
    })
}

/// The `Pull` of the writer for a native ring: it moves the records of the ring into a buffer, decodes each into an event,
/// and reports a refused record and the loss of the ring.
fn native_puller(pull: Pull, pull_loss: Option<PullLoss>) -> soksak_sok::event_log::Pull {
    let mut pulled = Vec::new();
    Box::new(move |sink: &mut dyn PullSink| {
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
                        sink.accept(event);
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
        sink.lost(
            refused,
            refused_bytes,
            "a native record was refused",
            Channel::Other,
        );
        if let Some(pull_loss) = pull_loss.as_ref() {
            for channel in Channel::ALL {
                let (events, bytes) = pull_loss(channel);
                sink.lost(events, bytes, "the native ring was full", channel);
            }
        }
    })
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
fn native_event_of(buffer: &[u8]) -> Result<(usize, RelayedEvent), (usize, String)> {
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
            format!(
                "the cid {bad:?} of {name} is empty or holds a quote, a backslash or a control character"
            ),
        ));
    }
    let mono_ns = u64::from_ne_bytes(body[8..16].try_into().expect("eight bytes"));
    if mono_ns == 0 {
        return Err((total, format!("the mono_ns of {name} is 0")));
    }
    if let Some(declared) = class_of(&name)
        && declared != given
    {
        return Err((
            total,
            format!(
                "the record of {name} has the class {}, and the catalog declares {}",
                given.as_str(),
                declared.as_str()
            ),
        ));
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
        RelayedEvent {
            ts_us: u64::from_ne_bytes(body[..8].try_into().expect("eight bytes")),
            mono_ns,
            layer: "native".into(),
            page: None,
            level,
            event: name,
            cids,
            fields: Fields::whole(fields),
        },
    ))
}
