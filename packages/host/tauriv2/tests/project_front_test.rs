//! The front of a project owner is an event of the event log (docs/spec/logging.md#automatic-entrances). The writer of the
//! records is shared by the process, so the check runs in a child process that nothing else writes in.

#[path = "support/folder.rs"]
mod folder;

use std::process::{Command, Stdio};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::window_events::record_project_front;

const CHILD: &str = "SOKSAK_PROJECT_FRONT_CHILD";
const NAME: &str = "a_project_front_is_recorded_as_an_event";

// contract: project.open.front-is-recorded
#[test]
fn a_project_front_is_recorded_as_an_event() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        record_project_front("main", "prj-one", true, Some(false));
        record_project_front("main", "prj-two", false, None);
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD, config.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let seen: Vec<serde_json::Value> =
        records::read_events(&records::event_log_path(config.path()))
            .into_iter()
            .filter(|event| event["event"] == "host.project.front")
            .collect();
    assert_eq!(seen.len(), 2, "host.project.front events: {seen:?}");
    assert_eq!(seen[0]["level"], "info");
    assert_eq!(
        seen[0]["fields"],
        serde_json::json!({"window": "main", "project": "prj-one", "key": true, "app_active": false})
    );
    assert_eq!(
        seen[1]["fields"],
        serde_json::json!({"window": "main", "project": "prj-two", "key": false, "app_active": null})
    );
}
