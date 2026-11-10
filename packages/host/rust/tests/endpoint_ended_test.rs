//! Checks that a watch whose producer ends receives `status.ended` and is removed without a `status.unwatch` to the page
//! (docs/spec/exposure.md#methods). A fake service replaces the window and the page.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

use endpoint_client::Connection;

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host::endpoint::{self, Endpoint, Failure, Service, raw};

/// A service with the window w1 whose page answers every call with null and records the method and the params.
#[derive(Default)]
struct Page {
    calls: Mutex<Vec<(String, Value)>>,
}

impl Service for Page {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([{"window": "w1", "title": "one", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "w1"
    }

    fn call(
        &self,
        _window: &str,
        method: &str,
        params: Map<String, Value>,
        _reply: Option<endpoint::ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), Value::Object(params)));
        raw(&Value::Null)
    }

    fn unwatched(&self, _window: &str, _name: &str) {}
}

fn start(config: &Path, application: &str, page: Arc<Page>) -> Endpoint {
    let endpoint = Endpoint::start(&config.join("sockets"), config, application, page).unwrap();
    endpoint.publish("w1").unwrap();
    endpoint
}

fn request(connection: &mut Connection, id: u64, method: &str, params: Value) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .unwrap();
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

fn receive(connection: &mut Connection) -> Value {
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

// The close of a surface ends the watches of that surface after their earlier changes, keeps the other watches, and sends
// the page no status.unwatch; the close of the window ends the rest.
// contract: endpoint.status.ended-ends-a-watch
#[test]
fn a_watch_ends_with_its_producer() {
    let config = folder::Folder::new();
    let page = Arc::new(Page::default());
    let endpoint = start(config.path(), "test-ended", page.clone());
    let notifier = endpoint.notifier();
    let mut connection = endpoint_client::connect(endpoint.address());
    let surface = json!({"window": "w1", "name": "core.view", "surface": "tab-1"});
    let plain = json!({"window": "w1", "name": "core.view"});
    assert_eq!(
        request(&mut connection, 1, "status.watch", surface.clone())["result"],
        Value::Null
    );
    assert_eq!(
        request(&mut connection, 2, "status.watch", plain.clone())["result"],
        Value::Null
    );

    notifier.changed("w1", "core.view", Some("tab-1"), &raw(&json!(1)).unwrap());
    notifier.ended("w1", Some("tab-1"), "surface-closed");
    // A change after the end reaches no watch of the surface.
    notifier.changed("w1", "core.view", Some("tab-1"), &raw(&json!(2)).unwrap());
    assert_eq!(
        receive(&mut connection),
        json!({"jsonrpc": "2.0", "method": "status.changed",
            "params": {"window": "w1", "name": "core.view", "surface": "tab-1", "value": 1}})
    );
    assert_eq!(
        receive(&mut connection),
        json!({"jsonrpc": "2.0", "method": "status.ended",
            "params": {"window": "w1", "name": "core.view", "surface": "tab-1", "reason": "surface-closed"}})
    );
    // The watch without a surface stays, and the next message is its change, not the change 2 of the ended watch.
    notifier.changed("w1", "core.view", None, &raw(&json!(3)).unwrap());
    assert_eq!(
        receive(&mut connection)["params"],
        json!({"window": "w1", "name": "core.view", "value": 3})
    );
    assert!(
        !notifier
            .watches("w1")
            .iter()
            .any(|watch| watch.surface.is_some())
    );

    notifier.ended("w1", None, "window-closed");
    assert_eq!(
        receive(&mut connection),
        json!({"jsonrpc": "2.0", "method": "status.ended",
            "params": {"window": "w1", "name": "core.view", "reason": "window-closed"}})
    );
    assert!(notifier.watches("w1").is_empty());

    // The ended watch starts anew: the page receives a second status.watch of the surface and never a status.unwatch.
    assert_eq!(
        request(&mut connection, 3, "status.watch", surface)["result"],
        Value::Null
    );
    let calls = page.calls.lock().unwrap().clone();
    let methods: Vec<&str> = calls.iter().map(|(method, _)| method.as_str()).collect();
    assert_eq!(
        methods,
        ["status.watch", "status.watch", "status.watch"],
        "{calls:?}"
    );
    endpoint.stop();
}
