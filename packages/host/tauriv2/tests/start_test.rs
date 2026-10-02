//! main page 의 시작 문서(docs/spec/native-host.md#page-start)를 검사한다.

use serde_json::json;
use soksak_host_tauriv2::start;

// contract: page.start.document
#[test]
fn start_document_carries_the_workspace_and_the_window_controls() {
    let data = start::start_document(
        &json!({"common": {}, "projects": []}),
        &json!({"controls": {"x": 7.0, "y": 8.0, "w": 52.0, "h": 14.0}, "row": 32.0}),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&data).unwrap(),
        json!({"workspace": {"common": {}, "projects": []},
            "controls": {"controls": {"x": 7.0, "y": 8.0, "w": 52.0, "h": 14.0}, "row": 32.0}})
    );
    assert!(String::from_utf8(data)
        .unwrap()
        .starts_with(r#"{"workspace":"#));
}

// contract: page.start.requires-window
#[test]
fn start_requests_start_the_requesting_main_webview_only() {
    let mut started = vec![];
    let mut start = |webview: &str| {
        started.push(webview.to_string());
        if webview == "gone" {
            Err(start::NO_WINDOW.to_string())
        } else {
            Ok(br#"{"workspace":{},"controls":null}"#.to_vec())
        }
    };
    let response = start::serve(start::START_DOCUMENT_PATH, "main", &mut start);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), br#"{"workspace":{},"controls":null}"#);
    assert_eq!(response.headers()["Content-Type"], "application/json");
    assert_eq!(response.headers()["Cache-Control"], "no-store");
    assert_eq!(
        response.headers()["Access-Control-Allow-Origin"],
        start::PAGE_ORIGIN
    );
    let response = start::serve(start::START_DOCUMENT_PATH, "gone", &mut start);
    assert_eq!(response.status(), 400);
    assert_eq!(
        response.body(),
        b"the start document request names no window\n"
    );
    let response = start::serve("/index.html", "main", &mut start);
    assert_eq!(response.status(), 404);
    assert_eq!(started, vec!["main".to_string(), "gone".to_string()]);
}
