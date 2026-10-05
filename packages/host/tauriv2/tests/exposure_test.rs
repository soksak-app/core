//! 페이지 요청 중계와 호스트 항목 테스트. 페이지는 요청을 받는 함수가 대신한다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{json, Value};
use soksak_host_tauriv2::exposure::{self, Relay};
use soksak_host_tauriv2::windows::{list_entries, window_entry, ListStep};

const WAIT: Duration = Duration::from_secs(5);

/// 문서가 보내는 응답 텍스트.
fn text(value: Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(&value).unwrap()
}

/// 받은 그대로의 응답 텍스트.
fn text_of(body: &str) -> Box<RawValue> {
    RawValue::from_string(body.to_string()).unwrap()
}

/// 중계한 결과 텍스트를 값으로 읽는다.
fn value(text: &RawValue) -> Value {
    serde_json::from_str(text.get()).unwrap()
}

// contract: exposure.relay.reply-resolves-request
#[test]
fn reply_from_target_document_resolves_request() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", Some(WAIT), move |id| {
        std::thread::spawn(move || {
            replying
                .reply("main", &text(json!({"id": id, "result": {"ok": true}})))
                .unwrap();
        });
        Ok(())
    });
    assert_eq!(value(&result.unwrap()), json!({"ok": true}));
}

// contract: exposure.relay.keeps-value-text
#[test]
fn reply_keeps_the_text_and_key_order_of_the_page_value() {
    // 페이지는 응답을 JSON 텍스트로 보낸다. 중계는 그 값의 키 순서를 바꾸지 않는다.
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", Some(WAIT), move |id| {
        let body = format!(r#"{{"id":{id},"result":{{"zeta":1,"alpha":{{"b":2,"a":1}}}}}}"#);
        let payload = RawValue::from_string(body).unwrap();
        replying.reply("main", &payload).unwrap();
        Ok(())
    });
    assert_eq!(result.unwrap().get(), r#"{"zeta":1,"alpha":{"b":2,"a":1}}"#);
}

// contract: exposure.relay.missing-result-is-null
#[test]
fn missing_result_is_null() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let result = relay.request("main", Some(WAIT), move |id| {
        replying.reply("main", &text(json!({"id": id}))).unwrap();
        Ok(())
    });
    assert_eq!(value(&result.unwrap()), Value::Null);
}

