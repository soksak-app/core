//! Checks that a view.error message of a view is written on the error display path with the plugin and surface of the view
//! (docs/spec/native-surfaces.md#view-surfaces). The writer of the records is process-wide, so the write runs in a child process.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::process::{Command, Stdio};
use std::time::Duration;

use soksak_host_tauriv2::documents::ViewChannels;

/// The environment variable that tells the child process the configuration directory.
const CHILD: &str = "SOKSAK_VIEW_ERROR_CHILD";

const NAME: &str = "a_view_error_message_is_written_on_the_error_display_path_with_its_view";

// contract: view.error.display
#[test]
fn a_view_error_message_is_written_on_the_error_display_path_with_its_view() {
    if let Some(config) = std::env::var_os(CHILD) {
        let writer = records::start_writer(std::path::Path::new(&config));
        let channels = ViewChannels::default();
        channels.register("probe-surface", "probe");
        // The message is accepted: the view continues, and the record carries the view.
        assert_eq!(
            channels.message(
                "probe-surface",
                r#"{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: boom"}}"#
            ),
            Ok(false)
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
    let errors: Vec<_> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.record.error")
        .collect();
    assert_eq!(errors.len(), 1, "error records: {errors:?}");
    assert_eq!(errors[0]["fields"]["where"], "view probe probe-surface");
    assert_eq!(errors[0]["fields"]["text"], "uncaught error: boom");
}
