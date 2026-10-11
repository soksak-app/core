//! The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
//! copies or serializes the value, so the cost of recording does not depend on the size of the value.

/// The bound in bytes of the arguments and of the error text that a call event stores.
pub const CALL_TEXT_BYTES: usize = 1024;

/// Returns the first `limit` bytes of `text`, backed up to a character boundary, and whether `text` was longer. Only the
/// bytes that are kept are copied.
pub fn cut_text(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}
