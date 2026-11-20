//! Tests of the window snapshot of the endpoint (docs/spec/exposure.md#window-snapshot): the host adds the window and its own group to
//! the part of the main page, as the Go host does. The page of the window is the page of an endpoint case (support/endpoint_case.rs).

#[path = "support/child.rs"]
mod child;
#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

#[path = "support/endpoint_case.rs"]
mod endpoint_case;

use std::sync::Arc;

use endpoint_case::{CasePage, exchange};
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host::endpoint::{self, Endpoint, Failure, Service, raw};

/// The window main of a project whose page follows its exchanges, and host statuses that answer their own name, except host.dock,
/// whose read fails.
struct SnapshotWindow {
    page: Arc<CasePage>,
}

impl Service for SnapshotWindow {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(
            json!([{"window": "main", "title": "soksak", "project": "/p", "key": true, "ready": true}]),
        )
    }

    fn exists(&self, window: &str) -> bool {
        self.page.exists(window)
    }

    fn process_surface(
        &self,
        _pid: u32,
    ) -> Result<String, soksak_host::sidecars::ProcessSurfaceError> {
        Err(soksak_host::sidecars::ProcessSurfaceError::Failed(
            "this service has no sidecars".into(),
        ))
    }

    fn unwatched(&self, window: &str, name: &str) {
        self.page.unwatched(window, name)
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
        reply: Option<endpoint::ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "status.get" && name.starts_with("host.") {
            if name == "host.dock" {
                return Err(Failure::new(-32000, "the dock menu is unread"));
            }
            return raw(&json!({"status": name}));
        }
        self.page.call(window, method, params, reply)
    }
}

fn request(
    connection: &mut endpoint_client::Connection,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .unwrap();
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

/// A part of the main page in a snapshot: its layout, its plugins, the group of core and one surface group.
fn page_part() -> Value {
    json!({"layout": {"space": "s", "focused": null, "root": null}, "plugins": [], "groups": [
        {"owner": "core", "status": [], "commands": [], "element": []},
        {"owner": "surface", "surface": "tab-a", "plugin": "probe", "kind": "tab", "state": "loaded", "visible": true,
            "status": [], "commands": [], "element": []}],
        "unregistered": [{"kind": "status", "name": "core.drop"}]})
}

// contract: endpoint.exposure-snapshot.host-adds-the-window-and-its-group
#[test]
fn the_snapshot_holds_the_window_and_the_host_group_before_the_page_groups() {
    let config = folder::Folder::new();
    let surface_group = page_part()["groups"][1].clone();
    let page = CasePage::new(
        &["main"],
        vec![
            exchange("exposure.snapshot", json!({}), page_part()),
            exchange(
                "exposure.snapshot",
                json!({"surface": "tab-a"}),
                json!({"layout": null, "plugins": [], "groups": [surface_group], "unregistered": []}),
            ),
            exchange("exposure.snapshot", json!({}), json!([])),
            exchange(
                "exposure.snapshot",
                json!({}),
                json!({"layout": null, "plugins": [], "groups": {}, "unregistered": []}),
            ),
            exchange(
                "exposure.snapshot",
                json!({}),
                json!({"layout": null, "plugins": [], "groups": []}),
            ),
        ],
    );
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        "snapshot",
        Arc::new(SnapshotWindow { page: page.clone() }),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    let mut connection = endpoint_client::connect(endpoint.address());

    let answer = request(
        &mut connection,
        1,
        "exposure.snapshot",
        json!({"window": "main"}),
    );
    let result = &answer["result"];
    assert!(
        answer.get("error").is_none(),
        "the snapshot failed: {answer}"
    );
    assert_eq!(
        result["window"],
        json!({"window": "main", "title": "soksak", "project": "/p"})
    );
    let part = page_part();
    for member in ["layout", "plugins", "unregistered"] {
        assert_eq!(result[member], part[member], "the {member} of the snapshot");
    }
    let groups = result["groups"].as_array().expect("groups");
    assert_eq!(groups.len(), 3, "{result}");
    assert_eq!(&groups[1..], part["groups"].as_array().unwrap().as_slice());
    // The host group holds the host entries of exposure.list, without registered, with the value or the error of each status.
    let listed = request(
        &mut connection,
        2,
        "exposure.list",
        json!({"window": "main", "owner": "host"}),
    );
    let mut status = Vec::new();
    for entry in listed["result"]["status"].as_array().unwrap() {
        let mut entry = entry.clone();
        entry.as_object_mut().unwrap().remove("registered");
        if entry["name"] == "host.dock" {
            entry["error"] = json!("the dock menu is unread");
        } else {
            entry["value"] = json!({"status": entry["name"]});
        }
        status.push(entry);
    }
    let commands: Vec<Value> = listed["result"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let mut entry = entry.clone();
            entry.as_object_mut().unwrap().remove("registered");
            entry
        })
        .collect();
    assert_eq!(
        groups[0],
        json!({"owner": "host", "status": status, "commands": commands, "element": []})
    );

    // With surface, the result holds only the group of that surface: the host adds the window and no group.
    let one = request(
        &mut connection,
        3,
        "exposure.snapshot",
        json!({"window": "main", "surface": "tab-a"}),
    );
    let only = one["result"]["groups"].as_array().expect("groups");
    assert_eq!(only.len(), 1, "{one}");
    assert_eq!(only[0]["surface"], "tab-a");
    assert_eq!(one["result"]["window"]["window"], "main");

    // A part of the page that is no object, whose groups are no array or that lacks a member is refused.
    for (index, message) in [
        "page exposure.snapshot is [], not an object",
        "page exposure.snapshot groups is {}, not an array",
        "page exposure.snapshot has no unregistered",
    ]
    .into_iter()
    .enumerate()
    {
        let refused = request(
            &mut connection,
            4 + index as u64,
            "exposure.snapshot",
            json!({"window": "main"}),
        );
        assert_eq!(
            refused["error"],
            json!({"code": -32603, "message": message}),
            "the part {index}: {refused}"
        );
    }
    drop(connection);
    endpoint.stop();
    let problems = page.finish();
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
