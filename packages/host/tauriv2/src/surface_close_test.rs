//! The close of a surface on the main thread (close_surface): it ends the records of the surface in the window records that the close
//! took, and it tells the page of the window only while the window is open.

use std::sync::Arc;

use super::{SurfaceClose, end_closed_surface};
use crate::windows::WindowData;

/// Window records with a current view source of surface by plugin, and its generation.
fn records_with_view(surface: &str, plugin: &str) -> (Arc<WindowData>, u64) {
    let data = Arc::new(WindowData::default());
    let generation = data.declared_source_origins.issue_view(surface).unwrap();
    data.documents
        .views()
        .register_origin(surface, plugin, generation);
    (data, generation)
}

// contract: tauriv2.surface-close.closed-window-reports-no-failure
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
        data.declared_source_origins.current_view("tab-a"),
        None,
        "the view source of generation {generation} ends in the records that the close took"
    );
}

// contract: tauriv2.surface-close.open-window-ends-view-source-for-page
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
