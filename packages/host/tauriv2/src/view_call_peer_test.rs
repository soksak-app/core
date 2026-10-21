//! The open calls of a view when its process ends (docs/spec/native-surfaces.md#view-surfaces): each call that the view has open
//! ends with the reason process-ended, and the host writes host.call.peer-lost for it. A call that the main page answered is no
//! longer open. The same cases run in the Go host.

use super::{ViewChannels, record_view_call_peer_lost};
use crate::event_record::buffered_fields;

// contract: view.call.peer-lost
#[test]
fn a_view_process_end_ends_each_open_view_call_with_its_plugin_and_command() {
    let surface = "peer-probe-surface";
    let channels = ViewChannels::default();
    channels.register(surface, "probe");
    let payload = channels
        .call(
            surface,
            r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{"a":1}}}"#,
        )
        .expect("the view call is valid");
    assert!(
        payload.is_some(),
        "the view call is forwarded to the main page"
    );

    let ended = channels.end_calls(surface);
    assert_eq!(
        ended,
        vec![("probe".to_string(), "probe.run".to_string())],
        "the open view call ends with its plugin and command"
    );
    for (plugin, command) in &ended {
        record_view_call_peer_lost(plugin, command);
    }
    let written: Vec<_> = buffered_fields("host.call.peer-lost")
        .into_iter()
        .filter(|fields| fields["command"] == "probe.run")
        .collect();
    assert_eq!(
        written.len(),
        1,
        "one host.call.peer-lost is written for the call"
    );
    assert_eq!(written[0]["plugin"], "probe");
    assert_eq!(written[0]["reason"], "process-ended");
}

// contract: view.call.peer-lost
#[test]
fn a_view_call_answered_by_the_main_page_is_not_open_at_the_process_end() {
    let surface = "answered-probe-surface";
    let channels = ViewChannels::default();
    channels.register(surface, "probe");
    channels
        .call(
            surface,
            r#"{"message":{"sok":1,"id":8,"command":"probe.run","params":{}}}"#,
        )
        .expect("the view call is valid");
    channels.answer_call(surface, 8);
    assert!(
        channels.end_calls(surface).is_empty(),
        "an answered call is not open at the process end"
    );
}
