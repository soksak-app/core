//! Checks that the host records a call request of a view and its reply at the debug level, with the plugin, the surface and the id
//! (docs/spec/native-surfaces.md#view-surfaces). The writer of the records is process-wide, so the write runs in a child process.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::process::{Command, Stdio};
use std::time::Duration;

use soksak_host_tauriv2::documents::ViewChannels;

/// The environment variable that tells the child process the configuration directory.
const CHILD: &str = "SOKSAK_VIEW_CALL_RECORD_CHILD";

const NAME: &str = "a_view_call_and_its_reply_are_recorded_at_debug_with_their_identifier";

// contract: view.call.record
#[test]
fn a_view_call_and_its_reply_are_recorded_at_debug_with_their_identifier() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        let channels = ViewChannels::default();
        channels.register("probe-surface", "probe", 1);
        assert!(
            channels
                .call(
                    "probe-surface",
                    r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{"a":1}}}"#
                )
                .unwrap()
                .is_some()
        );
        assert!(
            channels
                .reply(
                    "probe-surface",
                    r#"{"message":{"sok":1,"reply":7,"result":{"ok":true}}}"#
                )
                .unwrap()
                .is_some()
        );
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
    let events = records::read_events(&records::event_log_path(config.path()));
    let calls: Vec<_> = events
        .iter()
        .filter(|event| event["event"] == "host.view.call")
        .collect();
    let replies: Vec<_> = events
        .iter()
        .filter(|event| event["event"] == "host.view.reply")
        .collect();
    assert_eq!(calls.len(), 1, "host.view.call records: {calls:?}");
    assert_eq!(calls[0]["level"], "debug");
    assert_eq!(calls[0]["fields"]["plugin"], "probe");
    assert_eq!(calls[0]["fields"]["id"], 7);
    assert_eq!(calls[0]["fields"]["command"], "probe.run");
    assert_eq!(replies.len(), 1, "host.view.reply records: {replies:?}");
    assert_eq!(replies[0]["level"], "debug");
    assert_eq!(replies[0]["fields"]["id"], 7);
    assert_eq!(replies[0]["fields"]["outcome"], "result");
}
