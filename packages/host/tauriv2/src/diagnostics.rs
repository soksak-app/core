//! The endpoint methods of a diagnostic build. They are included only by the cargo feature `diagnostics`.
//!
//! The result shown on the screen cannot be read from the page. Surfaces and modals are native views that this
//! application creates, and the window server composes them. A capture therefore targets a window and not a screen
//! region. A screen region records the frontmost window, and bringing a window to the front changes the state under
//! measurement.
//!
//! The page decides the drag path and the boundary position, and the host decides the time of each step. The document
//! of a window that is not frontmost is handled as hidden, and its timers are delayed by nearly one second. The clock
//! of the host is not delayed regardless of the window position.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{Emitter, EventTarget, Manager, Window};

use crate::application_log::log_error;
use crate::endpoint::Failure;
use crate::exposure::{self, on_main, Host, TIMEOUT};
use crate::platform;
use crate::recording::{layout_trace, Capture, Recording, Target};
use crate::workspace::Workspace;

/// The interval of one drag step. The page calculates the number of steps with the same value.
const FRAME: Duration = Duration::from_millis(16);

/// A recording in progress.
static RECORDING: Recording = Recording::new();

/// The window recording operation of the platform. The second value is the last presentation time (ms) to include in
/// the record when it stops.
struct PlatformCapture(&'static dyn platform::Platform, f64);

impl Capture for PlatformCapture {
    fn open(&self, target: Target) -> Result<(), String> {
        self.0.capture_open(target.window, target.display)
    }
    fn start(&self, directory: &Path) -> Result<(), String> {
        self.0.capture_start(&directory.to_string_lossy())
    }
    fn wait(&self) -> Result<bool, String> {
        self.0.capture_wait()
    }
    fn stop(&self) -> Result<i32, String> {
        self.0.capture_stop(self.1)
    }
}

fn recorder() -> Result<PlatformCapture, Failure> {
    Ok(PlatformCapture(platform::current().map_err(internal)?, 0.0))
}

/// The number that distinguishes the names of capture directories.
static CAPTURES: AtomicU64 = AtomicU64::new(0);

fn internal(error: impl ToString) -> Failure {
    Failure::new(-32603, error.to_string())
}

/// Runs a diagnostic method.
pub(crate) fn call(
    host: &Host,
    window: &Window,
    method: &str,
    params: Map<String, Value>,
) -> Result<Value, Failure> {
    match method {
        "diagnostics.fixture" => fixture(host, window, params),
        "diagnostics.drag" => drag(host, window, params),
        "diagnostics.capture.start" => {
            let display = match params.get("display") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(display)) => *display,
                Some(_) => return Err(Failure::params("display must be a boolean")),
            };
            let frames = capture_start(window, display)?;
            let traced = (|| -> Result<(), Failure> {
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.layout_trace_start()).map_err(internal)
            })();
            if let Err(error) = traced {
                if let Err(cleanup) =
                    recorder().and_then(|capture| RECORDING.abort(&capture).map_err(internal))
                {
                    return Err(internal(format!(
                        "{}; abort capture: {}",
                        error.message, cleanup.message
                    )));
                }
                return Err(error);
            }
            Ok(json!({"frames": frames.to_string_lossy()}))
        }
        "diagnostics.capture.stop" => {
            let after = match params.get("after") {
                None | Some(Value::Null) => 0.0,
                Some(value) => value
                    .as_f64()
                    .filter(|after| *after >= 0.0)
                    .ok_or_else(|| Failure::params("after must be a non-negative number"))?,
            };
            capture_stop(window, after)
        }
        // Diagnostic methods that the main page handles. The exposure reply of a surface must be caught before it
        // leaves the page, because otherwise it arrives after the request ended, so the page also handles the catching
        // of surface replies (docs/spec/endpoint.md).
        "diagnostics.transcript"
        | "diagnostics.surface.hold"
        | "diagnostics.surface.held"
        | "diagnostics.page.request" => {
            exposure::parsed(&host.page(window, method, params, TIMEOUT)?)
        }
        "diagnostics.modal.hold" => {
            let Some(on) = params.get("on").and_then(Value::as_bool) else {
                return Err(Failure::params("on must be a boolean"));
            };
            modal_hold(window.label(), on);
            Ok(Value::Null)
        }
        "diagnostics.modal.held" => modal_held(window.label()),
        "diagnostics.input.source" => input_source(window, params),
        "diagnostics.log.flush" => crate::event_record::flush_records(TIMEOUT)
            .map(|()| Value::Null)
            .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error)),
        "diagnostics.capture.still" => capture_still(window),
        "diagnostics.notifications" => delivered_notifications(window),
        "diagnostics.page.collect" => page_collect(window),
        "diagnostics.native.objects" => native_objects(window, &params),
        "diagnostics.process.exit" => process_exit(window, &params),
        "diagnostics.navigation.delay" => {
            let ms = params
                .get("ms")
                .and_then(Value::as_u64)
                .filter(|ms| *ms <= 10_000)
                .ok_or_else(|| Failure::params("ms must be an integer from 0 to 10000"))?;
            navigation_delay(window.label(), ms);
            Ok(Value::Null)
        }
        "diagnostics.presentation.failure" => {
            exposure::inject_presentation_failure(window)?;
            Ok(Value::Null)
        }
        _ => Err(Failure::new(
            -32601,
            format!("{method} is not a diagnostic method"),
        )),
    }
}

