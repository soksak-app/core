//! A message line of a sidecar is decoded once, its body once and the member image of the body once; the reader dispatches the message
//! by the members that these decodes found (docs/spec/sidecars.md#messages).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::value::RawValue;

/// The decodes of the messages of the sidecars: of a line that a reader received, of the body of the line and of the member image of
/// the body. The decode of a single member value inside them is not counted.
static MESSAGE_DECODES: AtomicU64 = AtomicU64::new(0);

/// The number of decodes of the messages of the sidecars since the process started. A check reads it before and after the lines it
/// sends.
pub fn message_decodes() -> u64 {
    MESSAGE_DECODES.load(Ordering::SeqCst)
}

/// The members of a JSON object as written, by name. A value that is not a JSON object is an error.
pub(crate) type Members<'a> = HashMap<String, &'a RawValue>;

/// Decodes `text`, a line of a sidecar, its body or the member image of its body, into its members and counts the decode.
pub(crate) fn decode_members(text: &[u8]) -> Result<Members<'_>, serde_json::Error> {
    MESSAGE_DECODES.fetch_add(1, Ordering::SeqCst);
    serde_json::from_slice(text)
}

/// The body of a message of a sidecar with the members that the host reads from it.
pub struct MessageBody<'a> {
    /// The body as the sidecar wrote it.
    pub raw: &'a str,
    /// The member error of an object body.
    pub(crate) error: Option<&'a RawValue>,
    /// The member image of an object body: its text and its members, or `None` as members when it is not an object.
    pub(crate) image: Option<(&'a RawValue, Option<Members<'a>>)>,
}

impl<'a> MessageBody<'a> {
    /// Decodes the members of the body that the host reads: the member error and the member image with its members. A body that is
    /// not an object holds neither.
    pub fn read(raw: &'a str) -> Self {
        // silent: a body that is not an object is an ordinary message without an image or an error, which reaches its owner as written.
        let Ok(members) = decode_members(raw.as_bytes()) else {
            return MessageBody {
                raw,
                error: None,
                image: None,
            };
        };
        let image = members.get("image").map(|image| {
            // silent: an image that is not an object is malformed, which the decision of the image records.
            (*image, decode_members(image.get().as_bytes()).ok())
        });
        MessageBody {
            raw,
            error: members.get("error").copied(),
            image,
        }
    }

    /// The member of the member image named `name`, when the image is an object that holds it.
    pub(crate) fn image_member(&self, name: &str) -> Option<&'a RawValue> {
        self.image
            .as_ref()
            .and_then(|(_, members)| members.as_ref())
            .and_then(|members| members.get(name).copied())
    }
}
