//! 페이지 요청 중계와 호스트 항목 테스트. 페이지는 요청을 받는 함수가 대신한다.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use soksak_host_tauriv2::exposure::{self, Relay};
use soksak_host_tauriv2::windows::window_entry;

const WAIT: Duration = Duration::from_secs(5);

// contract: exposure.relay.reply-resolves-request
#[test]
fn reply_from_target_document_resolves_request() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", Some(WAIT), move |id| {
        std::thread::spawn(move || {
            assert!(replying.reply("main", &json!({"id": id, "result": {"ok": true}})));
        });
        Ok(())
    });
    assert_eq!(result.unwrap(), json!({"ok": true}));
}

// contract: exposure.relay.missing-result-is-null
#[test]
fn missing_result_is_null() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", Some(WAIT), move |id| {
        assert!(replying.reply("main", &json!({"id": id})));
        Ok(())
    });
    assert_eq!(result.unwrap(), Value::Null);
}

// contract: exposure.relay.error-reply-keeps-code-and-message
#[test]
fn error_reply_keeps_code_and_message() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let failure = relay
        .request("main", Some(WAIT), move |id| {
            replying.reply(
                "main",
                &json!({"id": id, "error": {"code": 1002, "message": "not registered"}}),
            );
            Ok(())
        })
        .unwrap_err();
    assert_eq!(
        (failure.code, failure.message.as_str()),
        (1002, "not registered")
    );
}

// contract: exposure.relay.foreign-document-reply-ignored-timeout-1005
#[test]
fn reply_from_another_document_is_ignored_and_request_times_out() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let failure = relay
        .request("main", Some(Duration::from_millis(50)), move |id| {
            assert!(!replying.reply("surface-main-a", &json!({"id": id, "result": 1})));
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, 1005);
    assert!(!relay.reply("main", &json!({"id": 1, "result": 1})));
}

// contract: exposure.relay.send-failure-1003
#[test]
fn send_failure_is_reported_without_waiting() {
    let relay = Relay::default();
    let failure = relay
        .request("main", Some(WAIT), |_| Err("webview is gone".into()))
        .unwrap_err();
    assert_eq!(failure.code, 1003);
}

