//! Posts tab notifications to the notification center of the operating system (docs/spec/plugins.md#tab-reports).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};

use crate::application_log::log_error;
use crate::exposure;
use crate::platform;
use crate::windows::emit_window;

/// The system notification of one tab. Only surface is used to clear it.
#[derive(Debug, Deserialize)]
pub struct NotificationRequest {
    pub surface: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

/// The permission of the notification center and the last failure of a permission request, a post and a removal.
#[derive(Clone, Default, Serialize)]
pub struct NotificationState {
    authorization: String,
    error: Option<String>,
}

/// The permission state that the notification center reported last.
static STATE: Mutex<NotificationState> = Mutex::new(NotificationState {
    authorization: String::new(),
    error: None,
});

/// Allows only text of 1 to limit characters without control characters.
fn notification_text(field: &str, value: &str, limit: usize) -> Result<(), String> {
    let length = value.chars().count();
    if length == 0 || length > limit || value.chars().any(char::is_control) {
        return Err(format!(
            "notification {field} must be 1 to {limit} characters without control characters"
        ));
    }
    Ok(())
}

/// Checks a notification request. For removal, only the surface is checked.
pub fn validate_notification(request: &NotificationRequest, removal: bool) -> Result<(), String> {
    notification_text("surface", &request.surface, 256)?;
    if removal {
        return Ok(());
    }
    notification_text("title", &request.title, 256)?;
    notification_text("body", &request.body, 1024)
}

/// The identifier of the notification center. A notification that was pressed is returned as a window name and a
/// surface.
fn identifier(window: &str, surface: &str) -> String {
    serde_json::json!([window, surface]).to_string()
}

/// Starts to use the notification center. It is called once on the main thread while the application is being prepared.
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

/// An event that the notification center reported and that has been recorded.
pub enum Reported {
    /// The permission state and the last failure.
    State(NotificationState),
    /// The notification of the surface `surface` of the window `window` was posted (`posted`) or pressed (`activated`).
    Notice {
        kind: String,
        window: String,
        surface: String,
    },
}

/// Interprets one event of the notification center and records it as the event `host.notification.event`. An event that
/// cannot be interpreted and a failure that the notification center reported are recorded as an error of
/// `notification`, and an event that could not be interpreted returns its reason as an error.
pub fn record_event(raw: &str) -> Result<Reported, String> {
    let rejected = |reason: String| {
        log_error("notification", &reason);
        Err(reason)
    };
    let parsed: Event = match serde_json::from_str(raw) {
        Ok(parsed) => parsed,
        Err(error) => return rejected(format!("notification event {raw:?}: {error}")),
    };
    match parsed.kind.as_str() {
        "state" => {
            crate::event_record::emit_host(
                crate::event_log::Level::Info,
                "host.notification.event",
                serde_json::json!({
                    "type": parsed.kind,
                    "authorization": parsed.authorization,
                    "window": "",
                    "surface": "",
                }),
            );
            if let Some(error) = &parsed.error {
                log_error("notification", error);
            }
            Ok(Reported::State(NotificationState {
                authorization: parsed.authorization,
                error: parsed.error,
            }))
        }
        "posted" | "activated" => {
            // default: an identifier that could not be read becomes an empty list, which is reported as a notification
            // failure right below.
            let target: Vec<String> = serde_json::from_str(&parsed.identifier).unwrap_or_default();
            let [window, surface] = target.as_slice() else {
                return rejected(format!(
                    "{} notification {:?} has no window and surface",
                    parsed.kind, parsed.identifier
                ));
            };
            crate::event_record::emit_host(
                crate::event_log::Level::Info,
                "host.notification.event",
                serde_json::json!({
                    "type": parsed.kind,
                    "authorization": "",
                    "window": window,
                    "surface": surface,
                }),
            );
            Ok(Reported::Notice {
                kind: parsed.kind,
                window: window.clone(),
                surface: surface.clone(),
            })
        }
        _ => rejected(format!("notification event {raw:?} has an unknown type")),
    }
}

/// Reports an event of the notification center to the windows. The permission state goes to every window, and a pressed
/// notification goes to its window.
fn event(app: &AppHandle, raw: String) {
    match record_event(&raw) {
        Err(reason) => set_error(app, reason),
        Ok(Reported::State(state)) => {
            if let Ok(mut current) = STATE.lock() {
                *current = state;
            }
            emit_state(app);
        }
        Ok(Reported::Notice {
            kind,
            window,
            surface,
        }) => {
            let Some(owner) = app.get_window(&window) else {
                return failed(
                    app,
                    format!("the window {window:?} of a {kind} notification is closed"),
                );
            };
            if kind == "activated"
                && let Err(error) = owner.show().and_then(|()| owner.set_focus())
            {
                return failed(
                    app,
                    format!("focus the window of an activated notification: {error}"),
                );
            }
            let name = format!("notification-{kind}");
            if let Err(error) =
                emit_window(&owner, &name, serde_json::json!({ "surface": surface }))
            {
                failed(app, format!("{name}: {error}"));
            }
        }
    }
}

/// Records the failure and reports it to every window as the error of the notification state. Without a window, the
/// notification state cannot show the error.
fn failed(app: &AppHandle, reason: String) {
    log_error("notification", &reason);
    set_error(app, reason);
}

/// Reports the recorded failure to every window as the error of the notification state.
fn set_error(app: &AppHandle, reason: String) {
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

/// Returns the permission state that was reported last. The page reads it when it starts.
pub(crate) fn state() -> Result<NotificationState, String> {
    STATE
        .lock()
        .map(|state| state.clone())
        .map_err(|error| error.to_string())
}

/// Posts the tab notification of the calling window as a system notification.
pub(crate) fn notify(window: &Window, request: NotificationRequest) -> Result<(), String> {
    validate_notification(&request, false)?;
    let name = identifier(window.label(), &request.surface);
    exposure::on_main(window, move || {
        platform::current()?.post_notification(&name, &request.title, &request.body)
    })
}

/// Clears the tab notification of the calling window.
pub(crate) fn remove(window: &Window, request: NotificationRequest) -> Result<(), String> {
    validate_notification(&request, true)?;
    let name = identifier(window.label(), &request.surface);
    exposure::on_main(window, move || {
        platform::current()?.remove_notification(&name)
    })
}
