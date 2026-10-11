//! The record of a run of the tool (docs/spec/cli.md#event-log): the event file in the configuration folder that the command
//! targets holds the command with its result, and a panic with its stack.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, Once, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::event_bounds::cut_text;
use crate::event_log::{EventLog, Level, Options as WriterOptions};
use crate::replay::set_run_log;
use crate::routine::{guard, set_recorder, Panic, PANIC_STATUS};
use crate::{command, config_dir_of, Error, Options};

/// How long a run waits for the writer to put its last events on disk.
const FLUSH_DEADLINE: Duration = Duration::from_secs(2);

/// The bound of the arguments and of the error text of a command event (docs/spec/logging.md#bounds).
const CALL_TEXT_BYTES: usize = 1024;

/// The layer and the role of the tool in the event contract, and the bounds of its writer (docs/spec/logging.md#bounds). A run
/// of the tool emits at most a handful of events (`log.open`, `sok.command`, `sok.panic`), so the file is not rotated.
const EVENT_LAYER: &str = "sok";
const EVENT_ROLE: &str = "sok";
const EVENT_QUEUE_EVENTS: usize = 1024;
const EVENT_QUEUE_BYTES: usize = 1 << 20;
const EVENT_BATCH_INTERVAL: Duration = Duration::from_millis(100);

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

/// Starts the writer of the tool in `logs/sok-<boot>.jsonl` of the configuration folder `config`; the boot identifier is
/// the start time in seconds and the process identifier.
pub fn start_tool_event_log(config: &Path) -> Result<EventLog, String> {
    // default: a clock before the epoch is a defect of the machine; the boot then starts at 0 and the audit refuses the lines.
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    EventLog::start(WriterOptions {
        directory: config.join("logs"),
        role: EVENT_ROLE.into(),
        boot: format!("{seconds}-{}", std::process::id()),
        layer: EVENT_LAYER,
        clock: monotonic_ns,
        spawn: |body| Ok(crate::routine::spawn_named("event-log-writer", body)),
        queue_events: EVENT_QUEUE_EVENTS,
        queue_bytes: EVENT_QUEUE_BYTES,
        batch_interval: EVENT_BATCH_INTERVAL,
        rotate_bytes: 0,
        pull: None,
        policy_path: None,
        prune: None,
    })
}

/// One run of the tool: it takes the arguments and the streams and returns the exit status. `run` is the command of the
/// executable.
pub type Command<'a> = &'a dyn Fn(&[String], &mut dyn Write, &mut dyn Write, &Options) -> i32;

/// The configuration folder that the arguments target: the value of `--config-dir` before any `--`, or the default folder of
/// this application.
fn target_config_dir(args: &[String], options: &Options) -> Result<std::path::PathBuf, String> {
    let mut values = HashMap::new();
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        if let Some(value) = args[index].strip_prefix("--config-dir=") {
            values.insert("config-dir".to_string(), value.to_string());
            break;
        }
        if args[index] == "--config-dir" && index + 1 < args.len() {
            values.insert("config-dir".to_string(), args[index + 1].clone());
            break;
        }
        index += 1;
    }
    config_dir_of(&values, options).map_err(|error| match error {
        Error::Usage(message) | Error::Failed(message) => message,
    })
}

/// Passes everything to its stream and keeps the first line of what was written, up to `CALL_TEXT_BYTES`.
struct FirstLine<'a> {
    stream: &'a mut dyn Write,
    text: Vec<u8>,
    ended: bool,
}

impl Write for FirstLine<'_> {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if !self.ended {
            let end = data.iter().position(|byte| *byte == b'\n');
            let line = match end {
                Some(end) => &data[..end],
                None => data,
            };
            self.text.extend_from_slice(line);
            self.ended = end.is_some();
        }
        self.stream.write(data)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// The command of one run, stored once whichever entrance ends the run.
struct Record {
    log: Arc<EventLog>,
    args: Vec<String>,
    started: Instant,
    recorded: Mutex<bool>,
}

impl Record {
    fn finish(&self, status: i32, error_text: &str) {
        // default: the lock guards only the flag that the command was stored, and a panic of another thread must not stop this record.
        let mut recorded = self.recorded.lock().unwrap_or_else(PoisonError::into_inner);
        if *recorded {
            return;
        }
        *recorded = true;
        let joined = self.args.join(" ");
        let (text, mut cut) = cut_text(&joined, CALL_TEXT_BYTES);
        // default: a run without a command word (for example `--help`) records the empty name, as the Go tool does.
        let name = command::command_word(&self.args).unwrap_or("");
        let mut fields = json!({
            "name": name,
            "args": text,
            "micros": self.started.elapsed().as_micros() as u64,
            "ok": status == 0,
            "status": status,
        });
        let mut level = Level::Debug;
        if status != 0 {
            level = Level::Warn;
            let (error, error_cut) = cut_text(error_text, CALL_TEXT_BYTES);
            fields["error"] = json!(error);
            cut = cut || error_cut;
        }
        if cut {
            fields["truncated"] = json!(true);
        }
        self.log.emit(level, "sok.command", &fields);
    }

    fn panicked(&self, panic: &Panic) {
        self.log.emit(
            Level::Error,
            "sok.panic",
            &json!({"name": panic.name, "text": panic.text, "stack": panic.stack}),
        );
    }
}

/// Runs `command` and records it: it starts the event file of the targeted configuration folder, runs the command, stores a
/// panic of the command with its stack as the exit status `PANIC_STATUS`, stores the command with its result, and flushes the
/// file. An event file that cannot be started is reported on the standard error and the command runs without it.
pub fn logged(
    args: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
    command: Command,
) -> i32 {
    let started = Instant::now();
    let log = target_config_dir(args, options).and_then(|config| start_tool_event_log(&config));
    let log = match log {
        Ok(log) => Arc::new(log),
        Err(error) => {
            // When the report cannot be written to standard error, there is nowhere to report it, so it is reported with exit status 3 (docs/spec/cli.md).
            if writeln!(stderr, "sok: event log: {error}").is_err() {
                return 3;
            }
            return command(args, stdout, stderr, options);
        }
    };
    set_run_log(Some(log.clone()));
    let record = Arc::new(Record {
        log,
        args: args.to_vec(),
        started,
        recorded: Mutex::new(false),
    });
    {
        let record = record.clone();
        set_recorder(Some(Arc::new(move |panic: &Panic| {
            record.panicked(panic);
            record.finish(PANIC_STATUS, &format!("sok: panic: {}", panic.text));
            if let Err(error) = record.log.flush(FLUSH_DEADLINE) {
                eprintln!("sok: event log: {error}");
            }
        })));
    }
    let mut captured = FirstLine {
        stream: stderr,
        text: Vec::new(),
        ended: false,
    };
    let outcome = guard(|| command(args, stdout, &mut captured, options));
    set_recorder(None);
    let mut status = match outcome {
        Ok(status) => status,
        Err(panic) => {
            record.panicked(&panic);
            if write!(captured, "sok: panic: {}\n{}", panic.text, panic.stack).is_err() {
                3
            } else {
                PANIC_STATUS
            }
        }
    };
    record.finish(status, &String::from_utf8_lossy(&captured.text));
    if let Err(error) = record.log.flush(FLUSH_DEADLINE) {
        if writeln!(captured.stream, "sok: event log: {error}").is_err() {
            status = 3;
        }
    }
    set_run_log(None);
    record.log.close();
    status
}

/// Runs `run` with the record of the tool.
pub fn run_logged(
    args: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
) -> i32 {
    logged(args, stdout, stderr, options, &crate::run)
}
