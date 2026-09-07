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

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
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

/// The port this application takes instructions on. The other host takes a
/// different one, so both can be up at once. `examples/test/app.mjs` writes the
/// same numbers.
const CONTROL_PORT: u16 = 49733;

/// The control connections open right now.
static TOLD: Mutex<Vec<TcpStream>> = Mutex::new(Vec::new());

/// Where the recording writes its frames, and whether that directory takes one
/// run only. `--capture` gives the first value and takes every run, because it
/// asks for a boundary dragged by hand to be recorded too. An instruction
/// records the drag it asked for and nothing after it.
static INTO: Mutex<(Option<String>, bool)> = Mutex::new((None, false));

/// Writes one line to stderr and to every open control connection.
///
/// A check reads the lines observation leaves and the lines the page's own
/// verifier leaves. Both come through here, so one place carries both.
pub fn say(line: &str) {
    eprintln!("{line}");
    let mut open = TOLD.lock().unwrap();
    open.retain_mut(|conn| conn.write_all(format!("{line}\n").as_bytes()).is_ok());
}

/// Where the next recording writes.
fn into() -> Option<String> {
    INTO.lock().unwrap().0.clone()
}

/// Sets where the next recording writes. `once` takes one run only.
fn write_to(dir: Option<String>, once: bool) {
    *INTO.lock().unwrap() = (dir, once);
}

/// Reports that one run ended. A directory taking one run only is closed here.
fn wrote() {
    let mut at = INTO.lock().unwrap();
    if at.1 {
        *at = (None, false);
    }
}

/// Opens the way instructions arrive.
///
/// One application drives many times, and it outlives the checks that drive it,
/// so running the checks again opens no window. A new window is placed in front
/// of whatever the person at the machine is looking at, so how often one opens
/// is how often their screen is covered.
///
/// The way is an open port. It takes one instruction per line and sends this
/// application's log back until that instruction is done; the caller reads the
/// line it waits for and closes.
fn commands<R: Runtime>(app: tauri::AppHandle<R>) {
    let listener = match TcpListener::bind(("127.0.0.1", CONTROL_PORT)) {
        Ok(listener) => listener,
        Err(why) => {
            say(&format!("observe: no control port, {why}"));
            return;
        }
    };
    say(&format!("observe: control on {CONTROL_PORT}"));
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(app, conn));
        }
    });
}

/// Carries out the instructions one connection sends.
fn serve<R: Runtime>(app: tauri::AppHandle<R>, conn: TcpStream) {
    let Ok(mine) = conn.try_clone() else {
        return;
    };
    TOLD.lock().unwrap().push(conn);
    for line in BufReader::new(mine).lines().map_while(Result::ok) {
        command(&app, line.trim());
    }
}

/// Carries out one instruction.
///
/// `drag` is the drag `--drive` performs, without its wait. That wait is for the
/// page to be drawn for the first time, and the page is drawn before an
/// instruction can arrive.
fn command<R: Runtime>(app: &tauri::AppHandle<R>, line: &str) {
    let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
    match verb {
        "" => {}
        "drag" => {
            let Some((spec, dir)) = rest.split_once(' ') else {
                say(&format!("observe: drag takes a spec and a directory, got {rest:?}"));
                return;
            };
            let mut plan = match Plan::parse(spec) {
                Ok(plan) => plan,
                Err(why) => {
                    say(&format!("observe: drag {why}"));
                    return;
                }
            };
            plan.wait = Duration::ZERO;
            write_to(Some(dir.to_string()), true);
            start_drag(app, plan);
        }
        _ => say(&format!("observe: {verb:?} is not a command")),
    }
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("observe")
        .setup(|app, _api| {
            // The window set changes when a modal is attached or detached, and the
            // app announces that where it happens. Nothing is polled.
            let listen = app.clone();
            app.listen("windows-changed", move |_| report(listen.clone()));
            // Written whenever the modal's document renders. Whether a content
            // update reached that document is known nowhere else.
            app.listen("modal-rendered", |event| {
                say(&format!("observe: modal rendered {}", event.payload().trim_matches('"')));
            });
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
                zoom(ready.clone());
                resize(ready.clone());
                drive(ready.clone());
                click(ready.clone());
                commands(ready.clone());
            });
            // The page reports whether more updates follow, so a boundary dragged
            // by hand is recorded the same way as a driven one.
            write_to(capturing(), false);
            app.listen("run-began", move |_| {
                if let Some(into) = into() {
                    capture::start(&into);
                }
            });
            // A listener runs on the thread that emitted the event, and
            // run-ended is emitted inside a command, on the main thread.
            // Stopping the recording waits for an answer, and waiting here
            // would stop the window drawing.
            app.listen("run-ended", move |_| {
                let ended = into();
                wrote();
                let Some(into) = ended else {
                    return;
                };
                std::thread::spawn(move || {
                    say(&format!("observe: wrote {} frames to {into}", capture::stop()));
                });
            });
            Ok(())
        })
        .build()
}

