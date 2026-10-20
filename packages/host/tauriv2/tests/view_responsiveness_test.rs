//! The responsiveness notices and the process events of a view (docs/spec/native-surfaces.md#view-surfaces). Each notice writes its
//! trace event and returns its window event, and the process events are written once for each view. The same cases run in the Go
//! host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::documents::{
    ViewChannels, record_view_process_ready, record_view_process_request,
    view_responsiveness_notice,
};
use soksak_host_tauriv2::event_log::{EventLog, Options};
use soksak_host_tauriv2::event_record::use_host_event_log;

/// The records of the host are process-wide, so the tests of this file run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// A writer attached to the records of the host, which stores each record in the events file of the configuration directory.
fn writer(config: &Path) -> Arc<EventLog> {
    use_host_event_log(None);
    let log = Arc::new(
        records::start_every_level(Options {
            directory: config.join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 1 << 16,
            queue_bytes: 64 << 20,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: None,
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    use_host_event_log(Some(Arc::clone(&log)));
    log
}

/// The fields of each stored event of name, in the order of the file.
fn stored(log: &EventLog, config: &Path, name: &str) -> Vec<Value> {
    log.flush(Duration::from_secs(5)).unwrap();
    records::read_events(&records::event_log_path(config))
        .into_iter()
        .filter(|event| event["event"] == name)
        .map(|event| event["fields"].clone())
        .collect()
}

// contract: view.responsiveness.relay
#[test]
fn an_unresponsive_and_a_responsive_notice_write_their_trace_and_return_their_window_event() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = writer(config.path());

    let unresponsive = view_responsiveness_notice("probe-surface", "probe", false);
    assert_eq!(
        unresponsive["surface"], "probe-surface",
        "the window event names the surface"
    );
    assert_eq!(
        unresponsive["plugin"], "probe",
        "the window event names the plugin"
    );
    assert_eq!(
        unresponsive["responsive"], false,
        "the unresponsive notice is responsive false"
    );
    assert_eq!(
        stored(&log, config.path(), "host.trace.view.unresponsive"),
        vec![json!({"plugin": "probe", "surface": "probe-surface"})],
        "the unresponsive notice writes its trace once"
    );

    let responsive = view_responsiveness_notice("probe-surface", "probe", true);
    assert_eq!(
        responsive["responsive"], true,
        "the responsive notice is responsive true"
    );
    assert_eq!(
        stored(&log, config.path(), "host.trace.view.responsive"),
        vec![json!({"plugin": "probe", "surface": "probe-surface"})],
        "the responsive notice writes its trace once"
    );
    use_host_event_log(None);
}

// contract: view.process.events
#[test]
fn creating_a_view_writes_the_request_and_its_first_ready_message_writes_the_ready_event_once() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let log = writer(config.path());

    record_view_process_request("probe-surface", "probe");
    assert_eq!(
        stored(&log, config.path(), "host.trace.view.process-request"),
        vec![json!({"plugin": "probe", "surface": "probe-surface"})],
        "creating the view writes the process request"
    );

    let channels = ViewChannels::default();
    channels.register("probe-surface", "probe");
    assert_eq!(
        channels.first_ready("probe-surface"),
        Some("probe".to_string()),
        "the first ready message of the view is the first"
    );
    assert_eq!(
        channels.first_ready("probe-surface"),
        None,
        "a later ready message of the view is not the first"
    );
    record_view_process_ready("probe-surface", "probe");
    assert_eq!(
        stored(&log, config.path(), "host.trace.view.process-ready"),
        vec![json!({"plugin": "probe", "surface": "probe-surface"})],
        "the first ready message writes the ready event"
    );
    use_host_event_log(None);
}
