//! 애플리케이션 로그(docs/spec/hosts.md#application-log).

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::platform;

/// 시각이 없는 글 기록 `<level> <layer> <place>: <text>` 이다(docs/spec/diagnostics.md#forms). place 는 연산이나 대상의
/// 이름이고 text 의 줄바꿈은 두 글자 `\n` 으로 쓴다. 기록 하나는 한 줄이다.
pub fn entry_line(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) -> String {
    format!(
        "{level} {layer} {place}: {}",
        text.to_string().replace('\n', "\\n")
    )
}

/// 쓰는 시각을 맨 앞에 둔 기록 한 줄이다.
pub fn record_line(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) -> String {
    let now = crate::performance::timestamp(std::time::SystemTime::now())
        .expect("clock is before the Unix epoch");
    format!("{now} {}", entry_line(level, layer, place, text))
}

/// 시각이 없는 기록 줄 entry 에 쓰는 시각을 붙여 표준 오류에 한 번의 write 로 쓴다.
pub fn log_entry(entry: &str) {
    let now = crate::performance::timestamp(std::time::SystemTime::now())
        .expect("clock is before the Unix epoch");
    eprintln!("{now} {entry}");
}

/// 페이지가 `report` 호출로 보낸 기록을 layer page 의 시각이 없는 기록 줄로 만든다. level 이 error 나 info 가 아니거나, place 가
/// 비었거나 구분자 `: ` 나 줄바꿈을 담으면 거부한다. 조용히 바꿔 쓰지 않는다.
pub fn page_entry(
    level: &str,
    place: &str,
    text: impl std::fmt::Display,
) -> Result<String, String> {
    if level != "error" && level != "info" {
        return Err(format!("report level must be error or info, not {level:?}"));
    }
    if place.is_empty() || place.contains(": ") || place.contains(['\r', '\n']) {
        return Err(format!(
            "report where must be a name without a separator or a line feed: {place:?}"
        ));
    }
    Ok(entry_line(level, "page", place, text))
}

/// 호스트의 오류 기록에서 시각을 뺀 줄이다. place 는 실패한 연산이나 대상이고 text 는 실패 내용이다.
pub fn error_line(place: &str, text: impl std::fmt::Display) -> String {
    entry_line("error", "host", place, text)
}

/// 기록 하나를 표준 오류에 한 번의 write 로 쓴다. 표준 오류는 start_application_log 뒤에 애플리케이션 로그다.
/// 표준 오류에 쓰지 못하면 eprint! 처럼 panic 한다. 그 실패를 알릴 다른 곳이 없다.
pub fn log_record(level: &str, layer: &str, place: &str, text: impl std::fmt::Display) {
    let line = format!("{}\n", record_line(level, layer, place, text));
    eprint!("{line}");
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

/// 설정 디렉터리 config 의 애플리케이션 로그 경로다.
pub fn application_log_path(config: &Path) -> PathBuf {
    config.join("logs").join("application.log")
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

/// 설정 디렉터리 config 의 애플리케이션 로그를 열고 실행의 첫 줄을 쓴 뒤 그 파일을 프로세스의 표준
/// 오류로 만든다. 설정 디렉터리의 process lock 을 잡은 뒤 한 번 부른다.
pub fn start_application_log(config: &Path, identifier: &str) -> Result<(), String> {
    let platform = platform::current()?;
    let mut file = open_log(&application_log_path(config))
        .map_err(|error| format!("application log: {error}"))?;
    let now = crate::performance::timestamp(std::time::SystemTime::now())
        .map_err(|error| format!("application log: {error}"))?;
    writeln!(
        file,
        "{now} {}",
        entry_line(
            "info",
            "host",
            "run",
            format!("{identifier} pid {}", std::process::id())
        )
    )
    .map_err(|error| format!("application log: {error}"))?;
    // 표준 오류는 복제한 descriptor 를 가지므로 연 파일은 이 함수가 끝날 때 닫힌다.
    platform
        .replace_standard_error(&file)
        .map_err(|error| format!("application log: {error}"))?;
    platform
        .install_fatal_handlers()
        .map_err(|error| format!("application log: {error}"))?;
    install_panic_hook();
    Ok(())
}

/// Writes each panic of the host as `error host panic: <file>:<line>: <message>` before the previous hook prints its message
/// (docs/spec/diagnostics.md). The standard error is the application log once [`start_application_log`] ran.
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
        previous(info);
    }));
}
