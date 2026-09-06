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

use crate::capture;
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
            // The page reports whether more updates follow, so a boundary dragged
            // by hand is recorded the same way as a driven one.
            if let Some(into) = capturing() {
                let began = into.clone();
                app.listen("run-began", move |_| capture::start(&began));
                app.listen("run-ended", move |_| {
                    println!("관측: {} 프레임을 {into} 에 적었다", capture::stop());
                });
            }
            Ok(())
        })
        // The main page has loaded, so its window is on screen. This is the first
        // report; waiting for it is what a timer would otherwise be doing.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                report(webview.app_handle().clone());
                open(webview.app_handle().clone());
                drive(webview.app_handle().clone());
                click(webview.app_handle().clone());
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
        let found = numbers(&ask);
        if !found.is_empty() {
            println!("관측: 창 번호 {found:?}");
        }
    });
}

/// This window's number and the numbers of the windows attached to it. Read on the
/// main thread, which is where a window may be touched.
fn numbers<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<isize> {
    // 이 앱은 창 하나가 웹뷰 여럿을 담는다. 그런 창은 webview_windows 가 아니라
    // windows 에 있다.
    app.windows()
        .into_iter()
        .find(|(label, _)| !label.starts_with("modal-"))
        .and_then(|(_, w)| w.ns_window().ok())
        .map(native::window_numbers)
        .unwrap_or_default()
}

/// The directory frames are written into, when one was asked for.
fn capturing() -> Option<String> {
    std::env::args().skip_while(|a| a != "--capture").nth(1)
}

/// Readies the recording for this window. Reading the window server's list is the
/// slow part, so it is read once, here.
fn open<R: Runtime>(app: tauri::AppHandle<R>) {
    if capturing().is_none() {
        return;
    }
    let ask = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(first) = numbers(&ask).first() {
            capture::open(*first);
        }
    });
}

/// Presses one element of the page, named by a CSS selector.
///
/// A boundary lies over the surfaces, so a drag reaches it by coordinates. A
/// button in the page's own chrome does not: it is an element of the document and
/// only the document can press it. The page's own observation module does.
fn click<R: Runtime>(app: tauri::AppHandle<R>) {
    let Some(spec) = std::env::args().skip_while(|a| a != "--click").nth(1) else {
        return;
    };
    let Some((wait, selector)) = spec.split_once(',') else {
        println!("관측: --click 은 ms,선택자 를 받는다 — {spec:?}");
        return;
    };
    let Ok(after) = wait.trim().parse::<u64>() else {
        println!("관측: --click 의 {wait:?} 는 수가 아니다");
        return;
    };
    let selector = selector.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(after));
        let _ = app.emit("observe-click", selector);
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

/// One drag, shaken. A held point is swept out and back, so the boundary ends where
/// it started and every sweep covers the same pixels.
struct Plan {
    wait: Duration,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    over: Duration,
    times: usize,
}

impl Plan {
    /// Reads "wait,x,y,dx,dy,ms,times": wait that many ms for the pages to be
    /// drawn, then press at x,y and sweep by dx,dy over ms, out and back, that
    /// many times.
    fn parse(spec: &str) -> Result<Plan, String> {
        let parts: Vec<&str> = spec.split(',').collect();
        if parts.len() != 7 {
            return Err(format!("wants wait,x,y,dx,dy,ms,times, got {spec:?}"));
        }
        let mut n = [0.0f64; 7];
        for (i, part) in parts.iter().enumerate() {
            n[i] = part
                .trim()
                .parse()
                .map_err(|_| format!("{part:?} is not a number"))?;
        }
        Ok(Plan {
            wait: Duration::from_millis(n[0] as u64),
            x: n[1],
            y: n[2],
            dx: n[3],
            dy: n[4],
            over: Duration::from_millis(n[5] as u64),
            times: n[6] as usize,
        })
    }

    fn run<R: Runtime>(&self, app: &tauri::AppHandle<R>) {
        let frame = Duration::from_millis(16);
        // 이 앱이 열지 않은 페이지가 그려지기를 기다린다. 남의 페이지가 다 그려졌다고
        // 알려주는 것은 없으므로 여기서만 시계를 쓴다. 재는 동안에는 쓰지 않는다.
        std::thread::sleep(self.wait);

        let steps = (self.over.as_millis() / frame.as_millis()).max(1) as usize;
        println!(
            "관측: 흔들기 ({},{}) {:+},{:+} {}걸음 ×{}",
            self.x, self.y, self.dx, self.dy, steps, self.times
        );
        let send = |phase: u8, x: f64, y: f64| {
            let _ = app.emit("surface-input", InputStep { phase, x, y });
        };
        // 한 번 누른 채로 왕복한다. 놓았다 다시 누르면 경계가 최소 크기에 걸려 명령한
        // 만큼 가지 않았을 때 다음 누름이 빗나가고, 그때부터 아무것도 움직이지 않는다.
        send(0, self.x, self.y);
        for _ in 0..self.times {
            self.sweep(&send, 0.0, 1.0, steps, frame);
            self.sweep(&send, 1.0, 0.0, steps, frame);
        }
        send(2, self.x, self.y);
        println!("관측: 흔들기 끝");
    }

    /// Moves the held point from one fraction of the offset to another.
    fn sweep(
        &self,
        send: &impl Fn(u8, f64, f64),
        from: f64,
        to: f64,
        steps: usize,
        frame: Duration,
    ) {
        for i in 1..=steps {
            std::thread::sleep(frame);
            let at = from + (to - from) * (i as f64 / steps as f64);
            send(1, self.x + self.dx * at, self.y + self.dy * at);
        }
    }
}
