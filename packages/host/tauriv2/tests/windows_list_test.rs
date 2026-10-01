//! host.windows 목록 항목이 닫기가 받아들여진 창을 빼고, 다른 창의 조회 실패는 오류로 보고하는지 검사한다.
use serde_json::json;
use soksak_host_tauriv2::windows::window_entry;

// contract: exposure.windows.closing-window-omitted
#[test]
fn a_closing_window_is_left_out_without_querying_it() {
    let entry = window_entry(
        "w2",
        true,
        true,
        String::new(),
        || panic!("the title of a closing window was queried"),
        || panic!("the focus of a closing window was queried"),
    );
    assert_eq!(entry, Ok(None));
}

// contract: exposure.windows.open-window-query-failure-reported
#[test]
fn a_failed_query_of_an_open_window_is_reported() {
    let entry = window_entry(
        "main",
        false,
        true,
        String::new(),
        || Err("runtime error: failed to receive message from webview".into()),
        || Ok(true),
    );
    assert_eq!(
        entry,
        Err("runtime error: failed to receive message from webview".into())
    );
}

// contract: exposure.windows.entry-fields
#[test]
fn an_open_window_lists_its_title_project_and_key_state() {
    let entry = window_entry(
        "main",
        false,
        true,
        "/tmp/project".into(),
        || Ok("project".into()),
        || Ok(false),
    );
    assert_eq!(
        entry,
        Ok(Some(json!({
            "ready": true, "window": "main", "title": "project",
            "project": "/tmp/project", "key": false,
        })))
    );
}
