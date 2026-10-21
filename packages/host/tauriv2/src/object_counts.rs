//! Object counts of a window for the diagnostic method diagnostics.objects (docs/spec/endpoint.md). Each count reads a
//! registry of the host, and the Go host (packages/host/wailsv3/src/object_counts.go) uses the same names and definitions.
//! It is included only in diagnostic builds.

use std::sync::PoisonError;

use serde_json::{Value, json};

use crate::endpoint::Failure;

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

/// Receives the counts of one web view, with the element count of its parked surface hosts, or the failure.
pub type PageCountDone = Box<dyn FnOnce(Result<(PageObjects, usize), String>) + Send>;

/// A sidecar session of diagnostics.objects: the sidecar and the surface that sent a request to it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
pub struct SidecarSession {
    pub sidecar: String,
    pub surface: String,
}

/// The counts of the document region `document` of `surface`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentObjects {
    pub surface: String,
    pub document: String,
    pub counts: PageObjects,
}

/// The object counts of one window that diagnostics.objects replies. parked_elements are the elements of the parked
/// surface hosts of the main page, which are outside its document and so not in page.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObjectCounts {
    pub host: HostObjects,
    pub page: PageObjects,
    pub parked_elements: usize,
    pub documents: Vec<DocumentObjects>,
    pub sessions: Vec<SidecarSession>,
}

/// The diagnostic backend of diagnostics.objects: it counts the objects of an existing window. The application host
/// implements it, and tests of the method give a backend with fixed counts.
pub trait ObjectCounter {
    fn object_counts(&self, window: &str) -> Result<ObjectCounts, Failure>;
}

/// Returns the reply of diagnostics.objects for window: the counts that counter counts with the names of the reply, with
/// the documents ordered by surface and document.
pub fn objects_reply(counter: &dyn ObjectCounter, window: &str) -> Result<Value, Failure> {
    let mut counts = counter.object_counts(window)?;
    counts
        .documents
        .sort_by(|a, b| (&a.surface, &a.document).cmp(&(&b.surface, &b.document)));
    let documents: Vec<Value> = counts
        .documents
        .iter()
        .map(|document| {
            json!({
                "surface": document.surface,
                "document": document.document,
                "elements": document.counts.elements,
                "documents": document.counts.documents,
            })
        })
        .collect();
    let mut page = counts.page.payload();
    page["parkedElements"] = json!(counts.parked_elements);
    Ok(json!({
        "host": counts.host.payload(),
        "page": page,
        "documents": documents,
        "sessions": counts.sessions,
    }))
}

impl crate::surfaces::Views {
    /// Returns the number of surfaces of the window, which is the number of their native views.
    pub(crate) fn count(&self) -> Result<usize, String> {
        // default: a lock that a panicking thread poisoned still holds the surface registrations, which are only read;
        // the panic hook records the panic.
        Ok(self.0.lock().unwrap_or_else(PoisonError::into_inner).len())
    }
}

#[cfg(test)]
#[path = "object_counts_test.rs"]
mod tests;
