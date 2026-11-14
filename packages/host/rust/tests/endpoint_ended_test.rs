//! Checks that a watch whose producer ends receives `status.ended` and is removed without a `status.unwatch` to the page
//! (docs/spec/exposure.md#methods). The page of the window is the page of an endpoint case (support/endpoint_case.rs): it
//! answers the three watch requests that the case states, and a `status.unwatch` that reaches it fails the test.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

use endpoint_client::Connection;

#[path = "support/child.rs"]
mod child;
#[path = "support/endpoint_case.rs"]
mod endpoint_case;
#[path = "support/records.rs"]
mod records;

use endpoint_case::{exchange, serve_page};

use serde_json::{Value, json};
use soksak_host::endpoint::{self, raw};

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
    // The page receives a status.watch of the surface, one of the plain status and, after the end, a second one of the surface,
    // and never a status.unwatch.
    let watch = |params: Value| exchange("status.watch", params, Value::Null);
    let served = serve_page(
        "test-ended",
        vec![
            watch(json!({"name": "core.view", "surface": "tab-1"})),
            watch(json!({"name": "core.view"})),
            watch(json!({"name": "core.view", "surface": "tab-1"})),
        ],
    );
    let notifier = served.endpoint.notifier();
    let mut connection = served.open();
    let surface = json!({"window": "main", "name": "core.view", "surface": "tab-1"});
    let plain = json!({"window": "main", "name": "core.view"});
    assert_eq!(
        request(&mut connection, 1, "status.watch", surface.clone())["result"],
        Value::Null
    );
    assert_eq!(
        request(&mut connection, 2, "status.watch", plain.clone())["result"],
        Value::Null
    );

    notifier.changed("main", "core.view", Some("tab-1"), &raw(&json!(1)).unwrap());
    notifier.ended("main", Some("tab-1"), "surface-closed");
    // A change after the end reaches no watch of the surface.
    notifier.changed("main", "core.view", Some("tab-1"), &raw(&json!(2)).unwrap());
    assert_eq!(
        receive(&mut connection),
        json!({"jsonrpc": "2.0", "method": "status.changed",
            "params": {"window": "main", "name": "core.view", "surface": "tab-1", "value": 1}})
    );
    assert_eq!(
        receive(&mut connection),
        json!({"jsonrpc": "2.0", "method": "status.ended",
            "params": {"window": "main", "name": "core.view", "surface": "tab-1", "reason": "surface-closed"}})
    );
    // The watch without a surface stays, and the next message is its change, not the change 2 of the ended watch.
    notifier.changed("main", "core.view", None, &raw(&json!(3)).unwrap());
    assert_eq!(
        receive(&mut connection)["params"],
        json!({"window": "main", "name": "core.view", "value": 3})
    );
    assert!(
        !notifier
            .watches("main")
            .iter()
            .any(|watch| watch.surface.is_some())
    );

    notifier.ended("main", None, "window-closed");
    assert_eq!(
        receive(&mut connection),
        json!({"jsonrpc": "2.0", "method": "status.ended",
            "params": {"window": "main", "name": "core.view", "reason": "window-closed"}})
    );
    assert!(notifier.watches("main").is_empty());

    // The ended watch starts anew: the page receives a second status.watch of the surface and never a status.unwatch.
    assert_eq!(
        request(&mut connection, 3, "status.watch", surface)["result"],
        Value::Null
    );
    served.finish();
}
