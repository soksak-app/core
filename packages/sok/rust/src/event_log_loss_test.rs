//! The writer records a line that it cannot write, because its file cannot be opened, as `log.dropped` in the main file
//! (docs/spec/logging.md#event). The Go writer has the same test for its own file.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::{EventLog, Level, Options};

fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("soksak-loss-{name}-{}", std::process::id()));
    match std::fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("{}: {error}", path.display()),
    }
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn options(directory: &Path, boot: &str) -> Options {
    Options {
        directory: directory.to_path_buf(),
        role: "probe".into(),
        boot: boot.into(),
        layer: "host",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("probe-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: Duration::from_millis(10),
        rotate_bytes: 0,
        pull: None,
        policy_path: None,
        prune: None,
    }
}

fn stored_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{line:?}: {error}")))
        .collect()
}

// contract: log.writer.unwritable-line-is-dropped
#[test]
fn a_line_of_a_file_that_cannot_be_opened_is_reported_as_dropped() {
    let directory = directory("unwritable");
    let log = EventLog::start(options(&directory, "unwritable")).unwrap();
    // The debug file is a directory, so the debug file cannot be opened.
    std::fs::create_dir(log.debug_path()).unwrap();
    assert!(log.emit(Level::Debug, "host.probe.debug", &json!({"n": 1})));
    assert!(log.emit(Level::Info, "host.probe.after", &json!({"n": 2})));
    log.flush(Duration::from_secs(5)).unwrap();
    let lines = stored_lines(log.path());
    let dropped = lines
        .iter()
        .find(|line| line["event"] == "log.dropped" && line["fields"]["channel"] == "debug")
        .unwrap_or_else(|| panic!("no log.dropped record for the debug line in {lines:?}"));
    assert_eq!(dropped["fields"]["count"], 1, "{dropped}");
    assert!(
        dropped["fields"]["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("cannot be opened")),
        "{dropped}"
    );
    assert!(
        lines.iter().any(|line| line["event"] == "host.probe.after"),
        "the main event after the open failure is not written: {lines:?}"
    );
    std::fs::remove_dir_all(&directory).unwrap();
}