// contract: exposure.relay.error-reply-keeps-code-and-message
#[test]
fn error_reply_keeps_code_and_message() {
    let relay = Arc::new(Relay::default());
    let replying = relay.clone();
    let failure = relay
        .request("main", Some(WAIT), move |id| {
            replying
                .reply(
                    "main",
                    &text(json!({"id": id, "error": {"code": 1002, "message": "not registered"}})),
                )
                .unwrap();
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
            assert!(replying
                .reply("surface-main-a", &text(json!({"id": id, "result": 1})))
                .is_err());
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, 1005);
    assert!(relay
        .reply("main", &text(json!({"id": 1, "result": 1})))
        .is_err());
}

// contract: exposure.relay.late-reply-states-its-delay
#[test]
fn late_reply_states_its_delay() {
    let relay = Relay::default();
    let failure = relay
        .request("main", Some(Duration::from_millis(50)), |_| Ok(()))
        .unwrap_err();
    assert_eq!(
        (failure.code, failure.message.as_str()),
        (1005, "the document did not reply within 50 ms")
    );
    let error = relay
        .reply("main", &text(json!({"id": 1, "result": 1})))
        .unwrap_err();
    let delay = error
        .strip_prefix("exposure reply 1 arrived ")
        .and_then(|rest| {
            rest.strip_suffix(" ms after it was sent; its request timed out after 50 ms")
        });
    assert!(
        delay.is_some_and(
            |delay| !delay.is_empty() && delay.bytes().all(|byte| byte.is_ascii_digit())
        ),
        "{error}"
    );
    assert_eq!(
        relay
            .reply("main", &text(json!({"id": 101, "result": 1})))
            .unwrap_err(),
        "exposure reply 101 has no matching request"
    );
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
    let listed = value(
        &exposure::with_host_entries(&text(json!({
            "status": [{"name": "core.layout", "description": "Layout.", "schema": {}, "registered": true}],
            "commands": [],
            "dom": [],
        })))
        .unwrap(),
    );
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
            "host.buttons",
            "host.dock",
            "host.menu",
            "host.screens",
            "host.sidecars",
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
    assert!(exposure::with_host_entries(&text(json!([]))).is_err());
    // 페이지 항목은 받은 텍스트 그대로 남는다.
    let kept = exposure::with_host_entries(&text_of(r#"{"dom":[],"commands":[],"status":[{"name":"core.layout","schema":{},"description":"Layout."}]}"#)).unwrap();
    assert!(
        kept.get()
            .contains(r#"{"name":"core.layout","schema":{},"description":"Layout."}"#),
        "{}",
        kept.get()
    );
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

// contract: endpoint.input.pointer-button-held-message
#[test]
fn button_held_message_reports_mask_and_frontmost_application() {
    let cases = [
        (
            exposure::ButtonHeld {
                mask: 0x1,
                frontmost: Some(exposure::FrontmostApplication {
                    bundle_identifier: Some("com.example.editor".to_string()),
                    pid: 412,
                }),
            },
            "AppKit reports NSEvent.pressedMouseButtons mask 0x1 while com.example.editor (pid 412) is frontmost; the synthetic press or release was not delivered",
        ),
        (
            exposure::ButtonHeld {
                mask: 0x3,
                frontmost: Some(exposure::FrontmostApplication {
                    bundle_identifier: None,
                    pid: 77,
                }),
            },
            "AppKit reports NSEvent.pressedMouseButtons mask 0x3 while an application without a bundle identifier (pid 77) is frontmost; the synthetic press or release was not delivered",
        ),
        (
            exposure::ButtonHeld {
                mask: 0x1a,
                frontmost: None,
            },
            "AppKit reports NSEvent.pressedMouseButtons mask 0x1a while no application is frontmost; the synthetic press or release was not delivered",
        ),
    ];
    for (held, want) in cases {
        assert_eq!(exposure::button_held_message(&held), want, "{held:?}");
    }
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

/// 시험의 메인 스레드. 다른 스레드가 보낸 작업은 메인 스레드가 다음 작업을 처리하기 전에 차례대로 실행한다.
#[derive(Default)]
struct FakeMain {
    pending: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    running: AtomicBool,
}

impl FakeMain {
    fn run_pending(&self) {
        let tasks = std::mem::take(&mut *self.pending.lock().unwrap());
        for task in tasks {
            task();
        }
    }

    /// tauri-runtime-wry 의 send_user_message 처럼, 메인 스레드에서는 바로 답하고 다른 스레드에서는
    /// 먼저 보낸 작업이 처리된 뒤에 답한다.
    fn query<T>(&self, answer: impl FnOnce() -> T) -> T {
        if !self.running.load(Ordering::SeqCst) {
            self.run_pending();
        }
        answer()
    }

    fn run(&self, step: ListStep) -> Result<Vec<Value>, String> {
        self.run_pending();
        self.running.store(true, Ordering::SeqCst);
        let result = step();
        self.running.store(false, Ordering::SeqCst);
        self.run_pending();
        result
    }
}

/// 시험의 창. 닫기는 runtime 처럼 closing 을 세운 뒤 창을 runtime 에서 뺀다.
struct FakeWindow {
    label: &'static str,
    closing: AtomicBool,
    present: AtomicBool,
    /// closing 을 읽을 때 메인 스레드에 이 창의 닫기를 보낸다.
    close_on_read: AtomicBool,
}

impl FakeWindow {
    fn open(label: &'static str, close_on_read: bool) -> Arc<Self> {
        Arc::new(Self {
            label,
            closing: AtomicBool::new(false),
            present: AtomicBool::new(true),
            close_on_read: AtomicBool::new(close_on_read),
        })
    }
}

fn fake_list(main: &Arc<FakeMain>, windows: &[Arc<FakeWindow>]) -> Result<Value, String> {
    let queries = main.clone();
    list_entries(
        windows.to_vec(),
        |step| main.run(step),
        move |window: &Arc<FakeWindow>| {
            let closing = window.closing.load(Ordering::SeqCst);
            if window.close_on_read.swap(false, Ordering::SeqCst) {
                let closed = window.clone();
                queries.pending.lock().unwrap().push(Box::new(move || {
                    closed.closing.store(true, Ordering::SeqCst);
                    closed.present.store(false, Ordering::SeqCst);
                }));
            }
            let present = || {
                if window.present.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("runtime error: failed to receive message from webview".to_string())
                }
            };
            window_entry(
                window.label,
                closing,
                true,
                String::new(),
                || queries.query(|| present().map(|()| window.label.to_string())),
                || queries.query(|| present().map(|()| false)),
            )
        },
    )
}

// host.windows 는 창의 closing 과 제목, 초점을 한 메인 스레드 단계에서 읽는다. 목록 중에 메인 스레드가
// 처리한 닫기는 그 창을 목록에서 빼거나 넣을 뿐 목록을 실패시키지 않는다.
// contract: exposure.windows.listed-in-one-main-thread-step
#[test]
fn a_close_during_the_list_does_not_fail_the_list() {
    let main = Arc::new(FakeMain::default());
    let windows = [
        FakeWindow::open("main", false),
        FakeWindow::open("w2", true),
    ];
    let entry = |label: &str| json!({"ready": true, "window": label, "title": label, "project": null, "key": false});
    assert_eq!(
        fake_list(&main, &windows),
        Ok(json!([entry("main"), entry("w2")]))
    );
    assert!(windows[1].closing.load(Ordering::SeqCst));
    assert_eq!(fake_list(&main, &windows), Ok(json!([entry("main")])));
}

// contract: exposure.status-change.refuses-host-name
#[test]
fn a_page_status_change_of_a_host_status_is_refused() {
    assert_eq!(
        soksak_host_tauriv2::exposure::check_page_status_change("host.window"),
        Err("the page cannot change host status host.window".to_string())
    );
    assert_eq!(
        soksak_host_tauriv2::exposure::check_page_status_change("core.grid"),
        Ok(())
    );
}
