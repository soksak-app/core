//! The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
//! copies or serializes the value, so the cost of recording does not depend on the size of the value.

/// The bound in bytes of the arguments and of the error text that a call event stores.
pub const CALL_TEXT_BYTES: usize = 1024;

/// The largest size in bytes of the fields of an event; an event over it is stored cut.
pub const EVENT_FIELDS_LIMIT_BYTES: usize = 1 << 20;
/// The number of bytes of the fields text that a cut event keeps.
pub const EVENT_HEAD_BYTES: usize = 4096;
/// The bounds of each list of pending messages of a sidecar (replies and closes).
pub const PENDING_MESSAGES: usize = 1024;
pub const PENDING_BYTES: usize = 4 << 20;

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

/// Returns the JSON text of `value` cut to `limit` bytes on a character boundary, and whether it was cut. The walk of the
/// value ends when the text reaches the limit, so only the part that is kept is read and copied, and a value of any size
/// costs the same. A text that fits equals the compact serialization of `value`.
pub fn bounded_json(value: &serde_json::Value, limit: usize) -> (String, bool) {
    let mut text = String::new();
    let stopped = write_bounded(value, &mut text, limit);
    if stopped || text.len() > limit {
        return (cut_text(&text, limit).0, true);
    }
    (text, false)
}

/// Appends the JSON text of `value` to `text` and returns whether the walk stopped because the text reached `limit`.
fn write_bounded(value: &serde_json::Value, text: &mut String, limit: usize) -> bool {
    use serde_json::Value;
    if text.len() >= limit {
        return true;
    }
    match value {
        Value::String(string) => {
            let (head, cut) = cut_text(string, limit);
            text.push_str(&Value::String(head).to_string());
            cut
        }
        Value::Array(items) => {
            text.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    text.push(',');
                }
                if write_bounded(item, text, limit) {
                    return true;
                }
            }
            text.push(']');
            false
        }
        Value::Object(map) => {
            text.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    text.push(',');
                }
                let (head, cut) = cut_text(key, limit);
                text.push_str(&Value::String(head).to_string());
                if cut {
                    return true;
                }
                text.push(':');
                if write_bounded(item, text, limit) {
                    return true;
                }
            }
            text.push('}');
            false
        }
        scalar => {
            text.push_str(&scalar.to_string());
            false
        }
    }
}
