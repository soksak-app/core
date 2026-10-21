//! Application log (docs/spec/hosts.md#application-log).

use std::fs::File;
use std::path::{Path, PathBuf};

use crate::platform;

/// A record before it is stored: the level (`error` or `info`), the layer (`page`, `host`, `native`, `sidecar`), the place (the
/// name of the operation or the object) and the text. The record is stored as an event of the event log ([`Entry::log`]), and
/// its line `<level> <layer> <place>: <text>` is the view that the transcript of a window shows ([`Entry::line`]).
pub struct Entry {
    pub level: String,
    pub layer: String,
    pub place: String,
    pub text: String,
}

impl Entry {
    pub fn new(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) -> Entry {
        Entry {
            level: level.to_string(),
            layer: layer.to_string(),
            place: place.to_string(),
            text: text.to_string(),
        }
    }

    /// The line `<level> <layer> <place>: <text>` (docs/spec/diagnostics.md#forms). A line feed in the text is written as
    /// the two characters `\n`, so the line is one line.
    pub fn line(&self) -> String {
        entry_line(&self.level, &self.layer, &self.place, &self.text)
    }

    /// Stores the record as an event of the event log.
    pub fn log(&self) {
        log_record(&self.level, &self.layer, &self.place, &self.text);
    }
}

/// The line `<level> <layer> <place>: <text>` of a record; a line feed in the text is written as `\n`.
pub fn entry_line(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) -> String {
    format!(
        "{level} {layer} {place}: {}",
        text.to_string().replace('\n', "\\n")
    )
}

/// A host error line without its time. place is the failed operation or its target and text is the failure.
pub fn error_line(place: &str, text: impl std::fmt::Display) -> String {
    entry_line("error", "host", place, text)
}

/// Stores a record as an event of the writer of the host (event_record.rs).
pub fn log_record(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) {
    crate::event_record::emit_record(level, layer, place, text.to_string());
}

/// The record line of a window's diagnostic record, which is also written to the application log. The diagnostic record
/// goes only to the connections that enabled it, so without this record the line is lost when no connection exists.
pub fn transcript_entry(label: &str, line: &str) -> Entry {
    Entry::new("info", "host", &format!("transcript {label}"), line)
}

/// Writes one error record of the host.
pub fn log_error(place: &str, text: impl std::fmt::Display) {
    log_record("error", "host", place, text);
}

/// Writes one observation record of the host. An observation records an expected state and is not a failure.
pub fn log_info(place: &str, text: impl std::fmt::Display) {
    log_record("info", "host", place, text);
}

/// Writes one warning record of the host. A warning records a loss or a degradation that the host recovers from.
pub fn log_warn(place: &str, text: impl std::fmt::Display) {
    log_record("warn", "host", place, text);
}

/// Writes the error of result as the error line of place when result failed. It is used by an operation whose result
/// cannot be returned to the caller.
pub fn log_failure(place: &str, result: Result<(), String>) {
    if let Err(error) = result {
        log_error(place, error);
    }
}

/// The size at which the log file rotates to the previous generation (docs/spec/diagnostics.md#files). More records are
/// better, so the size is large enough to cover one session.
pub const ROTATE_BYTES: u64 = 100 * 1024 * 1024;

/// The number of previous generations that are kept.
pub const GENERATIONS: u32 = 5;

/// Rotates path to the previous generation path.1, moves each previous generation back by one, and deletes the last
/// generation.
pub fn rotate_generations(path: &Path) -> Result<(), String> {
    let numbered = |generation: u32| {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".{generation}"));
        PathBuf::from(name)
    };
    let last = numbered(GENERATIONS);
    match std::fs::remove_file(&last) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove {}: {error}", last.display())),
    }
    for generation in (1..GENERATIONS).rev() {
        let from = numbered(generation);
        match std::fs::rename(&from, numbered(generation + 1)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("rotate {}: {error}", from.display())),
        }
    }
    std::fs::rename(path, numbered(1))
        .map_err(|error| format!("rotate {}: {error}", path.display()))
}

/// The log path that receives the standard error of the persistent service program. basename is the name of the
/// executable.
pub fn service_log_path(config: &Path, basename: &str) -> PathBuf {
    config.join("logs").join(format!("{basename}.log"))
}

/// Opens the log file path for appending with mode 0600. A file of 10 MB or more is first moved to path.1 and replaces
/// the previous generation. Call it only when no other process writes to that file.
pub fn open_log(path: &Path) -> Result<File, String> {
    let platform = platform::current()?;
    if let Some(directory) = path.parent() {
        platform
            .create_private_directories(directory)
            .map_err(|error| format!("create logs directory: {error}"))?;
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() >= ROTATE_BYTES => rotate_generations(path)?,
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect {}: {error}", path.display())),
    }
    platform
        .append_private_file(path)
        .map_err(|error| format!("open {error}"))
}

/// Opens the stderr file of this run, `logs/host-<boot>.stderr`, makes it the standard error of the process and of its
/// children, installs the fatal handlers and the panic hook, and stores the run record (docs/spec/logging.md#files). The file
/// holds only what no writer of the contract writes: the crash output of the runtime and the fatal lines of the native
/// library. Call it once, after the process lock of the configuration directory is held. The panic hook is installed by
/// [`install_panic_hook`] at the start of the process, not here.
pub fn start_standard_error(config: &Path, identifier: &str) -> Result<(), String> {
    let platform = platform::current()?;
    let file = open_log(&crate::event_log::standard_error_path(config))
        .map_err(|error| format!("standard error file: {error}"))?;
    // The standard error holds a duplicate of the descriptor, so the opened file is closed when this function ends.
    platform
        .replace_standard_error(&file)
        .map_err(|error| format!("standard error file: {error}"))?;
    platform
        .install_fatal_handlers()
        .map_err(|error| format!("standard error file: {error}"))?;
    log_info("run", format!("{identifier} pid {}", std::process::id()));
    Ok(())
}

/// Stores each panic of the host as the event `host.panic` before the previous hook prints its message, and starts the
/// thread that ends the process once the event is stored (`routine::record_panic`). The hook never waits for the writer. A
/// panic before the writer exists stays in the start buffer until the writer opens, and the thread that ends the process
/// waits for the writer for a bounded time. The standard error is the stderr file once [`start_standard_error`] ran.
pub fn install_panic_hook() {
    crate::routine::start_panic_ender();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = match info.payload().downcast_ref::<&str>() {
            Some(text) => text.to_string(),
            None => match info.payload().downcast_ref::<String>() {
                Some(text) => text.clone(),
                None => "a payload that is not text".to_string(),
            },
        };
        let location = match info.location() {
            Some(location) => format!("{}:{}", location.file(), location.line()),
            None => "an unknown location".to_string(),
        };
        crate::routine::record_panic(&location, &message);
        previous(info);
    }));
}
