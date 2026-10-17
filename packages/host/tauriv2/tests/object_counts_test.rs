//! Tests of the object counts of a window that `diagnostics.objects` reports. The counts are read from the registries of the
//! window, so each test changes a registry and checks its count, and checks that the count falls back when the object is
//! removed. They are compiled only in diagnostic builds. The same cases run in the Go host.
#![cfg(feature = "diagnostics")]

use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::json;
use serde_json::value::RawValue;
use soksak_host_tauriv2::documents::Documents;
use soksak_host_tauriv2::exposure::Relay;
use soksak_host_tauriv2::images::Images;
use soksak_host_tauriv2::object_counts::{HostObjects, PageObjects};
use soksak_host_tauriv2::sidecars::{Failure, Message, Owner, SidecarDeclaration, Sidecars};

const ECHO: &str = "@fixture/sidecar-echo";

#[derive(Clone)]
struct FakeOwner {
    key: String,
    root: String,
}

impl Owner for FakeOwner {
    fn key(&self) -> String {
        self.key.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.root.clone())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, failure: Failure) {
        eprintln!("sidecar failure: {failure:?}");
    }
}

fn key(surface: &str, name: &str) -> (String, String) {
    (surface.to_string(), name.to_string())
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

// contract: diagnostics.objects.counts-host-objects
#[test]
fn document_region_count_falls_back_when_removed() {
    let docs = Documents::default();
    assert_eq!(docs.count(), 0);
    let (one, two) = (key("tab-1", "page"), key("tab-1", "side"));
    docs.reserve(&one).unwrap();
    docs.reserve(&two).unwrap();
    assert_eq!(docs.count(), 2);
    docs.remove(&one).unwrap();
    assert_eq!(docs.count(), 1);
    docs.remove_surface("tab-1");
    assert_eq!(docs.count(), 0);
}

// contract: diagnostics.objects.counts-host-objects
#[test]
fn image_region_count_falls_back_when_removed() {
    let images = Images::default();
    assert_eq!(images.count(), 0);
    let (one, two) = (key("tab-1", "picture"), key("tab-1", "thumb"));
    images.reserve(&one, "a", "image").unwrap();
    images.reserve(&two, "a", "image").unwrap();
    assert_eq!(images.count(), 2);
    images.remove(&one).unwrap();
    assert_eq!(images.count(), 1);
    images.remove_surface("tab-1");
    assert_eq!(images.count(), 0);
}

// contract: diagnostics.objects.counts-host-objects
#[test]
fn sidecar_session_and_pending_reply_counts_follow_the_owner() {
    let directory = tempfile::tempdir().unwrap();
    // The fixture keeps its standard input open, so the session stays running until the sidecars stop.
    let program = directory.path().join("echo");
    std::fs::write(&program, "#!/bin/sh\ncat > /dev/null\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let declarations = vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: directory.path().to_path_buf(),
        data: br#"{"executable":"echo","protocol":1}"#.to_vec(),
        version: "0.0.1".to_string(),
    }];
    let sidecars = Sidecars::new(&declarations, directory.path().to_path_buf()).unwrap();
    let owner = FakeOwner {
        key: "a".into(),
        root: directory.path().display().to_string(),
    };
    let other = FakeOwner {
        key: "b".into(),
        root: directory.path().display().to_string(),
    };
    assert_eq!(sidecars.session_count(&owner), 0);
    sidecars
        .send_with_cids(&owner, ECHO, "s1", &raw("{}"), &["c1".to_string()])
        .unwrap();
    assert_eq!(sidecars.session_count(&owner), 1);
    assert_eq!(sidecars.session_count(&other), 0);
    assert_eq!(sidecars.pending_count(&owner), 1);
    assert_eq!(sidecars.pending_count(&other), 0);
    sidecars.stop();
    assert_eq!(sidecars.session_count(&owner), 0);
}

// contract: diagnostics.objects.counts-host-objects
#[test]
fn relay_pending_count_follows_the_waiting_requests() {
    let relay = Relay::default();
    assert_eq!(relay.pending_count("main"), 0);
    let (sent_tx, sent_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let waiting = scope.spawn(|| {
            relay.request("main", Some(Duration::from_secs(10)), |_id| {
                sent_tx.send(()).unwrap();
                Ok(())
            })
        });
        // The request is registered before it is sent, so the send marks the count as changed.
        sent_rx.recv().unwrap();
        assert_eq!(relay.pending_count("main"), 1);
        assert_eq!(relay.pending_count("other"), 0);
        relay.abandon("main");
        assert!(waiting.join().unwrap().is_err());
    });
    assert_eq!(relay.pending_count("main"), 0);
}

// contract: diagnostics.objects.counts-host-objects
#[test]
fn host_objects_payload_names_every_count() {
    let counts = HostObjects {
        surfaces: 1,
        regions: 2,
        documents: 3,
        sidecar_sessions: 4,
        pending_replies: 5,
        event_subscribers: 6,
    };
    assert_eq!(
        counts.payload(),
        json!({"surfaces": 1, "regions": 2, "documents": 3, "sidecarSessions": 4, "pendingReplies": 5, "eventSubscribers": 6})
    );
}

// contract: diagnostics.objects.counts-documents
#[test]
fn page_objects_payload_names_elements_and_documents() {
    let counts = PageObjects {
        elements: 7,
        documents: 2,
    };
    assert_eq!(counts.payload(), json!({"elements": 7, "documents": 2}));
}
