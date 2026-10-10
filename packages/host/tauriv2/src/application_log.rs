//! 애플리케이션 로그(docs/spec/hosts.md#application-log).

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

/// 호스트의 오류 기록에서 시각을 뺀 줄이다. place 는 실패한 연산이나 대상이고 text 는 실패 내용이다.
pub fn error_line(place: &str, text: impl std::fmt::Display) -> String {
    entry_line("error", "host", place, text)
}

/// Stores a record as an event of the writer of the host (event_record.rs).
pub fn log_record(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) {
    crate::event_record::emit_record(level, layer, place, text.to_string());
}

/// 창 label 의 진단 기록 줄 line 이 애플리케이션 로그에도 쓰는 기록 줄이다. 진단 기록은 그것을 켠 연결에만 가므로 이
/// 기록이 없으면 연결이 없을 때 그 줄이 사라진다.
pub fn transcript_entry(label: &str, line: &str) -> Entry {
    Entry::new("info", "host", &format!("transcript {label}"), line)
}

/// 호스트의 오류 기록 하나를 쓴다.
pub fn log_error(place: &str, text: impl std::fmt::Display) {
    log_record("error", "host", place, text);
}

/// 호스트의 관측 기록 하나를 쓴다. 관측은 예상된 상태를 기록하며 실패가 아니다.
pub fn log_info(place: &str, text: impl std::fmt::Display) {
    log_record("info", "host", place, text);
}

/// result 가 실패이면 그 오류를 place 의 오류 줄로 쓴다. 결과를 호출자에게 돌려줄 수 없는 작업이 쓴다.
pub fn log_failure(place: &str, result: Result<(), String>) {
    if let Err(error) = result {
        log_error(place, error);
    }
}

/// 로그 파일이 이전 세대로 넘어가는 크기다(docs/spec/diagnostics.md#files). 기록은 많을수록 좋으므로 한 세션을 덮을 만큼
/// 크게 둔다.
pub const ROTATE_BYTES: u64 = 100 * 1024 * 1024;

/// 남기는 이전 세대의 수다.
pub const GENERATIONS: u32 = 5;

/// path 를 이전 세대 path.1 로 넘기고, 이전 세대는 하나씩 뒤로 옮기며, 마지막 세대는 지운다.
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

/// 영속 서비스 program 의 표준 오류를 받는 로그 경로다. basename 은 실행 파일 이름이다.
pub fn service_log_path(config: &Path, basename: &str) -> PathBuf {
    config.join("logs").join(format!("{basename}.log"))
}

/// 로그 파일 path 를 mode 0600 의 덧붙이기로 연다. 10 MB 이상인 파일은 먼저 path.1 로 옮겨 이전
/// 세대를 대체한다. 그 파일에 쓰는 다른 프로세스가 없을 때만 부른다.
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
/// library. Call it once, after the process lock of the configuration directory is held.
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
    install_panic_hook();
    log_info("run", format!("{identifier} pid {}", std::process::id()));
    Ok(())
}

/// Writes each panic of the host as `error host panic: <file>:<line>: <message>` before the previous hook prints its message
/// (docs/spec/diagnostics.md). The standard error is the stderr file once [`start_standard_error`] ran.
pub fn install_panic_hook() {
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
        log_error("panic", format!("{location}: {message}"));
        if let Err(error) = crate::event_record::flush_records(std::time::Duration::from_secs(2)) {
            eprintln!("event writer: the record of the panic is not stored: {error}");
        }
        previous(info);
    }));
}
