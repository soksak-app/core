//! The events of a window are events of the event log (docs/spec/logging.md#automatic-entrances). The writer of the records
//! is shared by the process, so the check runs in a child process that nothing else writes in.

use std::process::{Command, Stdio};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::window_events::record_window_event;

const CHILD: &str = "SOKSAK_WINDOW_EVENTS_CHILD";
const NAME: &str = "a_window_event_is_recorded_as_an_event";

// contract: windows.events.window-event-is-recorded
#[test]
fn a_window_event_is_recorded_as_an_event() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        for kind in ["resize", "focus", "closed"] {
            record_window_event("main-2", kind);
        }
        // A kind outside the contract is reported on the standard error and stores nothing.
        record_window_event("main-2", "teleport");
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
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
    let seen: Vec<(String, String, String)> =
        records::read_events(&records::event_log_path(config.path()))
            .into_iter()
            .filter(|event| event["event"] == "host.window.event")
            .map(|event| {
                (
                    event["level"].as_str().unwrap().to_string(),
                    event["fields"]["window"].as_str().unwrap().to_string(),
                    event["fields"]["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect();
    let want: Vec<(String, String, String)> =
        [("debug", "resize"), ("info", "focus"), ("info", "closed")]
            .iter()
            .map(|(level, kind)| (level.to_string(), "main-2".to_string(), kind.to_string()))
            .collect();
    assert_eq!(seen, want);
}
