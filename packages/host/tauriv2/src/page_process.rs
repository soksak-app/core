//! The error line of the end of a WebContent process (docs/spec/diagnostics.md).

/// The place and the text of the error line that the host writes when the WebContent process of the window ends.
pub fn page_process_ended(window: &str) -> (String, String) {
    ("page process".to_string(), format!("{window}: terminated"))
}
