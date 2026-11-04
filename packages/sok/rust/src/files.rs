//! The text of file errors (docs/spec/cli.md). Both implementations report the same failure with the same text.

use std::fmt::Display;

/// Writes the failure of a file operation on path as "<path>: <reason>". The reason is the operating system error text and starts with a lowercase letter.
/// It omits the "(os error N)" that the standard library appends.
pub(crate) fn file_error(path: impl Display, error: &std::io::Error) -> String {
    format!("{path}: {}", os_reason(error))
}

/// The reason text of an operating system error. It starts with a lowercase letter and omits the "(os error N)" that the standard library appends.
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

/// Removes the temporary path that a failed operation left. When the removal fails, it appends that failure to the original error as "; cleanup <path>: <reason>".
/// A path that no longer exists leaves nothing, so it counts as removed.
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
