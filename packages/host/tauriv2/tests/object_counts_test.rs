//! Tests of the object counts of a window that `diagnostics.objects` reports. The counts are read from the registries of the
//! window, so each test changes a registry and checks its count, and checks that the count falls back when the object is
//! removed. They are compiled only in diagnostic builds. The same cases run in the Go host.
#![cfg(feature = "diagnostics")]

#[path = "support/folder.rs"]
mod folder;

use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host_tauriv2::documents::Documents;
use soksak_host_tauriv2::endpoint::{self, Connection, Endpoint, Service};
use soksak_host_tauriv2::exposure::Relay;
use soksak_host_tauriv2::images::Images;
use soksak_host_tauriv2::object_counts::{
    DocumentObjects, HostObjects, ObjectCounter, ObjectCounts, PageObjects, SidecarSession,
};
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
    let directory = folder::Folder::new();
    // The fixture keeps its standard input open, so the session stays running until the sidecars stop.
    let program = directory.path().join("echo");
    std::fs::write(&program, "#!/bin/sh\ncat > /dev/null\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let declarations = vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: directory.path().to_path_buf(),
        data: br#"{"executable":"echo","protocol":1}"#.to_vec(),
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
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
    assert_eq!(sidecars.sessions(&owner).len(), 0);
    sidecars
        .send_with_cids(&owner, ECHO, "s1", &raw("{}"), &["c1".to_string()])
        .unwrap();
    assert_eq!(
        sidecars.sessions(&owner),
        vec![SidecarSession {
            sidecar: ECHO.to_string(),
            surface: "s1".to_string()
        }]
    );
    assert_eq!(sidecars.sessions(&other).len(), 0);
    assert_eq!(sidecars.pending_count(&owner), 1);
    assert_eq!(sidecars.pending_count(&other), 0);
    sidecars.stop();
    assert_eq!(sidecars.sessions(&owner).len(), 0);
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

/// The diagnostic backend of diagnostics.objects: it answers fixed counts and records the window of each request.
#[derive(Default)]
struct FixedCounts {
    windows: Mutex<Vec<String>>,
}

impl ObjectCounter for FixedCounts {
    fn object_counts(&self, window: &str) -> Result<ObjectCounts, endpoint::Failure> {
        self.windows.lock().unwrap().push(window.to_string());
        Ok(ObjectCounts {
            host: HostObjects {
                surfaces: 2,
                regions: 1,
                documents: 2,
                sidecar_sessions: 1,
                pending_replies: 0,
                event_subscribers: 3,
            },
            page: PageObjects {
                elements: 40,
                documents: 1,
            },
            documents: vec![
                DocumentObjects {
                    surface: "tab-2".into(),
                    document: "page".into(),
                    counts: PageObjects {
                        elements: 5,
                        documents: 2,
                    },
                },
                DocumentObjects {
                    surface: "tab-1".into(),
                    document: "page".into(),
                    counts: PageObjects {
                        elements: 3,
                        documents: 1,
                    },
                },
            ],
            sessions: vec![SidecarSession {
                sidecar: "@scope/sidecar-a".into(),
                surface: "tab-1".into(),
            }],
        })
    }
}

/// A service with the window main that answers diagnostics.objects through the diagnostic backend.
struct ObjectsService(FixedCounts);

impl Service for ObjectsService {
    fn unwatched(&self, _window: &str, _name: &str) {}

    fn windows(&self) -> Result<Value, endpoint::Failure> {
        Ok(json!([{"window": "main", "title": "Main", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "main"
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        _params: Map<String, Value>,
    ) -> Result<Box<RawValue>, endpoint::Failure> {
        assert_eq!(method, "diagnostics.objects");
        endpoint::raw(&soksak_host_tauriv2::object_counts::objects_reply(
            &self.0, window,
        )?)
    }
}

fn request(connection: &mut Box<dyn Connection>, id: u64, params: Value) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": "diagnostics.objects", "params": params}),
    )
    .unwrap();
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

// diagnostics.objects requires a window, answers an unknown window with the missing window error without asking the
// backend, and replies the counts of the backend for the named window with the documents ordered by surface and
// document.
// contract: diagnostics.objects.reply-and-params
#[test]
fn diagnostics_objects_reply_and_params() {
    let config = folder::Folder::new();
    let service = Arc::new(ObjectsService(FixedCounts::default()));
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "test-objects",
        service.clone(),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    let mut connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let missing = request(&mut connection, 1, json!({}));
    assert_eq!(missing["error"]["code"], json!(-32602), "{missing}");
    let unknown = request(&mut connection, 2, json!({"window": "other"}));
    assert_eq!(unknown["error"]["code"], json!(1003), "{unknown}");
    let reply = request(&mut connection, 3, json!({"window": "main"}));
    assert_eq!(
        reply["result"],
        json!({
            "host": {"surfaces": 2, "regions": 1, "documents": 2, "sidecarSessions": 1, "pendingReplies": 0, "eventSubscribers": 3},
            "page": {"elements": 40, "documents": 1},
            "documents": [
                {"surface": "tab-1", "document": "page", "elements": 3, "documents": 1},
                {"surface": "tab-2", "document": "page", "elements": 5, "documents": 2},
            ],
            "sessions": [{"sidecar": "@scope/sidecar-a", "surface": "tab-1"}],
        }),
        "{reply}"
    );
    assert_eq!(*service.0.windows.lock().unwrap(), vec!["main".to_string()]);
    endpoint.stop();
}
