//! Checks the record of the start of a page: its cause and the number of views that it ends.

use super::*;

/// The `host.page.started` records whose view count is `views`, which only this test uses.
fn page_starts(views: usize) -> Vec<serde_json::Value> {
    crate::event_record::buffered_fields("host.page.started")
        .into_iter()
        .filter(|fields| fields["views"] == views)
        .collect()
}

// A start of a page records its cause and the number of views that it ends: the host operation that started the workbench once, and
// page for a start that no host operation asked for.
// contract: host.page.started.names-its-cause
#[test]
fn a_page_start_records_its_cause_and_the_views_that_it_ends() {
    let data = WindowData::default();
    {
        let mut hosts = data.surface_hosts.lock().unwrap();
        for (number, surface) in ["a", "b", "c", "d", "e", "f", "g"].iter().enumerate() {
            hosts.insert((*surface).to_string(), number);
        }
    }
    *data.start_cause.lock().unwrap() = Some("host.window.reload");
    record_page_start(&data);
    record_page_start(&data);
    assert_eq!(
        page_starts(7),
        vec![
            serde_json::json!({"cause": "host.window.reload", "views": 7}),
            serde_json::json!({"cause": "page", "views": 7}),
        ]
    );
}
