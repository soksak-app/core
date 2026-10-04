//! 탭 알림을 운영체제의 알림 센터로 게시한다(docs/spec/plugins.md#tab-reports).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};

use crate::application_log::log_error;
use crate::exposure;
use crate::platform;
use crate::windows::emit_window;

/// 탭 하나의 시스템 알림이다. 지울 때는 surface 만 쓴다.
#[derive(Debug, Deserialize)]
pub struct NotificationRequest {
    pub surface: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

/// 알림 센터의 권한과 권한 요청, 게시, 제거의 마지막 실패다.
#[derive(Clone, Default, Serialize)]
pub struct NotificationState {
    authorization: String,
    error: Option<String>,
}

/// 알림 센터가 마지막으로 알린 권한 상태.
static STATE: Mutex<NotificationState> = Mutex::new(NotificationState {
    authorization: String::new(),
    error: None,
});

/// 제어 문자 없는 1 에서 limit 글자의 텍스트만 허용한다.
fn notification_text(field: &str, value: &str, limit: usize) -> Result<(), String> {
    let length = value.chars().count();
    if length == 0 || length > limit || value.chars().any(char::is_control) {
        return Err(format!(
            "notification {field} must be 1 to {limit} characters without control characters"
        ));
    }
    Ok(())
}

/// 알림 요청을 확인한다. removal 이면 표면만 확인한다.
pub fn validate_notification(request: &NotificationRequest, removal: bool) -> Result<(), String> {
    notification_text("surface", &request.surface, 256)?;
    if removal {
        return Ok(());
    }
    notification_text("title", &request.title, 256)?;
    notification_text("body", &request.body, 1024)
}

/// 알림 센터의 식별자다. 누른 알림을 창 이름과 표면으로 돌려받는다.
fn identifier(window: &str, surface: &str) -> String {
    serde_json::json!([window, surface]).to_string()
}

/// 알림 센터를 쓰기 시작한다. 애플리케이션 준비 중 메인 스레드에서 한 번 부른다.
pub(crate) fn start(app: &AppHandle) -> Result<(), String> {
    let handle = app.clone();
    platform::current()?
        .start_notifications(Box::new(move |raw| event(&handle, raw)))
        .map_err(|error| format!("system notifications: {error}"))
}

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    authorization: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    identifier: String,
}

/// 알림 센터의 사건을 창에 알린다. 권한 상태는 모든 창에, 누른 알림은 그 창에 간다.
fn event(app: &AppHandle, raw: String) {
    let parsed: Event = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(error) => return failed(app, format!("notification event {raw:?}: {error}")),
    };
    match parsed.kind.as_str() {
        "state" => {
            if let Ok(mut state) = STATE.lock() {
                *state = NotificationState {
                    authorization: parsed.authorization,
                    error: parsed.error,
                };
            }
            emit_state(app);
        }
        kind @ ("posted" | "activated") => {
            // 기본값: 읽지 못한 식별자는 빈 목록이 되어 바로 아래에서 알림 실패로 보고된다.
            let target: Vec<String> = serde_json::from_str(&parsed.identifier).unwrap_or_default();
            let [window, surface] = target.as_slice() else {
                return failed(
                    app,
                    format!(
                        "{kind} notification {:?} has no window and surface",
                        parsed.identifier
                    ),
                );
            };
            let Some(owner) = app.get_window(window) else {
                return failed(
                    app,
                    format!("the window {window:?} of a {kind} notification is closed"),
                );
            };
            if kind == "activated" {
                if let Err(error) = owner.show().and_then(|()| owner.set_focus()) {
                    return failed(
                        app,
                        format!("focus the window of an activated notification: {error}"),
                    );
                }
            }
            let name = format!("notification-{kind}");
            if let Err(error) =
                emit_window(&owner, &name, serde_json::json!({ "surface": surface }))
            {
                failed(app, format!("{name}: {error}"));
            }
        }
        _ => failed(
            app,
            format!("notification event {raw:?} has an unknown type"),
        ),
    }
}

/// 실패를 알림 상태의 오류로 모든 창에 알린다.
fn failed(app: &AppHandle, reason: String) {
    if let Ok(mut state) = STATE.lock() {
        state.error = Some(reason);
    }
    emit_state(app);
}

fn emit_state(app: &AppHandle) {
    let Ok(state) = STATE.lock().map(|state| state.clone()) else {
        log_error(
            "notification-state",
            "the notification state lock is poisoned",
        );
        return;
    };
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "notification-state", state.clone()) {
            log_error("notification-state", error);
        }
    }
}

/// 마지막으로 알린 권한 상태를 반환한다. 페이지가 시작할 때 읽는다.
pub(crate) fn state() -> Result<NotificationState, String> {
    STATE
        .lock()
        .map(|state| state.clone())
        .map_err(|error| error.to_string())
}

/// 호출한 창의 탭 알림을 시스템 알림으로 게시한다.
pub(crate) fn notify(window: &Window, request: NotificationRequest) -> Result<(), String> {
    validate_notification(&request, false)?;
    let name = identifier(window.label(), &request.surface);
    exposure::on_main(window, move || {
        platform::current()?.post_notification(&name, &request.title, &request.body)
    })
}

/// 호출한 창의 탭 알림을 지운다.
pub(crate) fn remove(window: &Window, request: NotificationRequest) -> Result<(), String> {
    validate_notification(&request, true)?;
    let name = identifier(window.label(), &request.surface);
    exposure::on_main(window, move || {
        platform::current()?.remove_notification(&name)
    })
}
