use super::{ViewChannels, ViewIngress, accept_view_message};
use crate::event_record::buffered_fields;

// contract: view.origin.retired-callback-is-cancelled
#[test]
fn a_retired_view_callback_is_cancelled_before_dispatch() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe");
    let _current = channels.register_origin("surface", "probe");

    let mut dispatches = 0;
    if accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}"#,
    ) {
        dispatches += 1;
    }
    assert_eq!(dispatches, 0, "the retired call does not reach dispatch");
    assert_eq!(
        channels.ingress(
            "surface",
            &retired,
            r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}"#
        ),
        ViewIngress::Cancelled
    );
    assert!(
        buffered_fields("host.trace.view.callback-cancelled")
            .iter()
            .any(|fields| fields["surface"] == "surface" && fields["reason"] == "retired-origin"),
        "the canceled callback has a trace record"
    );
}

// contract: view.origin.current-callback-is-dispatched
#[test]
fn a_current_view_callback_enters_dispatch() {
    let channels = ViewChannels::default();
    let current = channels.register_origin("surface", "probe");

    assert!(accept_view_message(
        &channels,
        "probe",
        "surface",
        &current,
        r#"{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}"#,
    ));
}

// contract: view.origin.retired-producer-error-is-preserved
#[test]
fn a_retired_view_error_keeps_its_producer_reason() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe");
    let _current = channels.register_origin("surface", "probe");

    let before = buffered_fields("host.record.error").len();
    assert!(
        !accept_view_message(
            &channels,
            "probe",
            "surface",
            &retired,
            r#"{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: origin-test"}}"#,
        ),
        "a retired error does not enter the current channel"
    );
    assert!(
        buffered_fields("host.record.error")[before..]
            .iter()
            .any(|fields| {
                fields["where"] == "view probe surface"
                    && fields["text"] == "uncaught error: origin-test"
            }),
        "the retired producer error keeps its captured plugin and surface"
    );
}

// contract: view.origin.retired-queue-overflow-does-not-fail-current-view
#[test]
fn a_retired_queue_overflow_does_not_fail_the_current_view() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe");
    let current = channels.register_origin("surface", "probe");

    assert!(!accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        r#"{"message":{"event":"view.error","reason":"queue full for probe"}}"#,
    ));
    assert!(
        channels.is_current("surface", &current),
        "a queue overflow from the retired origin leaves its replacement current"
    );
}

// contract: view.origin.retired-malformed-message-is-reported
#[test]
fn a_retired_malformed_message_keeps_its_channel_error() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe");
    let _current = channels.register_origin("surface", "probe");
    let before = buffered_fields("host.record.error").len();

    assert!(!accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        "{malformed",
    ));

    assert!(
        buffered_fields("host.record.error")[before..]
            .iter()
            .any(|fields| {
                fields["where"] == "view channel"
                    && fields["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("surface: view message is not JSON"))
            })
    );
}

// contract: view.origin.retired-transport-error-is-reported
#[test]
fn a_retired_transport_error_keeps_its_channel_error() {
    let channels = ViewChannels::default();
    let retired = channels.register_origin("surface", "probe");
    let _current = channels.register_origin("surface", "probe");
    let before = buffered_fields("host.record.error").len();

    assert!(!accept_view_message(
        &channels,
        "probe",
        "surface",
        &retired,
        r#"{"error":"native producer failed"}"#,
    ));

    assert!(
        buffered_fields("host.record.error")[before..]
            .iter()
            .any(|fields| fields["where"] == "view channel"
                && fields["text"] == "native producer failed")
    );
}

// contract: view.origin.retired-malformed-envelope-is-reported
#[test]
fn a_retired_malformed_envelope_keeps_its_channel_error() {
    for (value, expected) in [
        (
            r#"{"unexpected":true}"#,
            "surface: view message has neither message nor error",
        ),
        (
            r#"{"message":"not-an-object"}"#,
            "surface: view event is not an object",
        ),
    ] {
        let channels = ViewChannels::default();
        let retired = channels.register_origin("surface", "probe");
        let _current = channels.register_origin("surface", "probe");
        let before = buffered_fields("host.record.error").len();

        assert!(!accept_view_message(
            &channels, "probe", "surface", &retired, value,
        ));

        assert!(
            buffered_fields("host.record.error")[before..]
                .iter()
                .any(|fields| {
                    fields["where"] == "view channel"
                        && fields["text"]
                            .as_str()
                            .is_some_and(|text| text.contains(expected))
                })
        );
    }
}
