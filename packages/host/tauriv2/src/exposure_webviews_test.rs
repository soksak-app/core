use super::*;

// contract: window.facts.modal-order-is-above-every-webview
#[test]
fn modal_order_is_above_every_native_surface_and_webview() {
    // Two native surfaces have the orders 0 and 1, and five web views have the orders 0 to 4.
    assert_eq!(modal_order(2, 5), 7);
}

// contract: window.facts.modal-order-is-above-every-webview
#[test]
fn modal_order_is_above_the_first_webview_without_native_surfaces() {
    // Without native surfaces, a document region at web view index 0 has order 0, so the modal must have an order above 0.
    for webviews in 1..=5 {
        for index in 0..webviews {
            let order = modal_order(0, webviews);
            assert!(
                order > index,
                "modal order {order} with no native surface and {webviews} web views, want above the web view index {index}"
            );
        }
    }
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
