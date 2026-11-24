//! The arguments of the pluginsRun call (docs/spec/installation.md#plugin-operations-in-the-application). The same cases run in the
//! Go host.

use serde_json::{Value, json};

use crate::plugins::RunRequest;

// contract: plugins.run.end-is-optional
/// The workbench sends pluginsRun {action, plugin} without end for an operation that ends no service, so the request decodes
/// without end and with a null end, and end is absent.
#[test]
fn plugins_run_request_decodes_without_end() {
    for raw in [
        json!({"action": "update", "plugin": "agents"}),
        json!({"action": "update", "plugin": "agents", "end": null}),
    ] {
        let request: RunRequest = serde_json::from_value(raw.clone())
            .unwrap_or_else(|error| panic!("pluginsRun {raw}: {error}"));
        assert!(
            request.end.is_none(),
            "pluginsRun {raw}: end = {:?}, want none",
            request.end
        );
    }
    let request: RunRequest =
        serde_json::from_value(json!({"action": "update", "plugin": "agents", "end": true}))
            .unwrap();
    assert_eq!(request.end, Some(Value::Bool(true)));
}
