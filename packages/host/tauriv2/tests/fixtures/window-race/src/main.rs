//! The fixture program of tests/window_race_test.rs. It runs a real Tauri application: the main thread runs the event loop of
//! wry, and the windows are real windows that the application never shows. The scenario named on the command line runs on a
//! thread of its own, as an endpoint request does, with the real `list_entries` and `use_owner` of the host library; it closes
//! a real window through the close path of Tauri during a main-thread step, prints one JSON line with its result and ends
//! the process.
//!
//! The scenarios are `list-during-close` (docs/spec/host-contract.md, exposure.windows.listed-in-one-main-thread-step) and
//! `use-after-close` (window-close.native-window.used-in-reading-step).

use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use soksak_host::exposure::native_failure;
use soksak_host::windows::{
    ListStep, MainStep, NativeFailure, WindowData, close_requested, list_entries, listed_window,
    use_owner,
};

/// A hidden window with its records. The window is built through the builder path of the host (`prepare_window`) and is not
/// visible, so it takes neither the activation nor the front. Its close request is answered as the host answers the close
/// of a window whose page is not ready: the records mark it closing and the window closes.
fn hidden_window(app: &tauri::AppHandle, label: &str) -> (tauri::Window, Arc<WindowData>) {
    let builder =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
            .title(label)
            .inner_size(320.0, 200.0)
            .focused(false)
            .visible(false);
    let window = soksak_host_tauriv2::prepare_window(builder)
        .expect("prepare the window")
        .build()
        .expect("build the window")
        .as_ref()
        .window();
    let data = Arc::new(WindowData::default());
    data.ready.store(true, Ordering::Relaxed);
    let records = data.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event
            && close_requested(&records, false, || {})
        {
            api.prevent_close();
        }
    });
    (window, data)
}

/// Runs step as one step of the main thread and waits for its result, as the host does for a request.
fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    step: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(step());
    })
    .map_err(|error| error.to_string())?;
    rx.recv().map_err(|error| error.to_string())
}

/// The JSON of a result: `{"ok": value}` or `{"err": text}`.
fn result_json(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(error) => json!({"err": error}),
    }
}

/// Lists the windows with the real `list_entries`. The title and the key state come from the real window. When
/// close_second is true, the list asks the second window to close at the moment it reads that window, so the close is
/// handled by the main thread after the list step, as a close of the user is.
fn list(
    app: &tauri::AppHandle,
    windows: &[(tauri::Window, Arc<WindowData>)],
    close_second: bool,
) -> Result<Value, String> {
    let second = windows[1].0.label().to_string();
    let step_app = app.clone();
    list_entries(
        windows.to_vec(),
        move |step: ListStep| on_main(&step_app, step)?,
        move |(window, data)| {
            if close_second && window.label() == second {
                window.close().map_err(|error| error.to_string())?;
            }
            listed_window(
                window.label(),
                data,
                || window.title().map_err(|error| error.to_string()),
                || window.is_focused().map_err(|error| error.to_string()),
            )
        },
    )
}

fn list_during_close(
    app: &tauri::AppHandle,
    windows: &[(tauri::Window, Arc<WindowData>)],
) -> Value {
    let first = list(app, windows, true);
    let closing = windows[1].1.closing.load(Ordering::SeqCst);
    let second = list(app, windows, false);
    json!({"first": result_json(first), "closing": closing, "second": result_json(second)})
}

/// Uses the native address of the window with the real `use_owner`. The native code is the real platform: it reads whether the
/// window it receives is on screen. The first use asks the window to close at the moment it reads the address.
fn use_after_close(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    data: &Arc<WindowData>,
) -> Value {
    let native = window.ns_window().expect("the native window") as usize;
    let received = Arc::new(Mutex::new(Vec::new()));
    let mut results = Vec::new();
    for close in [true, false] {
        let step_app = app.clone();
        let (reading, closing) = (window.clone(), window.clone());
        let records = data.clone();
        let (received, work_records) = (received.clone(), data.clone());
        let used = use_owner(
            (),
            move |step: MainStep| on_main(&step_app, step),
            move |()| {
                if records.closing.load(Ordering::Relaxed) {
                    return Ok(None);
                }
                let handle = reading.ns_window().map_err(|error| error.to_string())? as usize;
                if close {
                    closing.close().map_err(|error| error.to_string())?;
                }
                Ok(Some(handle))
            },
            move |handle| {
                // Whether the close of the window was already handled when the native code received its address.
                received
                    .lock()
                    .unwrap()
                    .push((handle, work_records.closing.load(Ordering::Relaxed)));
                soksak_host::platform::current()?.window_on_screen(handle)
            },
        );
        results.push(match used {
            Ok(on_screen) => json!({"ok": on_screen}),
            Err(NativeFailure::Closed) => json!({"closed": true}),
            Err(NativeFailure::Failed(error)) => json!({"err": error}),
        });
    }
    let failure = native_failure(window.label(), -32603)(NativeFailure::Closed);
    json!({
        "first": results[0],
        "second": results[1],
        "native": native,
        "received": received.lock().unwrap().iter().map(|(handle, _)| *handle).collect::<Vec<_>>(),
        "received_after_close": received.lock().unwrap().iter().map(|(_, closed)| *closed).collect::<Vec<_>>(),
        "closed_failure": {"code": failure.code, "message": failure.message},
    })
}

fn main() {
    let scenario = std::env::args()
        .nth(1)
        .expect("the scenario is the first argument");
    let context = tauri::generate_context!();
    tauri::Builder::default()
        // The launch leaves the activation to the system, as the host does (docs/spec/hosts.md#launch-activation).
        .activate_ignoring_other_apps(soksak_host_tauriv2::launch_activates_ignoring_other_apps())
        .setup(move |app| {
            // An accessory application has no Dock icon and never becomes the active application by itself.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            let windows = vec![hidden_window(&handle, "main"), hidden_window(&handle, "w2")];
            std::thread::spawn(move || {
                let result = match scenario.as_str() {
                    "list-during-close" => list_during_close(&handle, &windows),
                    "use-after-close" => use_after_close(&handle, &windows[1].0, &windows[1].1),
                    other => panic!("unknown scenario {other}"),
                };
                println!("{result}");
                std::process::exit(0);
            });
            Ok(())
        })
        .build(context)
        .expect("build the application")
        .run(|_, _| {});
}
