//! The deferred end of a presentation wait on the main thread (end_ticket_waits): it ends the join in the records of an open window,
//! and a window that closed before the end ran has no join to end.

use std::sync::Arc;

use super::end_ticket_waits;
use crate::windows::WindowData;

// contract: presentation-end.closed-window-ends-nothing
#[test]
fn a_deferred_end_after_its_window_closed_ends_nothing_and_reports_no_failure() {
    let closed: Result<Arc<WindowData>, String> = Err("project window is closed".to_string());
    assert_eq!(
        end_ticket_waits(&closed, "tab-a", 1, 7, "input"),
        Ok(0),
        "the close of a window abandons its presentation waits, so a deferred end that runs after it has nothing to end"
    );
}

// contract: presentation-end.open-window-ends-join
#[test]
fn a_deferred_end_in_an_open_window_ends_its_join() {
    let data = Arc::new(WindowData::default());
    assert!(data.documents.presentation().begin("tab-a", 1, 7));
    assert_eq!(
        end_ticket_waits(&Ok(Arc::clone(&data)), "tab-a", 1, 7, "hidden"),
        Ok(1),
        "the join of an open window ends without presentation"
    );
    assert!(!data.documents.presentation().waits("tab-a", 1, 7));
}

// contract: view.presentation-wait.ends-at-input
// Two key downs that come before the view presented its change are ordinary input of a person: the first ends the wait and the
// view hears view-presentation-abandoned, the second finds no wait to end, and neither writes an error record
// (docs/spec/native-surfaces.md#layout-transaction, docs/spec/diagnostics.md).
#[test]
fn keys_before_the_presentation_write_no_error_record() {
    let _trace = crate::performance::test_trace();
    let surface = "keys-before-presentation";
    let data = Arc::new(WindowData::default());
    assert!(data.documents.presentation().begin(surface, 1, 7));
    let mut notices = Vec::new();
    for _ in 0..2 {
        let ended = end_ticket_waits(&Ok(Arc::clone(&data)), surface, 1, 7, "input");
        super::report_ended_presentation_waits_to(
            &mut |payload| {
                notices.push(payload);
                Ok(())
            },
            surface,
            "input",
            ended,
        );
    }
    assert_eq!(
        crate::event_record::buffered_fields_of("host.trace.view.presentation-abandoned", surface)
            .len(),
        1,
        "the first key down ends the wait once and the second finds none"
    );
    assert_eq!(notices.len(), 1, "the view hears one abandoned notice");
    let errors: Vec<_> = crate::event_record::buffered_fields("host.record.error")
        .into_iter()
        .filter(|fields| {
            fields["text"]
                .as_str()
                .is_some_and(|text| text.contains(surface))
        })
        .collect();
    assert!(
        errors.is_empty(),
        "keys before the presentation wrote error records {errors:?}"
    );
}
