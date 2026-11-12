//! The events of a window are events of the event log (docs/spec/logging.md#entrances). The writer of the records
//! is shared by the process, so the check runs in a child process that nothing else writes in.

#[path = "support/folder.rs"]
mod folder;

use std::process::{Command, Stdio};

#[path = "support/records.rs"]
mod records;

use soksak_host::framework::LogicalSize;
use soksak_host::window_events::{record_window_event, record_window_resize};

const CHILD: &str = "SOKSAK_WINDOW_EVENTS_CHILD";
const NAME: &str = "a_window_event_is_recorded_as_an_event";

// contract: windows.events.window-event-is-recorded
#[test]
fn a_window_event_is_recorded_as_an_event() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        record_window_resize("main-2", Some(LogicalSize::new(1440.0, 900.0)));
        // The content of a window that closed is gone, so its resize records no size.
        record_window_resize("main-2", None);
        for kind in ["focus", "window-active", "closed"] {
            record_window_event("main-2", kind);
        }
        // A kind outside the contract is reported on the standard error and stores nothing, and so is a resize without its
        // size.
        record_window_event("main-2", "teleport");
        record_window_event("main-2", "resize");
        writer.flush().unwrap();
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
            .filter(|event| event["event"] == "host.window.event")
            .map(|event| serde_json::json!({"level": event["level"], "fields": event["fields"]}))
            .collect();
    let want = vec![
        serde_json::json!({"level": "debug", "fields": {"window": "main-2", "kind": "resize", "width": 1440.0, "height": 900.0}}),
        serde_json::json!({"level": "debug", "fields": {"window": "main-2", "kind": "resize", "width": null, "height": null}}),
        serde_json::json!({"level": "info", "fields": {"window": "main-2", "kind": "focus"}}),
        serde_json::json!({"level": "info", "fields": {"window": "main-2", "kind": "window-active"}}),
        serde_json::json!({"level": "info", "fields": {"window": "main-2", "kind": "closed"}}),
    ];
    assert_eq!(seen, want);
}

// contract: application.window.scale-change-refreshes-rasters
#[test]
fn a_change_of_the_backing_scale_refreshes_the_rasters_of_the_window() {
    let run = |event: &soksak_host::framework::WindowEvent| {
        let (changed, refreshed) = (std::cell::Cell::new(false), std::cell::Cell::new(false));
        soksak_host::windows::placement_changed(
            event,
            || changed.set(true),
            || refreshed.set(true),
        );
        (changed.get(), refreshed.get())
    };
    assert_eq!(
        run(&soksak_host::framework::WindowEvent::ScaleFactorChanged),
        (true, true)
    );
    assert_eq!(
        run(&soksak_host::framework::WindowEvent::Moved),
        (true, false)
    );
}
