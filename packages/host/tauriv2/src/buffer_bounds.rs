//! The bounded buffers of the host (docs/spec/logging.md#bounds). A buffer that sheds a message refuses the newest one, so the
//! messages already held keep their order, reports the refusal to its caller, and stores the event `host.buffer.dropped`.

use serde_json::json;

use crate::bounds::{PENDING_BYTES, PENDING_MESSAGES};
use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::sidecars::QueuedLine;

/// A list of messages that wait for a full write queue. It holds at most `PENDING_MESSAGES` messages and `PENDING_BYTES`
/// bytes.
#[derive(Default)]
pub(crate) struct PendingLines {
    lines: Vec<QueuedLine>,
    bytes: usize,
}

impl PendingLines {
    /// Appends `line`. When the bound refuses it, the list stays as it was and the result is the bound that was reached, as
    /// `<n> messages` or `<n> bytes`.
    pub(crate) fn add(&mut self, line: Vec<u8>) -> Result<(), String> {
        if self.lines.len() >= PENDING_MESSAGES {
            return Err(format!("{PENDING_MESSAGES} messages"));
        }
        if self.bytes + line.len() > PENDING_BYTES {
            return Err(format!("{PENDING_BYTES} bytes"));
        }
        self.bytes += line.len();
        self.lines.push(QueuedLine::new(line));
        Ok(())
    }

    /// Returns the held messages in the order they were added and empties the list.
    pub(crate) fn take(&mut self) -> Vec<QueuedLine> {
        self.bytes = 0;
        std::mem::take(&mut self.lines)
    }
}

/// Stores the event `host.buffer.dropped` for one refused message of `buffer`: its size in bytes and the bound that refused
/// it (`<n> messages`, `<n> bytes` or `<n> requests`).
pub(crate) fn record_buffer_drop(buffer: &str, bytes: usize, limit: &str) {
    emit_host(
        Level::Warn,
        "host.buffer.dropped",
        json!({"buffer": buffer, "count": 1, "bytes": bytes, "reason": format!("the buffer holds {limit}")}),
    );
}
