//! 파일 오류의 문구(docs/spec/cli.md). 두 구현은 같은 실패를 같은 문구로 보고한다.

use std::fmt::Display;

/// path 의 파일 작업 실패를 "<path>: <이유>" 로 적는다. 이유는 운영체제 오류 문구이며 소문자로 시작한다.
/// 표준 라이브러리가 붙이는 "(os error N)" 은 적지 않는다.
pub(crate) fn file_error(path: impl Display, error: &std::io::Error) -> String {
    let text = error.to_string();
    let reason = match text.rfind(" (os error ") {
        Some(at) if error.raw_os_error().is_some() => &text[..at],
        _ => text.as_str(),
    };
    let mut chars = reason.chars();
    let reason = match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect::<String>(),
        None => String::new(),
    };
    format!("{path}: {reason}")
}
