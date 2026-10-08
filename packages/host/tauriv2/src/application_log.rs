//! 애플리케이션 로그(docs/spec/hosts.md#application-log).

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::platform;

/// 오류 한 줄 `error: <place>: <text>` 이다. 페이지의 오류 줄과 같은 형식이므로 창 검사가 호스트의 실패도 오류로
/// 읽는다. place 는 실패한 연산이나 대상이고 text 는 실패 내용이다.
pub fn error_line(place: &str, text: impl std::fmt::Display) -> String {
    format!("error: {place}: {text}")
}

/// 오류 줄 하나를 표준 오류에 한 번의 write 로 쓴다. 표준 오류는 start_application_log 뒤에 애플리케이션 로그다.
/// 표준 오류에 쓰지 못하면 eprint! 처럼 panic 한다. 그 실패를 알릴 다른 곳이 없다.
pub fn log_error(place: &str, text: impl std::fmt::Display) {
    let line = format!("{}\n", error_line(place, text));
    eprint!("{line}");
}

/// result 가 실패이면 그 오류를 place 의 오류 줄로 쓴다. 결과를 호출자에게 돌려줄 수 없는 작업이 쓴다.
pub fn log_failure(place: &str, result: Result<(), String>) {
    if let Err(error) = result {
        log_error(place, error);
    }
}

/// 로그 파일을 열 때 이전 세대로 넘기는 크기다.
const ROTATE_BYTES: u64 = 10 * 1024 * 1024;

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
        Ok(metadata) if metadata.len() >= ROTATE_BYTES => {
            let mut earlier = path.as_os_str().to_owned();
            earlier.push(".1");
            std::fs::rename(path, &earlier)
                .map_err(|error| format!("rotate {}: {error}", path.display()))?;
        }
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
        "{now} application log: {identifier} pid {}",
        std::process::id()
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

/// Writes each panic of the host as `error: panic: <file>:<line>: <message>` before the previous hook prints its message
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
