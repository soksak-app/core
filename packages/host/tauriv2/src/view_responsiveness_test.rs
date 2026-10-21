//! The responsiveness notices and the process events of a view (docs/spec/native-surfaces.md#view-surfaces). Each notice writes its
//! trace event and returns its window event, and the process events are written once for each view. The same cases run in the Go
//! host.

use serde_json::{Value, json};

use super::{
    ViewChannels, record_view_process_ready, record_view_process_request,
    view_responsiveness_notice,
};
use crate::event_record::buffered_fields;

/// The fields of each buffered record of event name that belongs to surface.
fn traces(name: &str, surface: &str) -> Vec<Value> {
    buffered_fields(name)
        .into_iter()
        .filter(|fields| fields["surface"] == surface)
        .collect()
}

// contract: view.responsiveness.relay
#[test]
fn an_unresponsive_and_a_responsive_notice_write_their_trace_and_return_their_window_event() {
    let surface = "responsive-probe-surface";
    let unresponsive = view_responsiveness_notice(surface, "probe", false);
    assert_eq!(
        unresponsive["surface"], surface,
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
        traces("host.trace.view.unresponsive", surface),
        vec![json!({"plugin": "probe", "surface": surface})],
        "the unresponsive notice writes its trace once"
    );

    let responsive = view_responsiveness_notice(surface, "probe", true);
    assert_eq!(
        responsive["responsive"], true,
        "the responsive notice is responsive true"
    );
    assert_eq!(
        traces("host.trace.view.responsive", surface),
        vec![json!({"plugin": "probe", "surface": surface})],
        "the responsive notice writes its trace once"
    );
}

// contract: view.process.events
#[test]
fn creating_a_view_writes_the_request_and_its_first_ready_message_writes_the_ready_event_once() {
    let surface = "process-probe-surface";
    record_view_process_request(surface, "probe");
    assert_eq!(
        traces("host.trace.view.process-request", surface),
        vec![json!({"plugin": "probe", "surface": surface})],
        "creating the view writes the process request"
    );

    let channels = ViewChannels::default();
    channels.register(surface, "probe");
    assert_eq!(
        channels.first_ready(surface),
        Some("probe".to_string()),
        "the first ready message of the view is the first"
    );
    assert_eq!(
        channels.first_ready(surface),
        None,
        "a later ready message of the view is not the first"
    );
    record_view_process_ready(surface, "probe");
    assert_eq!(
        traces("host.trace.view.process-ready", surface),
        vec![json!({"plugin": "probe", "surface": surface})],
        "the first ready message writes the ready event"
    );
}
