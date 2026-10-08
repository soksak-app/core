//! The error line of the end of a WebContent process (docs/spec/diagnostics.md).

/// The place and the text of the error line that the host writes when the WebContent process of the window ends, or
/// `None` while the host quits, which ends the process on purpose.
pub fn page_process_ended(window: &str, quitting: bool) -> Option<(String, String)> {
    (!quitting).then(|| ("page process".to_string(), format!("{window}: terminated")))
}
