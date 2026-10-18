//! The events of the application are events of the event log (docs/spec/logging.md#automatic-entrances). The writer of the
//! records is shared by the process, so the check runs in a child process that nothing else writes in.

#[path = "support/folder.rs"]
mod folder;

use std::process::{Command, Stdio};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::app_events::record_app_event;

const CHILD: &str = "SOKSAK_APP_EVENTS_CHILD";
const NAME: &str = "an_application_event_is_recorded_as_an_event";

// contract: application.events.app-event-is-recorded
#[test]
fn an_application_event_is_recorded_as_an_event() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        for kind in ["started", "activated", "exit"] {
            record_app_event(kind);
        }
        // A kind outside the contract is reported on the standard error and stores nothing.
        record_app_event("teleport");
        // No framework of the hosts reports a reopen, so the kind is outside the contract too.
        record_app_event("reopened");
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
    let seen: Vec<String> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.app.event")
        .map(|event| {
            format!(
                "{} {}",
                event["level"].as_str().unwrap(),
                event["fields"]["kind"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(seen, ["info started", "info activated", "info exit"]);
}
