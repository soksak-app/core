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

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Emitter, Listener, Manager, Runtime};

use crate::capture;
use crate::native;

/// The value of a command-line flag, in either form the other host accepts:
/// `--flag value` and `--flag=value`. Go's flag package takes both, so a command
/// written for one application runs on the other.
pub fn flag(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    let long = format!("--{name}");
    let short = format!("-{name}");
    while let Some(arg) = args.next() {
        if arg == long || arg == short {
            return args.next();
        }
        for prefix in [format!("{long}="), format!("{short}=")] {
            if let Some(value) = arg.strip_prefix(&prefix) {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Whether a flag that takes no value was given.
pub fn given(name: &str) -> bool {
    let long = format!("--{name}");
    let short = format!("-{name}");
    std::env::args().skip(1).any(|a| a == long || a == short)
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("observe")
        .setup(|app, _api| {
            // The window set changes when a modal is attached or detached, and the
            // app announces that where it happens. Nothing is polled.
            let listen = app.clone();
            app.listen("windows-changed", move |_| report(listen.clone()));
            // Observation starts after the page's first commit: the window is on
            // screen and the surfaces exist. A page-load event fires again on
            // every reload and would start it more than once.
            let ready = app.clone();
            let started = std::sync::atomic::AtomicBool::new(false);
            app.listen("page-ready", move |_| {
                if started.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                transcribe(ready.clone());
                report(ready.clone());
                open(ready.clone());
                drive(ready.clone());
                click(ready.clone());
            });
            // The page reports whether more updates follow, so a boundary dragged
            // by hand is recorded the same way as a driven one.
            if let Some(into) = capturing() {
                let began = into.clone();
                app.listen("run-began", move |_| capture::start(&began));
                // A listener runs on the thread that emitted the event, and
                // run-ended is emitted inside a command, on the main thread.
                // Stopping the recording waits for an answer, and waiting here
                // would stop the window drawing.
                app.listen("run-ended", move |_| {
                    let into = into.clone();
                    std::thread::spawn(move || {
                        eprintln!("observe: wrote {} frames to {into}", capture::stop());
                    });
                });
            }
            Ok(())
        })
        .build()
}

/// Asks the page to record every host call and its answer.
///
/// The recorder is in the page, which both applications run, so the two write the
/// same form and cannot drift apart.
fn transcribe<R: Runtime>(app: tauri::AppHandle<R>) {
    if !given("transcript") {
        return;
    }
    let _ = app.emit("observe-record", ());
}

/// Writes one line naming the windows this app holds.
///
/// The numbers are read on the main thread, which is where a window may be touched.
fn report<R: Runtime>(app: tauri::AppHandle<R>) {
    let ask = app.clone();
    let _ = app.run_on_main_thread(move || {
        let found = numbers(&ask);
        if !found.is_empty() {
            let list: Vec<String> = found.iter().map(|n| n.to_string()).collect();
            eprintln!("observe: windows {}", list.join(" "));
        }
    });
}

/// This window's number and the numbers of the windows attached to it. Read on the
/// main thread, which is where a window may be touched.
fn numbers<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<isize> {
    // This application puts several webviews in one window. Such a window is in
    // windows, not in webview_windows.
    app.windows()
        .into_iter()
        .find(|(label, _)| !label.starts_with("modal-"))
        .and_then(|(_, w)| w.ns_window().ok())
        .map(native::window_numbers)
        .unwrap_or_default()
}

/// The directory frames are written into, when one was asked for.
fn capturing() -> Option<String> {
    flag("capture")
}

/// Readies the recording for this window. Reading the window server's list is the
/// slow part, so it is read once, here.
///
/// The lookup waits for its answer. Waiting for it on the main thread makes the
/// two wait for each other when that answer needs the main queue, so only the
/// window number is read there and the lookup runs on this thread.
fn open<R: Runtime>(app: tauri::AppHandle<R>) {
    if capturing().is_none() {
        return;
    }
    let (tell, hear) = std::sync::mpsc::channel();
    let ask = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = tell.send(numbers(&ask).first().copied());
        })
        .is_err()
    {
        return;
    }
    // On a thread of its own. This is called from a listener, which runs on the
    // thread that emitted the event, and that thread may be the main one.
    std::thread::spawn(move || {
        if let Ok(Some(first)) = hear.recv() {
            capture::open(first);
        }
    });
}

/// Presses one element of the page, named by a CSS selector.
///
/// A boundary lies over the surfaces, so a drag reaches it by coordinates. A
/// button in the page's own chrome does not: it is an element of the document and
/// only the document can press it. The page's own observation module does.
fn click<R: Runtime>(app: tauri::AppHandle<R>) {
    let Some(spec) = flag("click") else {
        return;
    };
    let Some((wait, selector)) = spec.split_once(',') else {
        eprintln!("observe: --click takes ms,selector, got {spec:?}");
        return;
    };
    let Ok(after) = wait.trim().parse::<u64>() else {
        eprintln!("observe: --click wait {wait:?} is not a number");
        return;
    };
    let selector = selector.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(after));
        let _ = app.emit("observe-click", selector);
    });
}
/// Asks the page to drag one boundary.
///
/// The drag itself is done by the page. Both applications run that page, so which
/// boundary is dragged and how is written once.
fn drive<R: Runtime>(app: tauri::AppHandle<R>) {
    let Some(spec) = flag("drive") else {
        return;
    };
    let plan = match Plan::parse(&spec) {
        Ok(plan) => plan,
        Err(why) => {
            eprintln!("observe: --drive {why}");
            return;
        }
    };
    std::thread::spawn(move || {
        // The page this app did not open has no event saying it is drawn, so this
        // is the one place a clock is used.
        std::thread::sleep(plan.wait);
        let _ = app.emit("observe-drag", &plan);
    });
}

/// One drag, shaken. A held point is swept out and back, so the boundary ends where
/// it started and every sweep covers the same pixels.
#[derive(Serialize)]
struct Plan {
    #[serde(skip)]
    wait: Duration,
    axis: String,
    line: i64,
    dx: f64,
    dy: f64,
    ms: u64,
    times: usize,
}

impl Plan {
    /// Reads "wait,axis,line,dx,dy,ms,times": wait that many ms for the pages to
    /// be drawn, then press that boundary and sweep by dx,dy over ms, out and
    /// back, that many times.
    fn parse(spec: &str) -> Result<Plan, String> {
        let parts: Vec<&str> = spec.split(',').collect();
        if parts.len() != 7 {
            return Err(format!("wants wait,axis,line,dx,dy,ms,times, got {spec:?}"));
        }
        if parts[1] != "x" && parts[1] != "y" {
            return Err(format!("axis is x or y, got {:?}", parts[1]));
        }
        let number = |at: usize| -> Result<f64, String> {
            parts[at]
                .trim()
                .parse()
                .map_err(|_| format!("{:?} is not a number", parts[at]))
        };
        Ok(Plan {
            wait: Duration::from_millis(number(0)? as u64),
            axis: parts[1].to_string(),
            line: number(2)? as i64,
            dx: number(3)?,
            dy: number(4)?,
            ms: number(5)? as u64,
            times: number(6)? as usize,
        })
    }
}
