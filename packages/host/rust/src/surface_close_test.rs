//! The close of a surface on the main thread (close_surface): it ends the records of the surface in the window records that the close
//! took, and it tells the page of the window only while the window is open.

use std::sync::Arc;

use super::{SurfaceClose, end_closed_surface};
use crate::windows::WindowData;

/// Window records with a current view source of surface by plugin, and its generation.
fn records_with_view(surface: &str, plugin: &str) -> (Arc<WindowData>, u64) {
    let data = Arc::new(WindowData::default());
    let generation = data.view_source_origins.issue_view(surface).unwrap();
    data.documents
        .views()
        .register_origin(surface, plugin, generation);
    (data, generation)
}

// contract: surface-close.closed-window-reports-no-failure
#[test]
fn a_surface_that_closes_after_its_window_closed_reports_no_failure_and_ends_its_view_source() {
    let (data, generation) = records_with_view("tab-a", "probe");
    let closed: Result<Arc<WindowData>, String> = Err("project window is closed".to_string());
    assert_eq!(
        end_closed_surface(&data, &closed, "tab-a"),
        SurfaceClose::default(),
        "a window that closed has no page to tell, so the close reports no failure and sends no notice"
    );
    assert_eq!(
        data.view_source_origins.current_view("tab-a"),
        None,
        "the view source of generation {generation} ends in the records that the close took"
    );
}

// contract: surface-close.open-window-ends-view-source-for-page
#[test]
fn a_surface_that_closes_in_an_open_window_ends_its_view_source_for_the_page() {
    let (data, generation) = records_with_view("tab-a", "probe");
    let open = Ok(Arc::clone(&data));
    assert_eq!(
        end_closed_surface(&data, &open, "tab-a"),
        SurfaceClose {
            abandoned: 0,
            ended: Some(("probe".to_string(), generation)),
            errors: Vec::new(),
        },
        "the page of an open window learns that the view source ended"
    );
}

// contract: view.presentation-wait.surface-close-ends-it
#[test]
fn the_close_of_a_surface_ends_the_presentation_wait_of_its_view_with_the_reason_closed() {
    // The abandoned record is an event of the performance trace, which stores nothing while the trace is off.
    let _trace = crate::performance::test_trace();
    let surface = "tab-close-ends-presentation";
    let (data, generation) = records_with_view(surface, "probe");
    assert!(data.documents.presentation().begin(surface, generation, 41));
    let open = Ok(Arc::clone(&data));

    let close = end_closed_surface(&data, &open, surface);

    assert_eq!(
        close.abandoned, 1,
        "the close ends the one open wait of the view"
    );
    assert!(
        !data.documents.presentation().waits(surface, generation, 41),
        "the wait of the view stays open after the close of its surface"
    );
    let reasons: Vec<_> =
        crate::event_record::buffered_fields_of("host.trace.view.presentation-abandoned", surface)
            .into_iter()
            .map(|fields| fields["reason"].clone())
            .collect();
    assert_eq!(
        reasons,
        [serde_json::json!("closed")],
        "the close of the documents of a surface ends the wait with the reason closed"
    );
}
