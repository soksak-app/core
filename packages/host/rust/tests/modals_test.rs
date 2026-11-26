//! The replies of modal documents (docs/spec/native-host.md): a reply of a modal that is not the open one is dropped and
//! recorded as `host.overlay.dropped`. The same cases run in the Go host.

use serde_json::json;
use soksak_host::modals::{OpenModal, dropped_pick};

// contract: overlay.pick.dropped-is-recorded
#[test]
fn a_reply_of_a_modal_that_is_not_open_is_dropped_with_the_fields_of_its_record() {
    let open = OpenModal {
        id: "debug".into(),
        instance: 62,
    };
    assert_eq!(dropped_pick(Some(&open), "debug", 62, "save-all"), None);
    let cases = [
        (
            Some(&open),
            "debug",
            61,
            json!({"id": "debug", "instance": 61, "key": "save-all", "open": "debug"}),
        ),
        (
            Some(&open),
            "settings",
            62,
            json!({"id": "settings", "instance": 62, "key": "save-all", "open": "debug"}),
        ),
        (
            None,
            "debug",
            62,
            json!({"id": "debug", "instance": 62, "key": "save-all", "open": ""}),
        ),
    ];
    for (open, id, instance, want) in cases {
        assert_eq!(
            dropped_pick(open, id, instance, "save-all"),
            Some(want),
            "drop of {id} {instance}"
        );
    }
}

// contract: surface-host.dialog-host-stays-on-top
#[test]
fn the_host_marks_the_surface_host_of_each_dialog_surface() {
    for (surface, want) in [
        ("dialog/probe/edit", true),
        ("tab-a", false),
        ("dialogs/probe/edit", false),
        ("space-b/left/probe.section", false),
    ] {
        assert_eq!(
            soksak_host::modals::is_dialog_surface(surface),
            want,
            "{surface}"
        );
    }
}
