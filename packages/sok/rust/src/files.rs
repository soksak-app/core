//! The text of file errors (docs/spec/cli.md). Both implementations report the same failure with the same text.

use std::fmt::Display;
use std::path::PathBuf;

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

/// Writes bytes for a message: each byte from 0x20 to 0x7e other than `\` as itself, `\` as `\\`, and every other byte as `\x`
/// with two lowercase hexadecimal digits (docs/spec/agent-conversation.md#refusals).
pub(crate) fn escaped(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len());
    for &byte in bytes {
        match byte {
            b'\\' => text.push_str("\\\\"),
            0x20..=0x7e => text.push(byte as char),
            _ => text.push_str(&format!("\\x{byte:02x}")),
        }
    }
    text
}

/// Returns the path when its bytes are UTF-8, so that every later message writes it as it is, and otherwise its escaped bytes.
pub(crate) fn utf8_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.to_str().is_some() {
        Ok(path)
    } else {
        Err(escaped(path.as_os_str().as_encoded_bytes()))
    }
}
