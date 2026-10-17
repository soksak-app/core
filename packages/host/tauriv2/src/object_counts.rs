//! Object counts of a window for the diagnostic method diagnostics.objects (docs/spec/endpoint.md). Each count reads a
//! registry of the host, and the Go host (packages/host/wailsv3/src/object_counts.go) uses the same names and definitions.
//! It is included only in diagnostic builds.

use serde_json::{Value, json};

/// The objects that the host process keeps for one window. regions are the image regions and documents are the document
/// regions (docs/spec/native-surfaces.md#regions). sidecar_sessions are the sessions of the sidecars that the surfaces of
/// the window use. pending_replies are the requests of the window that wait for a reply: the sidecar requests with
/// correlation identifiers and the page requests of the relay. event_subscribers are the subscriptions of the connections
/// to the notifications of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HostObjects {
    pub surfaces: usize,
    pub regions: usize,
    pub documents: usize,
    pub sidecar_sessions: usize,
    pub pending_replies: usize,
    pub event_subscribers: usize,
}

impl HostObjects {
    /// Returns the counts with the names of the reply.
    pub fn payload(&self) -> Value {
        json!({
            "surfaces": self.surfaces,
            "regions": self.regions,
            "documents": self.documents,
            "sidecarSessions": self.sidecar_sessions,
            "pendingReplies": self.pending_replies,
            "eventSubscribers": self.event_subscribers,
        })
    }
}

/// The elements of the main document of a page and the documents of the page, which are the main document and its frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PageObjects {
    pub elements: usize,
    pub documents: usize,
}

impl PageObjects {
    /// Returns the counts with the names of the reply.
    pub fn payload(&self) -> Value {
        json!({"elements": self.elements, "documents": self.documents})
    }
}
