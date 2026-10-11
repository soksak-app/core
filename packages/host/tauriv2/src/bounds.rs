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
/// The bound of the start buffer of the records of the host in bytes, besides `START_BUFFER_RECORDS`.
pub const START_BUFFER_BYTES: usize = 4 << 20;
/// The bounds of the place and of the text of a record in an event.
pub const RECORD_PLACE_BYTES: usize = 1024;
pub const RECORD_TEXT_BYTES: usize = 8192;
/// The most subscription changes that wait for the page for one topic of the endpoint.
pub const ENDPOINT_TOPIC_CHANGES: usize = 256;

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

/// The writer that a serialization of a value writes to. It keeps the first `limit` bytes and refuses the write that goes
/// over the bound, which ends the serialization: the cost does not depend on the size of the value.
struct Limited {
    text: Vec<u8>,
    limit: usize,
    /// The number of bytes that the serialization had written when it stopped, or 0 when it finished.
    produced: usize,
}

impl std::io::Write for Limited {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.text.len() + data.len() > self.limit {
            let room = self.limit - self.text.len();
            self.text.extend_from_slice(&data[..room]);
            self.produced = self.limit + (data.len() - room);
            return Err(std::io::Error::other("the text reached the bound"));
        }
        self.text.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Serializes `value` as JSON and stops at `limit` bytes. The first result is the text, cut on a character boundary when
/// the serialization stopped, and the second is the number of bytes that the serialization had written when it stopped,
/// which is greater than `limit`, or `None` when the whole text fits. A text that fits equals the compact serialization of
/// `value`.
pub fn bounded_serialize<T: serde::Serialize + ?Sized>(
    value: &T,
    limit: usize,
) -> Result<(String, Option<usize>), String> {
    let mut writer = Limited {
        text: Vec::new(),
        limit,
        produced: 0,
    };
    match serde_json::to_writer(&mut writer, value) {
        Ok(()) => Ok((
            String::from_utf8(writer.text).map_err(|error| error.to_string())?,
            None,
        )),
        Err(_) if writer.produced > 0 => {
            let valid = match std::str::from_utf8(&writer.text) {
                Ok(_) => writer.text.len(),
                Err(error) => error.valid_up_to(),
            };
            writer.text.truncate(valid);
            Ok((
                String::from_utf8(writer.text).map_err(|error| error.to_string())?,
                Some(writer.produced),
            ))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Returns the JSON text of `value` cut to `limit` bytes on a character boundary, and whether it was cut.
pub fn bounded_json(value: &serde_json::Value, limit: usize) -> (String, bool) {
    match bounded_serialize(value, limit) {
        Ok((text, produced)) => (text, produced.is_some()),
        // A JSON value always serializes, so this is a defect of the serializer; the text says so.
        Err(error) => (format!("unserializable: {error}"), true),
    }
}

/// The fields of an event as a producer hands them to the writer: the JSON text, or, when the serialization stopped at the
/// bound, `{"head": <the first EVENT_HEAD_BYTES bytes of the text>}` and the number of bytes that it had written, which the
/// writer stores as `truncated` (docs/spec/logging.md#bounds).
pub struct Fields {
    pub text: Box<serde_json::value::RawValue>,
    pub truncated: Option<usize>,
}

impl Fields {
    /// Wraps fields that are JSON; the writer cuts them when they are over the bound.
    pub fn whole(text: Box<serde_json::value::RawValue>) -> Fields {
        Fields {
            text,
            truncated: None,
        }
    }

    /// Serializes `value` up to `EVENT_FIELDS_LIMIT_BYTES`.
    pub fn of<T: serde::Serialize + ?Sized>(value: &T) -> Result<Fields, String> {
        let (text, produced) = bounded_serialize(value, EVENT_FIELDS_LIMIT_BYTES)?;
        match produced {
            None => Ok(Fields::whole(
                serde_json::value::RawValue::from_string(text)
                    .map_err(|error| error.to_string())?,
            )),
            Some(produced) => {
                let (head, _) = cut_text(&text, EVENT_HEAD_BYTES);
                Ok(Fields {
                    text: serde_json::value::to_raw_value(&serde_json::json!({ "head": head }))
                        .map_err(|error| error.to_string())?,
                    truncated: Some(produced),
                })
            }
        }
    }
}