/// Maximises the window.
///
/// Where a window's own buttons stand is worked out from the window's size, so a
/// test has to be able to change that size and look again.
fn zoom<R: Runtime>(app: tauri::AppHandle<R>) {
    if !given("zoom") {
        return;
    }
    for (label, window) in app.windows() {
        if label != "main" {
            continue;
        }
        let _ = window.maximize();
    }
}

/// Gives the window's content the size asked for, and reports the size it got.
///
/// Unlike maximising, the size is named here. What maximising gives is the
/// screen's available area, and that area changes by a point shortly after an
/// application starts: two applications that maximise on opposite sides of that
/// change end up with windows of different sizes. A named size cannot be moved
/// by that race.
///
/// The size obtained is reported, because an application that does not apply the
/// size asked for is something the reader has to be told about.
fn resize<R: Runtime>(app: tauri::AppHandle<R>) {
    let Some(spec) = flag("resize") else {
        return;
    };
    let asked = spec
        .split_once(',')
        .and_then(|(w, h)| Some((w.trim().parse::<f64>().ok()?, h.trim().parse::<f64>().ok()?)))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0);
    let Some((w, h)) = asked else {
        say(&format!("observe: --resize takes width,height, got {spec:?}"));
        return;
    };
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    // When the size has actually been applied is what the window says. Read
    // straight after setting it, some applications answer with the size the
    // window has not taken yet.
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(got) = event {
            let got = got.to_logical::<f64>(scale);
            say(&format!("observe: sized {}x{}", got.width, got.height));
        }
    });
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
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
            say(&format!("observe: windows {}", list.join(" ")));
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
        .find(|(label, _)| label == "main")
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
        say(&format!("observe: --click takes ms,selector, got {spec:?}"));
        return;
    };
    let Ok(after) = wait.trim().parse::<u64>() else {
        say(&format!("observe: --click wait {wait:?} is not a number"));
        return;
    };
    let selector = selector.to_string();
    std::thread::spawn(move || {
        // The same wait as --drive: nothing says when the element to press is
        // drawn.
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
            say(&format!("observe: --drive {why}"));
            return;
        }
    };
    std::thread::spawn(move || {
        // The page this app did not open has no event saying it is drawn, so the
        // wait asked for is what is waited.
        std::thread::sleep(plan.wait);
        start_drag(&app, plan);
    });
}

/// One step of a drag. The page's observe.js writes the same value.
const FRAME: Duration = Duration::from_millis(16);

/// Asks for a drag and sends the times of its steps.
///
/// The page holds what the drag is; when each step happens comes from here. A
/// window that is not in front has its document treated as hidden, and the
/// browser holds that document's timers to near a second, so a page counting its
/// own steps drags at a fraction of the speed asked. This clock is not held,
/// wherever the window is.
///
/// The number of steps is the number the page takes. That many are sent.
fn start_drag<R: Runtime>(app: &tauri::AppHandle<R>, plan: Plan) {
    let steps = plan.steps() * 2 * plan.times;
    let _ = app.emit("observe-drag", &plan);
    let app = app.clone();
    std::thread::spawn(move || {
        // Each step is due at its own time from the start, not one frame after
        // the last one woke. Sleeping a frame at a time adds what each step
        // costs to every step after it, and the drag ends slower than asked.
        let began = std::time::Instant::now();
        for step in 1..=steps {
            let due = FRAME * step as u32;
            if let Some(left) = due.checked_sub(began.elapsed()) {
                std::thread::sleep(left);
            }
            let _ = app.emit("observe-tick", ());
        }
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
    /// The steps in one sweep, counted as the page counts them.
    fn steps(&self) -> usize {
        let n = (self.ms as f64 / FRAME.as_millis() as f64).round() as usize;
        n.max(1)
    }

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
