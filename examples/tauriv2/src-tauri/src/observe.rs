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

use std::time::Duration;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Listener, Manager, Runtime, Window};

use crate::native;
use crate::InputStep;

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
            // The window set changes when a modal is attached or detached, and the
            // app announces that where it happens. Nothing is polled.
            let listen = app.clone();
            app.listen("windows-changed", move |_| report(listen.clone()));
            Ok(())
        })
        // The main page has loaded, so its window is on screen. This is the first
        // report; waiting for it is what a timer would otherwise be doing.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                report(webview.app_handle().clone());
                drive(webview.app_handle().clone());
            }
        })
        .invoke_handler(tauri::generate_handler![windows])
        .build()
}

/// Writes one line naming the windows this app holds.
///
/// The numbers are read on the main thread, which is where a window may be touched.
fn report<R: Runtime>(app: tauri::AppHandle<R>) {
    let ask = app.clone();
    let _ = app.run_on_main_thread(move || {
        // 이 앱은 창 하나가 웹뷰 여럿을 담는다. 그런 창은 webview_windows 가 아니라
        // windows 에 있다.
        let found = ask
            .windows()
            .into_iter()
            .find(|(label, _)| !label.starts_with("modal-"))
            .and_then(|(_, w)| w.ns_window().ok())
            .map(native::window_numbers)
            .unwrap_or_default();
        if !found.is_empty() {
            println!("관측: 창 번호 {found:?}");
        }
    });
}

/// Drags a boundary without anyone touching the mouse.
///
/// The steps go the way a press on a surface goes: the page receives surface-input
/// and matches the point against its own dividers. So this measures the path the
/// product uses, not one built beside it.
///
/// A drag is motion, so it is written on a clock. That clock produces the steps; it
/// does not watch for anything.
fn drive<R: Runtime>(app: tauri::AppHandle<R>) {
    let Some(spec) = std::env::args()
        .skip_while(|a| a != "--drive")
        .nth(1)
    else {
        return;
    };
    let plan = match Plan::parse(&spec) {
        Ok(plan) => plan,
        Err(why) => {
            println!("관측: --drive {why}");
            return;
        }
    };
    std::thread::spawn(move || plan.run(&app));
}

/// One drag, repeated. A repeat goes back where it came from, so the boundary stays
/// in place over a long run and every cycle covers the same pixels.
struct Plan {
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    over: Duration,
    times: usize,
}

impl Plan {
    /// Reads "x,y,dx,dy,ms,times": press at x,y, move by dx,dy over ms, and do it
    /// that many times, each turn going back the way the one before it came.
    fn parse(spec: &str) -> Result<Plan, String> {
        let parts: Vec<&str> = spec.split(',').collect();
        if parts.len() != 6 {
            return Err(format!("wants x,y,dx,dy,ms,times, got {spec:?}"));
        }
        let mut n = [0.0f64; 6];
        for (i, part) in parts.iter().enumerate() {
            n[i] = part
                .trim()
                .parse()
                .map_err(|_| format!("{part:?} is not a number"))?;
        }
        Ok(Plan {
            x: n[0],
            y: n[1],
            dx: n[2],
            dy: n[3],
            over: Duration::from_millis(n[4] as u64),
            times: n[5] as usize,
        })
    }

    fn run<R: Runtime>(&self, app: &tauri::AppHandle<R>) {
        let frame = Duration::from_millis(16);
        let steps = (self.over.as_millis() / frame.as_millis()).max(1) as usize;
        println!(
            "관측: 끌기 ({},{}) {:+},{:+} {}걸음 ×{}",
            self.x, self.y, self.dx, self.dy, steps, self.times
        );
        // 경계는 끈 만큼 옮겨져 있다. 다음 번은 처음 자리가 아니라 지금 자리를 눌러야
        // 같은 경계를 잡는다.
        let (mut x, mut y) = (self.x, self.y);
        for turn in 0..self.times {
            let (dx, dy) = if turn % 2 == 1 {
                (-self.dx, -self.dy)
            } else {
                (self.dx, self.dy)
            };
            drag(app, x, y, dx, dy, steps, frame);
            x += dx;
            y += dy;
        }
        println!("관측: 끌기 끝");
    }
}

/// Presses at x,y, moves by dx,dy in even steps and releases.
fn drag<R: Runtime>(
    app: &tauri::AppHandle<R>,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    steps: usize,
    frame: Duration,
) {
    let send = |phase: u8, x: f64, y: f64| {
        let _ = app.emit("surface-input", InputStep { phase, x, y });
    };
    send(0, x, y);
    for i in 1..=steps {
        std::thread::sleep(frame);
        let at = i as f64 / steps as f64;
        send(1, x + dx * at, y + dy * at);
    }
    send(2, x + dx, y + dy);
    std::thread::sleep(frame);
}
