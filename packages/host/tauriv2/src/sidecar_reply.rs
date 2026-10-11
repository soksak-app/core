//! The replies of a sidecar (docs/spec/logging.md#entrances): the host stores the event `host.sidecar.reply` when it relays a message
//! of a sidecar that names the correlation identifiers of a request (`cids` of the message line) or states an error, and when the
//! failure of a sidecar ends the requests that it did not answer. The host remembers the time of each request that carries
//! identifiers, so the reply states the microseconds since the request was queued.

use std::collections::{HashMap, VecDeque};

use serde::Deserialize;
use serde_json::value::RawValue;

/// Bounds the requests that wait for a reply. The oldest request is forgotten when the bound is reached; the request is still
/// stored as `host.sidecar.request`, and only the microseconds of its reply, which the two events derive, are lost.
pub const PENDING_REQUEST_LIMIT: usize = 4096;

/// Bounds the identifiers that the failed reply of one surface lists: the newest requests.
pub const FAILED_REQUEST_CIDS: usize = 64;

struct Pending {
    sidecar: String,
    surface: String,
    mono: u64,
}

/// The queued requests that carry correlation identifiers, until a reply or a failure names them.
#[derive(Default)]
pub struct RequestLedger {
    pending: HashMap<String, Pending>,
    order: VecDeque<String>,
}

impl RequestLedger {
    /// Remembers the requests of `cids`, queued for the surface of the sidecar at the monotonic time `mono`.
    pub fn add(&mut self, sidecar: &str, surface: &str, cids: &[String], mono: u64) {
        for cid in cids {
            if self.pending.contains_key(cid) {
                continue;
            }
            while self.pending.len() >= PENDING_REQUEST_LIMIT {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                // silent: the oldest request is forgotten at the bound; its request event stays and only the derived microseconds of its reply are lost.
                self.pending.remove(&oldest);
            }
            self.pending.insert(
                cid.clone(),
                Pending {
                    sidecar: sidecar.to_string(),
                    surface: surface.to_string(),
                    mono,
                },
            );
            self.order.push_back(cid.clone());
        }
    }

    /// Removes the requests of `cids` and returns the nanoseconds since the first of them that was remembered.
    pub fn take(&mut self, cids: &[String], now: u64) -> Option<u64> {
        let mut elapsed = None;
        for cid in cids {
            if let Some(request) = self.pending.remove(cid) {
                elapsed.get_or_insert(now.saturating_sub(request.mono));
            }
        }
        elapsed
    }

    /// Removes the requests that wait for the sidecar and returns their identifiers by surface, the newest
    /// [`FAILED_REQUEST_CIDS`] of each surface, in the order of the requests, with the surfaces in the order of their oldest request.
    pub fn failed(&mut self, sidecar: &str) -> Vec<(String, Vec<String>)> {
        let mut surfaces: Vec<(String, Vec<String>)> = Vec::new();
        let mut kept = VecDeque::new();
        for cid in std::mem::take(&mut self.order) {
            let Some(request) = self.pending.get(&cid) else {
                continue;
            };
            if request.sidecar != sidecar {
                kept.push_back(cid);
                continue;
            }
            let surface = request.surface.clone();
            self.pending.remove(&cid);
            match surfaces.iter_mut().find(|(name, _)| *name == surface) {
                Some((_, cids)) => cids.push(cid),
                None => surfaces.push((surface, vec![cid])),
            }
        }
        self.order = kept;
        for (_, cids) in &mut surfaces {
            if cids.len() > FAILED_REQUEST_CIDS {
                cids.drain(..cids.len() - FAILED_REQUEST_CIDS);
            }
        }
        surfaces
    }

    /// Removes the requests that wait for the sidecar without an event: the host ended the sidecar, which `host.sidecar.exit` states.
    pub fn forget(&mut self, sidecar: &str) {
        self.failed(sidecar);
    }
}

#[derive(Deserialize)]
struct ErrorMember<'a> {
    #[serde(borrow)]
    error: Option<&'a RawValue>,
}

/// The text of the member `error` of a reply body, which a sidecar writes as a string or as another JSON value, or `None` when the
/// body has none. A body without the member, or that is not an object, is not an error reply.
pub fn error_of_body(body: &str) -> Option<String> {
    if !body.contains("\"error\"") {
        return None;
    }
    // silent: a body that is not an object, or whose error is null, states no error.
    let member: ErrorMember = serde_json::from_str(body).ok()?;
    let raw = member.error?;
    match serde_json::from_str::<String>(raw.get()) {
        Ok(text) => Some(text),
        // default: an error that is not a string is stated by its JSON text.
        Err(_) => Some(raw.get().to_string()),
    }
}
