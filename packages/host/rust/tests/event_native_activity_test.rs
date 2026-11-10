//! The registration of the activity observers at the start of a host (docs/spec/logging.md#policy). The observers belong to the
//! process and are installed once, so this file holds one test: its process installs them only through the start below.

#[path = "support/folder.rs"]
mod folder;

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::Value;
use soksak_host::event_log;

// contract: log.native.activity-observers-register-under-the-policy
// The start of a host installs the activity observers after it applied the policy file, so a policy that stores the class
// lifecycle at the level info stores the registration of each activity observer.
#[test]
fn the_activity_observers_register_under_the_policy_of_the_host_start() {
    let directory = folder::Folder::new();
    std::fs::write(
        directory.path().join("log-policy.json"),
        r#"{"schema":1,"classes":{"lifecycle":"info","input":"error","call":"error","io":"error","frame":"error"}}"#,
    )
    .unwrap();
    let log = Arc::new(event_log::start_host(directory.path()).unwrap());
    let _watch = event_log::start_host_log_policy(&log, None).unwrap();
    log.flush().unwrap();
    let registered: BTreeSet<String> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["event"] == "native.observe.registered")
        .filter_map(|event| event["fields"]["source"].as_str().map(str::to_string))
        .collect();
    for source in ["activity.window", "activity.occlusion"] {
        assert!(
            registered.contains(source),
            "the log holds no native.observe.registered of {source} under a policy that stores it; registered {registered:?}"
        );
    }
}