/// Makes the app page WebContent process of the window collect JavaScript objects. It is called before a memory check
/// measures, so that the check measures the remaining memory regardless of the collection time.
fn page_collect(window: &Window) -> Result<Value, Failure> {
    let target = window.clone();
    on_main(window, move || {
        let view = crate::windows::root_view(&target)
            .ok_or_else(|| "the main page is gone".to_string())?;
        crate::exposure::with_view(&view, |native| platform::current()?.collect_garbage(native))
    })
    .map_err(internal)?;
    Ok(Value::Null)
}

/// Returns the number of live library objects that are attached to windows and webviews after the application handled
/// one event. The objects of a closed window are released when the autorelease pool of the event loop iteration that
/// closed the window is drained, and the pool is drained when the application handles an event. A window check inserts
/// one event and counts after it, so that it measures the release of a closed window without user input. AppKit keeps a
/// window that was on the screen until its close animation ends, so when equal is given, the method answers when the
/// count equals equal.
fn native_objects(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let expected = params
        .get("equal")
        .map(platform::WindowObjects::from_equal)
        .transpose()
        .map_err(Failure::params)?;
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform::current()?.window_objects_when(
            expected,
            TIMEOUT.as_secs_f64(),
            Box::new(move |counts, reached| {
                if tx.send((counts, reached)).is_err() {
                    crate::application_log::log_info(
                        "diagnostics",
                        "window object counts arrived after their request ended",
                    );
                }
            }),
        )
    })
    .map_err(internal)?;
    // The library answers within TIMEOUT after it handles the event, so twice that time is awaited to include the event
    // handling time.
    let (counts, reached) = rx.recv_timeout(2 * TIMEOUT).map_err(|_| {
        Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("the application did not handle an event within {TIMEOUT:?}"),
        )
    })?;
    if !reached {
        let expected = expected.expect("only expected counts can be unreached");
        return Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("window object counts did not reach {expected} within {TIMEOUT:?}; they are {counts}"),
        ));
    }
    Ok(counts.payload())
}