// contract: exposure.relay.closed-document-fails-pending-1003
#[test]
fn closed_document_fails_its_pending_requests() {
    let relay = Arc::new(Relay::default());
    let closing = relay.clone();
    let failure = relay
        .request("main", Some(WAIT), move |_| {
            closing.abandon("main");
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, 1003);
}

// contract: exposure.relay.no-timeout-waits-until-close
#[test]
fn request_without_timeout_waits_until_the_document_closes() {
    let relay = Arc::new(Relay::default());
    let closing = relay.clone();
    let failure = relay
        .request("surface-main-a", None, move |_| {
            // 응답 대기가 시작된 뒤 다른 스레드가 문서 종료를 알린다.
            std::thread::spawn(move || closing.abandon("surface-main-a"));
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, 1003);
}

// contract: exposure.list.appends-host-entries-registered, exposure.list.host-entries-exact-sorted-set, exposure.list.host-entries-described, exposure.list.host-quit-result-null, exposure.list.non-object-list-rejected
#[test]
fn host_entries_are_appended_as_registered() {
    let listed = exposure::with_host_entries(json!({
        "status": [{"name": "core.layout", "description": "Layout.", "schema": {}, "registered": true}],
        "commands": [],
        "dom": [],
    }))
    .unwrap();
    let status: Vec<&str> = listed["status"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        status,
        [
            "core.layout",
            "host.dock",
            "host.menu",
            "host.screens",
            "host.window",
            "host.windows"
        ]
    );
    let commands: Vec<&str> = listed["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        commands,
        [
            "host.dock.select",
            "host.hit",
            "host.menu.select",
            "host.quit",
            "host.window.close",
            "host.window.fullscreen",
            "host.window.maximize",
            "host.window.move",
            "host.window.presented",
            "host.window.reload",
            "host.window.resize",
        ]
    );
    for entry in listed["status"]
        .as_array()
        .unwrap()
        .iter()
        .chain(listed["commands"].as_array().unwrap())
    {
        assert_eq!(entry["registered"], true);
        assert!(entry["description"].as_str().is_some_and(|d| !d.is_empty()));
    }
    let quit = listed["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "host.quit")
        .unwrap();
    assert_eq!(quit["result"], json!({"type": "null"}));
    assert!(exposure::with_host_entries(json!([])).is_err());
}

// contract: endpoint.input.pointer-invalid-phase, endpoint.input.pointer-missing-coordinate, endpoint.input.pointer-numeric-button-rejected, endpoint.input.pointer-middle-button-rejected, endpoint.input.pointer-activate-only-on-move, endpoint.input.pointer-activate-must-be-bool, endpoint.input.pointer-defaults, endpoint.input.pointer-right-button-accepted, endpoint.input.pointer-phase-and-scroll-decoding, endpoint.input.key-unknown-modifier-rejected, endpoint.input.key-shift-command-mask, endpoint.input.key-control-option-and-text, endpoint.input.key-invalid-phase-or-modifier-type
#[test]
fn pointer_and_key_params_are_validated() {
    let pointer = exposure::pointer(
        &json!({"x": 1.5, "y": 2, "phase": "drag"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (pointer.x, pointer.y, pointer.phase, pointer.button),
        (1.5, 2.0, 2, 0)
    );
    let scroll = exposure::pointer(
        &json!({"x": 0, "y": 0, "phase": "scroll", "deltaY": -3, "button": "right"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!((scroll.phase, scroll.button, scroll.delta_y), (4, 1, -3.0));
    assert_eq!(
        exposure::pointer(
            &json!({"x": 0, "y": 0, "phase": "press"})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        exposure::pointer(
            &json!({"y": 0, "phase": "move"})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    let moved = exposure::pointer(
        &json!({"x": 0, "y": 0, "phase": "move", "activate": true})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert!(moved.activate);
    assert!(!pointer.activate);
    for params in [
        json!({"x": 0, "y": 0, "phase": "down", "activate": true}),
        json!({"x": 0, "y": 0, "phase": "move", "activate": "yes"}),
        json!({"x": 0, "y": 0, "phase": "down", "button": "middle"}),
        json!({"x": 0, "y": 0, "phase": "down", "button": 1}),
    ] {
        assert_eq!(
            exposure::pointer(params.as_object().unwrap())
                .unwrap_err()
                .code,
            -32602,
            "{params}"
        );
    }

    let key = exposure::key(
        &json!({"key": "Enter", "phase": "down", "modifiers": ["shift", "command"]})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (key.key.as_str(), key.text, key.modifiers, key.down),
        ("Enter", None, 9, true)
    );
    let key = exposure::key(
        &json!({"key": "a", "text": "A", "phase": "up", "modifiers": ["control", "option"]})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(
        (key.text.as_deref(), key.modifiers, key.down),
        (Some("A"), 6, false)
    );
    assert_eq!(
        exposure::key(
            &json!({"key": "a", "phase": "down", "modifiers": 2})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        exposure::key(
            &json!({"key": "a", "phase": "hold"})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        exposure::key(
            &json!({"key": "a", "phase": "down", "modifiers": ["hyper"]})
                .as_object()
                .unwrap()
                .clone()
        )
        .unwrap_err()
        .code,
        -32602
    );
}

// contract: exposure.timeout.command-run-default-and-declared, exposure.timeout.status-next-unbounded, exposure.timeout.invalid-timeout-rejected, exposure.timeout.status-next-timeout-rejected
#[test]
fn forwarded_requests_use_the_declared_timeout() {
    assert_eq!(
        exposure::forward_timeout("command.run", &Value::Null).unwrap(),
        Some(exposure::TIMEOUT)
    );
    assert_eq!(
        exposure::forward_timeout("command.run", &json!(600000)).unwrap(),
        Some(Duration::from_secs(600))
    );
    assert_eq!(
        exposure::forward_timeout("command.run", &json!(1)).unwrap(),
        Some(Duration::from_millis(1))
    );
    assert_eq!(
        exposure::forward_timeout("status.next", &Value::Null).unwrap(),
        None
    );
    for invalid in [json!(0), json!(600001), json!(1.5), json!("10"), json!(-1)] {
        let error = exposure::forward_timeout("command.run", &invalid).unwrap_err();
        assert_eq!(error.code, -32602, "{invalid}");
    }
    assert_eq!(
        exposure::forward_timeout("status.next", &json!(10))
            .unwrap_err()
            .code,
        -32602
    );
}

// contract: endpoint.names.unknown-host-name-1001
#[test]
fn undeclared_host_names_are_unknown() {
    for (method, name) in [
        ("command.run", "host.nope"),
        ("status.get", "host.nope"),
        ("command.run", "host.window"),
    ] {
        let failure = exposure::check_host_name(method, name).unwrap_err();
        assert_eq!(failure.code, 1001, "{method} {name}: {}", failure.message);
    }
    for (method, name) in [
        ("status.get", "host.window"),
        ("status.watch", "host.windows"),
        ("command.run", "host.quit"),
    ] {
        assert!(
            exposure::check_host_name(method, name).is_ok(),
            "{method} {name}"
        );
    }
}

// contract: exposure.window.dropped-view-work-reports-no-view
#[test]
fn view_work_dropped_by_a_closing_webview_reports_no_result() {
    let (tx, rx) = std::sync::mpsc::channel::<Result<u64, String>>();
    drop(tx);
    assert_eq!(exposure::received(&rx), Ok(None));
    let (tx, rx) = std::sync::mpsc::channel::<Result<u64, String>>();
    tx.send(Ok(7)).unwrap();
    assert_eq!(exposure::received(&rx), Ok(Some(7)));
    let (tx, rx) = std::sync::mpsc::channel::<Result<u64, String>>();
    tx.send(Err("view failed".into())).unwrap();
    assert_eq!(exposure::received(&rx), Err("view failed".into()));
}

// host.windows 목록 항목은 닫기가 받아들여진 창을 빼고, 다른 창의 조회 실패는 오류로 보고한다.
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
