//! The events of the application (docs/spec/logging.md#automatic-entrances): every event that a host registers for the
//! application is the event `host.app.event` with the kind.

use crate::event_log::Level;

/// The kinds of an application event. A host stores the kinds its framework reports.
const KINDS: [&str; 6] = [
    "started",
    "activated",
    "deactivated",
    "reopened",
    "exit_requested",
    "exit",
];

/// Stores an application event of the kind. A kind outside `KINDS` is reported on the standard error and nothing is stored.
pub fn record_app_event(kind: &str) {
    if !KINDS.contains(&kind) {
        eprintln!("event writer: the application event kind {kind:?} is not declared");
        return;
    }
    crate::event_record::emit_host(
        Level::Info,
        "host.app.event",
        serde_json::json!({"kind": kind}),
    );
}