/// Answers when the process pid ends. A window check awaits the end of the WebContent process of a closed window with
/// the exit notification of the kernel.
fn process_exit(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let pid = platform::parse_process_id(params.get("pid")).map_err(Failure::params)?;
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform::current()?.when_process_exited(
            pid,
            TIMEOUT.as_secs_f64(),
            Box::new(move |exited| {
                if tx.send(exited).is_err() {
                    crate::application_log::log_info(
                        "diagnostics",
                        "process exit answer arrived after its request ended",
                    );
                }
            }),
        )
    })
    .map_err(internal)?;
    // The library answers within TIMEOUT, so twice that time is awaited to include the time for the main thread to send
    // the answer.
    let exited = rx.recv_timeout(2 * TIMEOUT).map_err(|_| {
        Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("the application did not answer within {:?}", 2 * TIMEOUT),
        )
    })?;
    if !exited {
        return Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("process {pid} did not exit within {TIMEOUT:?}"),
        ));
    }
    Ok(Value::Null)
}

/// Takes one still image of the window without giving it focus, writes it to `<config-dir>/captures/still-*/window.png`
/// and returns the path. It is observation material that a person checks visually during development, and the requester
/// deletes the directory after checking.
fn capture_still(window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let held = window.clone();
    let numbers = on_main(window, move || platform.window_numbers(&held)).map_err(internal)?;
    let number = *numbers
        .first()
        .ok_or_else(|| internal("the window has no window number"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(internal)?
        .as_millis();
    // As in a recording, a private directory is created for each capture.
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("logs")
        .join("captures")
        .join(format!(
            "still-{stamp}-{}",
            CAPTURES.fetch_add(1, Ordering::Relaxed)
        ));
    platform.private_directory(&directory).map_err(internal)?;
    let path = directory.join("window.png");
    platform
        .capture_still(number, &path.to_string_lossy())
        .map_err(internal)?;
    Ok(json!({"path": path.to_string_lossy()}))
}

/// Writes a still capture of each window for the debug view and returns their paths (docs/spec/debug.md).
pub(crate) fn capture_windows(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for (label, window) in app.windows() {
        let value = capture_still(&window)
            .map_err(|failure| format!("window {label}: {}", failure.message))?;
        let path = value["path"].as_str().ok_or_else(|| {
            format!("window {label}: the still capture answered {value} without a path")
        })?;
        paths.push(path.to_string());
    }
    Ok(paths)
}

/// Selects the input source select when it is given, and returns the currently selected keyboard input source.
fn input_source(window: &Window, params: Map<String, Value>) -> Result<Value, Failure> {
    let select = match params.get("select") {
        None | Some(Value::Null) => None,
        Some(Value::String(identifier)) if !identifier.is_empty() => Some(identifier.clone()),
        Some(_) => return Err(Failure::params("select must be a non-empty string")),
    };
    let platform = platform::current().map_err(internal)?;
    let current = on_main(window, move || {
        if let Some(identifier) = &select {
            platform.select_input_source(identifier)?;
        }
        platform.input_source()
    })
    .map_err(internal)?;
    Ok(json!({"current": current}))
}

/// Creates `<config-dir>/test-project` with an empty folder setting and requests the page to open only that project.
fn fixture(host: &Host, window: &Window, request: Map<String, Value>) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let root = window.state::<Workspace>().directory().join("test-project");
    let settings = root.join(".soksak");
    platform.private_directory(&settings).map_err(internal)?;
    platform
        .write_private_file(&settings.join("settings.json"), b"{}\n")
        .map_err(internal)?;
    let mut params = Map::new();
    params.insert(
        "root".into(),
        Value::String(root.to_string_lossy().into_owned()),
    );
    // settings is the common setting to apply over the defaults. It must be an object when given.
    if let Some(settings) = request.get("settings") {
        if !settings.is_object() {
            return Err(Failure::params(
                "diagnostics.fixture settings must be an object",
            ));
        }
        params.insert("settings".into(), settings.clone());
    }
    exposure::parsed(&host.page(window, "diagnostics.fixture", params, TIMEOUT)?)
}

/// Requests the page to drag one boundary back and forth and sends the step times. It answers after the drag ends and
/// the window has drawn the result. When capture is set, it starts the window record before the drag and returns the
/// record directory.
fn drag(host: &Host, window: &Window, mut params: Map<String, Value>) -> Result<Value, Failure> {
    if !matches!(params.get("axis").and_then(Value::as_str), Some("x" | "y")) {
        return Err(Failure::params("axis must be x or y"));
    }
    for name in ["line", "dx", "dy", "ms", "times"] {
        if !params.get(name).is_some_and(Value::is_number) {
            return Err(Failure::params(format!("{name} must be a number")));
        }
    }
    let capture = match params.remove("capture") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(capture)) => capture,
        Some(_) => return Err(Failure::params("capture must be a boolean")),
    };
    // default: a missing or non-numeric value is set to 0 so that the check right below rejects it as an invalid
    // argument.
    let ms = params["ms"].as_f64().unwrap_or_default();
    // default: a missing or non-numeric value is set to 0 so that the check right below rejects it as an invalid
    // argument.
    let times = params["times"].as_u64().unwrap_or_default();
    if ms <= 0.0 || times < 1 {
        return Err(Failure::params(
            "ms must be positive and times must be at least 1",
        ));
    }
    let per = ((ms / FRAME.as_millis() as f64).round() as u64).max(1);
    let steps = per * 2 * times;

    let frames = if capture {
        Some(capture_start(window, false)?)
    } else {
        None
    };
    if capture {
        let platform = platform::current().map_err(internal)?;
        on_main(window, move || platform.layout_trace_start()).map_err(internal)?;
    }

    exposure::note(
        window,
        &format!(
            "diagnostics: drag {}:{} by {},{} in {per} steps, {times} times",
            // default: only the log text is built. The page checks the axis and answers an invalid value as an error.
            params["axis"].as_str().unwrap_or_default(),
            params["line"],
            params["dx"],
            params["dy"]
        ),
    );
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let length = FRAME * steps as u32;
    // When recording, the time at which the step was sent is kept on the same clock as the frames, so that the delay
    // from the step to the screen can be measured.
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::<f64>::new()));
    let clock = if frames.is_some() {
        Some(platform::current().map_err(internal)?)
    } else {
        None
    };
    let recorded = sent.clone();
    // The page discards the previous steps when it starts a drag, so the steps are sent after the request event.
    let result = host.page_then(
        window,
        "diagnostics.drag",
        params,
        Some(TIMEOUT + length),
        move || tick(app, label, steps, clock, recorded),
    );
    // The record is stopped regardless of the success of the drag.
    let layouts = (|| -> Result<_, Failure> {
        if frames.is_some() {
            let platform = platform::current().map_err(internal)?;
            on_main(window, move || platform.layout_trace_stop())
                .map(Some)
                .map_err(internal)
        } else {
            Ok(None)
        }
    })();
    let finished = (|| -> Result<Value, Failure> {
        let (result, layouts) = match (result, layouts) {
            (Ok(result), Ok(layouts)) => (result, layouts),
            (Err(error), Ok(_)) | (Ok(_), Err(error)) => return Err(error),
            (Err(error), Err(trace)) => {
                return Err(internal(format!(
                    "{}; layout trace: {}",
                    error.message, trace.message
                )))
            }
        };
        // Waits until the last placement is committed and presented. Waiting for one next presentation could end at a
        // presentation before the commit of the last step. The Wails host waits for the same point.
        let context = crate::windows::window_data(window).map_err(internal)?;
        let settled = crate::surfaces::when_settled(&context.running).map_err(internal)?;
        if settled.recv_timeout(TIMEOUT).is_err() {
            return Err(Failure::new(
                crate::endpoint::TIMED_OUT,
                format!("the drag was not presented within {TIMEOUT:?}"),
            ));
        }
        exposure::note(window, "diagnostics: drag presented");
        let mut merged = match exposure::parsed(&result)? {
            Value::Object(fields) => fields,
            Value::Null => Map::new(),
            _ => return Err(internal("the page drag result is not an object")),
        };
        if let Some(frames) = &frames {
            merged.insert(
                "frames".into(),
                Value::String(frames.to_string_lossy().into_owned()),
            );
            let ticks = sent.lock().map_err(internal)?.clone();
            merged.insert("ticks".into(), serde_json::json!(ticks));
            merged.insert(
                "layouts".into(),
                layout_trace(
                    layouts
                        .as_deref()
                        .ok_or_else(|| internal("the recorded drag has no layout trace"))?,
                ),
            );
        }
        Ok(Value::Object(merged))
    })();
    // When the requester cannot receive the frame folder, the recording is stopped and the folder is deleted.
    if let Err(error) = finished {
        if frames.is_some() {
            let cleanup =
                recorder().and_then(|capture| RECORDING.abort(&capture).map_err(internal));
            if let Err(cleanup) = cleanup {
                return Err(internal(format!(
                    "{}; abort capture: {}",
                    error.message, cleanup.message
                )));
            }
        }
        return Err(error);
    }
    finished
}

