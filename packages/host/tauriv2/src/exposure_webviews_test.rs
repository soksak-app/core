use super::*;

// contract: window.facts.plugin-host-webviews-are-counted-apart
#[test]
fn window_status_counts_plugin_host_webviews_apart() {
    let facts = json!({"appDomWebviews": 2, "documentWebviews": 1, "pluginHostWebviews": 1});
    assert_eq!(window_webview_counts(&facts).unwrap(), (2, 1, 1));
    let view = json!({"view": 33, "x": 0, "y": 0, "width": 0, "height": 0, "main": false, "document": false,
        "pluginHost": true, "hidden": true, "focused": false});
    let row = window_webview_row(3, &view).unwrap();
    assert_eq!(
        (
            &row["pluginHost"],
            &row["main"],
            &row["document"],
            &row["visible"],
            &row["order"]
        ),
        (
            &json!(true),
            &json!(false),
            &json!(false),
            &json!(false),
            &json!(3)
        ),
        "plugin host row {row}"
    );
}

// contract: window.facts.modal-order-is-above-every-webview
#[test]
fn modal_order_is_above_every_native_surface_and_webview() {
    // Two native surfaces have the orders 0 and 1, and five web views have the orders 0 to 4.
    assert_eq!(modal_order(2, 5), 7);
}

// contract: window.facts.document-reports-its-blur
#[test]
fn window_document_reports_its_native_blur() {
    let view = |blurred: bool| {
        json!({"view": 7, "x": 0, "y": 0, "width": 0, "height": 0, "hidden": false,
        "focused": false, "process": 0, "blurred": blurred})
    };
    let entry = window_document("tab-a", "page", 2, &view(true)).unwrap();
    assert_eq!(
        entry["blurred"],
        json!(true),
        "document entry {entry} of a blurred web view"
    );
    let entry = window_document("tab-a", "page", 2, &view(false)).unwrap();
    assert_eq!(
        entry["blurred"],
        json!(false),
        "document entry {entry} of a web view without a filter"
    );
}
