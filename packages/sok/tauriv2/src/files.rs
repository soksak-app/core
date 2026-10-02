//! 파일 오류의 문구(docs/spec/cli.md). 두 구현은 같은 실패를 같은 문구로 보고한다.

use std::fmt::Display;

/// path 의 파일 작업 실패를 "<path>: <이유>" 로 적는다. 이유는 운영체제 오류 문구이며 소문자로 시작한다.
/// 표준 라이브러리가 붙이는 "(os error N)" 은 적지 않는다.
pub(crate) fn file_error(path: impl Display, error: &std::io::Error) -> String {
    format!("{path}: {}", os_reason(error))
}

/// 운영체제 오류의 이유 문구. 소문자로 시작하며 표준 라이브러리가 붙이는 "(os error N)" 은 적지 않는다.
pub(crate) fn os_reason(error: &std::io::Error) -> String {
    let text = error.to_string();
    let reason = match text.rfind(" (os error ") {
        Some(at) if error.raw_os_error().is_some() => &text[..at],
        _ => text.as_str(),
    };
    let mut chars = reason.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect::<String>(),
        None => String::new(),
    }
}

/// 실패한 작업이 남긴 임시 경로를 remove 로 지운다. 지우지 못하면 원래 오류에 그 실패를 "; cleanup <경로>: <이유>"
/// 로 덧붙인다. 이미 없는 경로는 남은 것이 없으므로 지운 것과 같다.
pub(crate) fn with_cleanup(
    error: String,
    temp: &std::path::Path,
    remove: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
) -> String {
    match remove(temp) {
        Ok(()) => error,
        Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup) => format!("{error}; cleanup {}", file_error(temp.display(), &cleanup)),
    }
}
