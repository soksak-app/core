//! Observation while developing, as a plugin of its own.
//!
//! What ends up on screen cannot be read from the page: the surfaces and the modal
//! are windows this app makes, and the window server composites them. So it has to
//! be looked at from outside, and a capture tool needs to address a window rather
//! than a region of the screen - a region catches whatever is in front, and raising
//! the window first changes the state being measured.
//!
//! This is not part of the product's contract. Registered only when asked for;
//! left out, nothing here runs.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Window};

use crate::native;

/// The numbers of this window and the windows attached to it. A modal is a window
/// of its own, so it joins the list while it is open.
#[tauri::command]
fn windows<R: Runtime>(window: Window<R>) -> Result<Vec<isize>, String> {
    let handle = window.ns_window().map_err(|e| e.to_string())?;
    Ok(native::window_numbers(handle))
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("observe")
        .setup(|app, _api| {
            let handle = app.clone();
            std::thread::spawn(move || report(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![windows])
        .build()
}

/// Writes a line whenever the set of windows changes.
///
/// AppKit gives no notification when a child window is attached or detached, so
/// this asks. The numbers are read on the main thread, which is where a window may
/// be touched.
fn report<R: Runtime>(app: tauri::AppHandle<R>) {
    let mut last = String::new();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let (tx, rx) = std::sync::mpsc::channel();
        let ask = app.clone();
        if app
            .run_on_main_thread(move || {
                // 이 앱은 창 하나가 웹뷰 여럿을 담는다. 그런 창은 webview_windows 가
                // 아니라 windows 에 있다.
                let found = ask
                    .windows()
                    .into_iter()
                    .find(|(label, _)| !label.starts_with("modal-"))
                    .and_then(|(_, w)| w.ns_window().ok())
                    .map(native::window_numbers)
                    .unwrap_or_default();
                let _ = tx.send(found);
            })
            .is_err()
        {
            return;
        }
        let Ok(now) = rx.recv() else { return };
        if now.is_empty() {
            continue;
        }
        let line = format!("{now:?}");
        if line == last {
            continue;
        }
        last = line;
        println!("관측: 창 번호 {now:?}");
    }
}
