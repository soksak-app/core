//! The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
//! copies or serializes the value, so the cost of recording does not depend on the size of the value.

/// The bound in bytes of the arguments and of the error text that a call event stores.
pub const CALL_TEXT_BYTES: usize = 1024;

pub use soksak_sok::event_bounds::{
    EVENT_FIELDS_LIMIT_BYTES, EVENT_HEAD_BYTES, Fields, bounded_json, bounded_serialize, cut_text,
};

/// The bounds of each list of pending messages of a sidecar (replies and closes).
pub const PENDING_MESSAGES: usize = 1024;
pub const PENDING_BYTES: usize = 4 << 20;
/// The bound of the start buffer of the records of the host in bytes, besides `START_BUFFER_RECORDS`.
pub const START_BUFFER_BYTES: usize = 4 << 20;
/// The bounds of the place and of the text of a record in an event.
pub const RECORD_PLACE_BYTES: usize = 1024;
pub const RECORD_TEXT_BYTES: usize = 8192;
/// The most subscription changes that wait for the page for one topic of the endpoint.
pub const ENDPOINT_TOPIC_CHANGES: usize = 256;