/// Sends the drag step time to the page steps times. Each step is sent at its scheduled time relative to the start
/// time. If each step slept in turn, the execution time of each step would accumulate into the later steps.
fn tick(
    app: tauri::AppHandle,
    label: String,
    steps: u64,
    clock: Option<&'static dyn platform::Platform>,
    sent: std::sync::Arc<std::sync::Mutex<Vec<f64>>>,
) {
    std::thread::spawn(move || {
        let began = Instant::now();
        for step in 1..=steps {
            let due = FRAME * step as u32;
            if let Some(left) = due.checked_sub(began.elapsed()) {
                std::thread::sleep(left);
            }
            if let Some(platform) = clock {
                match (platform.capture_clock(), sent.lock()) {
                    (Ok(now), Ok(mut ticks)) => ticks.push(now),
                    (Err(error), _) => log_error("drag tick clock", error),
                    (_, Err(error)) => log_error("drag tick clock", error),
                }
            }
            if let Err(error) = app.emit_to(EventTarget::webview(&label), "diagnostics-tick", ()) {
                log_error("diagnostics-tick", error);
                return;
            }
        }
    });
}

/// Starts the window record and returns the record directory. When display is set, it records the windows of this
/// application on the display that holds the window.
fn capture_start(window: &Window, display: bool) -> Result<PathBuf, Failure> {
    let platform = platform::current().map_err(internal)?;
    let held = window.clone();
    let numbers = on_main(window, move || platform.window_numbers(&held)).map_err(internal)?;
    let number = *numbers
        .first()
        .ok_or_else(|| internal("the window has no window number"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .map_err(|e| internal(format!("the system clock is before 1970: {e}")))?;
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("logs")
        .join("captures")
        .join(format!(
            "{stamp}-{}",
            CAPTURES.fetch_add(1, Ordering::Relaxed)
        ));
    let recorder = recorder()?;
    RECORDING
        .start(
            &recorder,
            Target {
                window: number,
                display,
            },
            &directory,
            &|path| recorder.0.private_directory(path),
        )
        .map_err(internal)?;
    Ok(directory)
}

/// Records until the presentation time after, ends the record in progress and returns the directory and the number of
/// frames.
fn capture_stop(window: &Window, after: f64) -> Result<Value, Failure> {
    let recorder = PlatformCapture(recorder()?.0, after);
    let (directory, count) = RECORDING.finish(&recorder).map_err(internal)?;
    let finished = (|| -> Result<Value, Failure> {
        let platform = recorder.0;
        let layouts = on_main(window, move || platform.layout_trace_stop()).map_err(internal)?;
        let limited = recorder.0.capture_limited().map_err(internal)?;
        let gap = recorder.0.capture_longest_gap().map_err(internal)?;
        Ok(crate::recording::stop_payload(
            &directory, count, limited, gap, &layouts,
        ))
    })();
    if let Err(error) = finished {
        if let Err(cleanup) = std::fs::remove_dir_all(&directory) {
            return Err(internal(format!(
                "{}; capture directory cleanup: {cleanup}",
                error.message
            )));
        }
        return Err(error);
    }
    finished
}

/// The modal content replies that were held for one window.
#[derive(Default)]
struct ModalHold {
    /// (whether it was released, the number of replies held)
    state: Mutex<(bool, u32)>,
    changed: Condvar,
}

/// The milliseconds by which the handling of the main webview navigation callback is delayed, by window name.
static NAVIGATION_DELAYS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// Delays the later handling of the navigation callback of the window by ms milliseconds. 0 removes the delay.
fn navigation_delay(window: &str, ms: u64) {
    let mut delays = NAVIGATION_DELAYS.lock().expect("navigation delays");
    let delays = delays.get_or_insert_with(HashMap::new);
    if ms == 0 {
        delays.remove(window);
    } else {
        delays.insert(window.to_string(), ms);
    }
}

/// Waits for the delay of the window, runs the handling of the navigation callback, and records the end in the
/// diagnostic record.
pub(crate) fn handle_navigation(window: &Window, handle: impl FnOnce()) {
    let delay = NAVIGATION_DELAYS
        .lock()
        .expect("navigation delays")
        .as_ref()
        .and_then(|delays| delays.get(window.label()).copied())
        // default: a window with no specified delay does not wait.
        .unwrap_or(0);
    std::thread::sleep(std::time::Duration::from_millis(delay));
    handle();
    exposure::note(
        window,
        &format!("navigation callback handled after {delay} ms"),
    );
}

/// Holds the modal content replies by window name. A check creates the order in which the modal document receives its
/// first content later than the following events.
static MODAL_HOLDS: Mutex<Option<HashMap<String, Arc<ModalHold>>>> = Mutex::new(None);

fn modal_hold_of(window: &str) -> Option<Arc<ModalHold>> {
    MODAL_HOLDS
        .lock()
        .expect("modal holds")
        .as_ref()?
        .get(window)
        .cloned()
}

/// Does not return while the replies of the window window are held.
pub(crate) fn hold_modal_content(window: &str) {
    let Some(hold) = modal_hold_of(window) else {
        return;
    };
    let mut state = hold.state.lock().expect("modal hold");
    state.1 += 1;
    hold.changed.notify_all();
    while !state.0 {
        state = hold.changed.wait(state).expect("modal hold");
    }
}

/// When on is set, starts to hold the modal content replies of the window; otherwise sends the held replies and stops
/// holding.
fn modal_hold(window: &str, on: bool) {
    let mut holds = MODAL_HOLDS.lock().expect("modal holds");
    let holds = holds.get_or_insert_with(HashMap::new);
    if on {
        holds.entry(window.to_string()).or_default();
    } else if let Some(hold) = holds.remove(window) {
        hold.state.lock().expect("modal hold").0 = true;
        hold.changed.notify_all();
    }
}

/// Returns the notifications of this application that the notification center still shows.
fn delivered_notifications(window: &Window) -> Result<Value, Failure> {
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform::current()?.delivered_notifications(Box::new(move |list| {
            if tx.send(list).is_err() {
                crate::application_log::log_info(
                    "diagnostics",
                    "delivered notifications arrived after their request ended",
                );
            }
        }))
    })
    .map_err(internal)?;
    let list = rx.recv_timeout(TIMEOUT).map_err(|_| {
        Failure::new(
            crate::endpoint::TIMED_OUT,
            format!(
                "the notification center did not list delivered notifications within {TIMEOUT:?}"
            ),
        )
    })?;
    serde_json::from_str(&list)
        .map_err(|error| internal(format!("delivered notifications {list:?}: {error}")))
}

fn modal_held(window: &str) -> Result<Value, Failure> {
    let hold = modal_hold_of(window)
        .ok_or_else(|| internal("modal content answers are not held in this window"))?;
    let mut state = hold.state.lock().map_err(internal)?;
    while state.1 == 0 && !state.0 {
        state = hold.changed.wait(state).map_err(internal)?;
    }
    Ok(Value::Null)
}
