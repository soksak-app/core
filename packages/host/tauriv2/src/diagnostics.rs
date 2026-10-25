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
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tauri::{Emitter, EventTarget, Manager, Window};

use crate::application_log::log_error;
use crate::endpoint::Failure;
use crate::exposure::{self, Exposure, Host, TIMEOUT, on_main};
use crate::object_counts::{
    DocumentObjects, HostObjects, ObjectCounter, ObjectCounts, PageObjects,
};
use crate::platform;
use crate::recording::{Capture, Recording, Target, layout_trace};
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
    fn start(&self, directory: &Path, frame_identity: bool) -> Result<(), String> {
        self.0
            .capture_start(&directory.to_string_lossy(), frame_identity)
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

/// Returns the host monotonic clock as an unsigned nanosecond value.
pub(crate) fn clock() -> Result<Value, Failure> {
    let mono_ns = crate::event_log::monotonic_ns();
    if mono_ns == 0 {
        return Err(internal("the monotonic clock returned zero"));
    }
    Ok(json!({"mono_ns": mono_ns.to_string()}))
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
            let options = parse_capture_start_options(&params)?;
            let display = options.display;
            let frames = capture_start(window, display, options.frame_identity)?;
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
        | "diagnostics.page.request"
        | "diagnostics.page.calls" => {
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
        "diagnostics.input.reference" => input_reference(window, &params),
        "diagnostics.log.flush" => crate::event_record::flush_records(TIMEOUT)
            .map(|()| Value::Null)
            .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error)),
        "diagnostics.host.relaunch" => relaunch(host),
        "diagnostics.test.mark" => {
            let mark = crate::test_mark::parse_test_mark(&params)?;
            crate::test_mark::emit_test_mark(&mark, TIMEOUT)
                .map(|(boot, seq)| json!({"boot": boot, "seq": seq}))
                .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error))
        }
        "diagnostics.stall.dump" => {
            let path = crate::stall_dump::parse_stall_dump(&params)?;
            crate::stall_dump::emit_stall_dump(&path, TIMEOUT)
                .map(|(boot, seq)| json!({"boot": boot, "seq": seq}))
                .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error))
        }
        "diagnostics.capture.still" => capture_still(window),
        "diagnostics.notifications" => delivered_notifications(window),
        "diagnostics.page.collect" => page_collect(window),
        "diagnostics.host.events" => host_events(window, &params),
        "diagnostics.native.objects" => native_objects(window, &params),
        "diagnostics.native.window-color-space" => native_window_color_space(window),
        "diagnostics.objects" => crate::object_counts::objects_reply(host, window.label()),
        "diagnostics.process.exit" => process_exit(window, &params),
        "diagnostics.memory.pressure" => {
            let level = crate::memory_pressure::parse_level(params.get("level"))
                .map_err(Failure::params)?;
            on_main(window, move || {
                platform::current()?.inject_memory_pressure(&level)
            })
            .map(|()| Value::Null)
            .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error))
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

#[derive(Debug, Default, PartialEq, Eq)]
struct CaptureStartOptions {
    display: bool,
    frame_identity: bool,
}

fn parse_capture_start_options(
    params: &Map<String, Value>,
) -> Result<CaptureStartOptions, Failure> {
    let display = match params.get("display") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(display)) => *display,
        Some(_) => return Err(Failure::params("display must be a boolean")),
    };
    let frame_identity = match params.get("frameIdentity") {
        None => false,
        Some(Value::Bool(frame_identity)) => *frame_identity,
        Some(_) => return Err(Failure::params("frameIdentity must be a boolean")),
    };
    Ok(CaptureStartOptions {
        display,
        frame_identity,
    })
}

/// Quits the application as host.quit does and starts it again with the same executable and arguments once this process
/// has ended, so the new process reads the files that a check left in the configuration folder
/// (docs/spec/endpoint.md#diagnostic-builds). It replies once the quit has begun.
fn relaunch(host: &Host) -> Result<Value, Failure> {
    let failed = |error: String| Failure::new(crate::endpoint::HANDLER_FAILED, error);
    let executable = std::env::current_exe()
        .map_err(|error| failed(format!("application relaunch: {error}")))?;
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = crate::app_update::prepare_relaunch(&executable, std::process::id(), &arguments)
        .map_err(failed)?;
    *host
        .0
        .state::<crate::windows::Windows>()
        .update
        .lock()
        // default: a lock that a panicking thread poisoned still holds the pending update, which the call replaces; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner) = Some(crate::app_update::PendingStart {
        command,
        relaunch: true,
    });
    host.0.exit(0);
    Ok(Value::Null)
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

/// The most events of one diagnostics.host.events request (docs/spec/endpoint.md).
const MAX_HOST_EVENTS: u64 = 1000;

/// Sends count host events diagnostics-unlistened, for which the page declares no listener, to the main page of the
/// window.
fn host_events(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let count = params
        .get("count")
        .and_then(Value::as_u64)
        .filter(|count| (1..=MAX_HOST_EVENTS).contains(count))
        .ok_or_else(|| {
            Failure::params(format!(
                "diagnostics.host.events requires a count from 1 to {MAX_HOST_EVENTS}"
            ))
        })?;
    let label = window.label().to_string();
    for _ in 0..count {
        window
            .app_handle()
            .emit_to(EventTarget::webview(&label), "diagnostics-unlistened", ())
            .map_err(internal)?;
    }
    Ok(json!({"count": count}))
}

impl ObjectCounter for Host {
    /// Counts the objects of the window (docs/spec/endpoint.md): the registries of the host, the elements and documents
    /// of the main page, and the elements and documents of each created document region. The handles are read and
    /// counted on the main thread, which closes a document region, so no handle is used after its region is closed.
    fn object_counts(&self, window: &str) -> Result<ObjectCounts, Failure> {
        let window = crate::windows::find(&self.0, window)
            .ok_or_else(|| crate::endpoint::missing_window(window))?;
        objects(&window)
    }
}

fn objects(window: &Window) -> Result<ObjectCounts, Failure> {
    let target = window.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let pages = on_main(window, move || {
        let view = crate::windows::root_view(&target)
            .ok_or_else(|| "the main page is gone".to_string())?;
        let attached = crate::windows::window_data(&target)?.documents.attached();
        let pages = 1 + attached.len();
        crate::exposure::with_view(&view, move |native| {
            let platform = platform::current()?;
            let sender = tx.clone();
            platform.count_page_objects(
                native.inner() as platform::Handle,
                false,
                Box::new(move |counts| {
                    if sender.send((None, counts)).is_err() {
                        crate::application_log::log_info(
                            "diagnostics",
                            "object counts arrived after their request ended",
                        );
                    }
                }),
            )?;
            for (key, handle) in attached {
                let sender = tx.clone();
                platform.count_page_objects(
                    handle,
                    true,
                    Box::new(move |counts| {
                        if sender.send((Some(key), counts)).is_err() {
                            crate::application_log::log_info(
                                "diagnostics",
                                "object counts arrived after their request ended",
                            );
                        }
                    }),
                )?;
            }
            Ok(())
        })?;
        Ok(pages)
    })
    .map_err(internal)?;
    let mut page = PageObjects::default();
    let mut documents = Vec::new();
    let mut failures = Vec::new();
    for _ in 0..pages {
        let (key, counts) = rx.recv_timeout(TIMEOUT).map_err(|_| {
            Failure::new(
                crate::endpoint::TIMED_OUT,
                format!("the page did not answer the object counts within {TIMEOUT:?}"),
            )
        })?;
        match (key, counts) {
            (None, Ok(counts)) => page = counts,
            (Some(key), Ok(counts)) => documents.push((key, counts)),
            (_, Err(error)) => failures.push(error),
        }
    }
    if !failures.is_empty() {
        return Err(internal(failures.join("; ")));
    }
    let data = crate::windows::window_data(window).map_err(internal)?;
    let surfaces = data.views.count().map_err(internal)?;
    let sidecars = window.state::<crate::sidecars::WindowSidecars>();
    let exposure = window.state::<Exposure>();
    let relay = &exposure.relay;
    let sessions = sidecars.sessions(window);
    let host = HostObjects {
        surfaces,
        regions: data.images.count(),
        documents: data.documents.count(),
        sidecar_sessions: sessions.len(),
        pending_replies: sidecars.pending_count(window) + relay.pending_count(window.label()),
        event_subscribers: crate::exposure::subscribers(window),
    };
    Ok(ObjectCounts {
        host,
        page,
        documents: documents
            .into_iter()
            .map(|((surface, document), counts)| DocumentObjects {
                surface,
                document,
                counts,
            })
            .collect(),
        sessions,
    })
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
            format!(
                "window object counts did not reach {expected} within {TIMEOUT:?}; they are {counts}"
            ),
        ));
    }
    Ok(counts.payload())
}

fn native_window_color_space(window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    crate::windows::with_native_owner(window, move |handle| platform.window_color_space(handle))
        .map_err(exposure::native_failure(
            window.label(),
            crate::endpoint::HANDLER_FAILED,
        ))
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

/// Validates input reference actions and their expected document.
fn parse_input_reference(params: &Map<String, Value>) -> Result<(String, Option<String>), Failure> {
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "open" | "read" | "focus" | "wait" | "close"))
        .ok_or_else(|| {
            Failure::params("input reference action must be open, read, focus, wait or close")
        })?;
    if action != "wait" {
        if params.contains_key("document") {
            return Err(Failure::params("input reference document is only for wait"));
        }
        return Ok((action.into(), None));
    }
    let document = params
        .get("document")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::params("input reference wait requires a document string"))?;
    Ok((action.into(), Some(document.into())))
}

fn input_reference(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let (action, document) = parse_input_reference(params)?;
    let platform = platform::current().map_err(internal)?;
    let native = platform.window_handle(window).map_err(internal)?;
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform.input_reference(
            native,
            &action,
            document.as_deref(),
            Box::new(move |result| {
                if let Err(unsent) = tx.send(result) {
                    log_error(
                        "input reference",
                        format!(
                            "the reference answered after its reply ended: {:?}",
                            unsent.0
                        ),
                    );
                }
            }),
        );
        Ok(())
    })
    .map_err(internal)?;
    rx.recv()
        .map_err(|_| internal("input reference ended without an answer"))?
        .map_err(internal)
}

fn input_source(window: &Window, params: Map<String, Value>) -> Result<Value, Failure> {
    let select = match params.get("select") {
        None | Some(Value::Null) => None,
        Some(Value::String(identifier)) if !identifier.is_empty() => Some(identifier.clone()),
        Some(_) => return Err(Failure::params("select must be a non-empty string")),
    };
    let platform = platform::current().map_err(internal)?;
    // The text input context of the key view takes a selected source later than the system; the reply waits until it holds it,
    // so a key that the caller sends after the reply reaches the selected source.
    let (adopted, held) = std::sync::mpsc::channel();
    let waits = select.is_some();
    let current = on_main(window, move || {
        if let Some(identifier) = &select {
            platform.select_input_source(identifier)?;
            platform.await_input_source(
                identifier,
                Box::new(move |result| {
                    if let Err(unsent) = adopted.send(result) {
                        log_error(
                            "input source",
                            format!("the wait answered after its reply ended: {:?}", unsent.0),
                        );
                    }
                }),
            );
        }
        platform.input_source()
    })
    .map_err(internal)?;
    if waits {
        held.recv()
            .map_err(|_| {
                internal("the wait for the input source ended without an answer".to_string())
            })?
            .map_err(internal)?;
    }
    Ok(json!({"current": current}))
}

/// Creates `<config-dir>/test-project` with an empty folder setting and requests the page to open only that project.
fn fixture(host: &Host, window: &Window, request: Map<String, Value>) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let root = window.state::<Workspace>().directory().join("test-project");
    let settings = root.join(".soksak");
    platform.private_directory(&settings).map_err(internal)?;
    // The project settings file is written in the current numbered form (docs/spec/installation.md#stored-data-migration).
    let format = soksak_sok::migrate::settings_format().map_err(internal)?;
    platform
        .write_private_file(
            &settings.join("settings.json"),
            format!("{{\"format\": {format}}}\n").as_bytes(),
        )
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
        Some(capture_start(window, false, false)?)
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
                )));
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
            // default: a lock that a panicking thread poisoned still holds the pointer ticks of the drag, which are
            // only read; the panic hook records the panic.
            let ticks = sent.lock().unwrap_or_else(PoisonError::into_inner).clone();
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
    crate::routine::spawn_named("diagnostics-ticks", move || {
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
fn capture_start(window: &Window, display: bool, frame_identity: bool) -> Result<PathBuf, Failure> {
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
            frame_identity,
            &|path| recorder.0.private_directory(path),
        )
        .map_err(internal)?;
    Ok(directory)
}

/// Records until the presentation time after, ends the record in progress and returns the directory and the number of
/// frames.
fn capture_stop(window: &Window, after: f64) -> Result<Value, Failure> {
    let recorder = PlatformCapture(recorder()?.0, after);
    let (directory, count, frame_identity) = RECORDING.finish(&recorder).map_err(internal)?;
    finish_capture_stop(&directory, count, frame_identity, || {
        let platform = recorder.0;
        let layouts = on_main(window, move || platform.layout_trace_stop()).map_err(internal)?;
        let limited = recorder.0.capture_limited().map_err(internal)?;
        let gap = recorder.0.capture_longest_gap().map_err(internal)?;
        Ok((layouts, limited, gap))
    })
}

fn finish_capture_stop(
    directory: &Path,
    count: i32,
    frame_identity: bool,
    finalize: impl FnOnce() -> Result<(Vec<[f64; 5]>, bool, f64), Failure>,
) -> Result<Value, Failure> {
    match finalize() {
        Ok((layouts, limited, gap)) => Ok(crate::recording::stop_payload(
            directory,
            count,
            limited,
            gap,
            &layouts,
            frame_identity,
        )),
        Err(error) => Err(error),
    }
}

/// The modal content replies that were held for one window.
#[derive(Default)]
struct ModalHold {
    /// (whether it was released, the number of replies held)
    state: Mutex<(bool, u32)>,
    changed: Condvar,
}

/// Holds the modal content replies by window name. A check creates the order in which the modal document receives its
/// first content later than the following events.
static MODAL_HOLDS: Mutex<Option<HashMap<String, Arc<ModalHold>>>> = Mutex::new(None);

fn modal_hold_of(window: &str) -> Option<Arc<ModalHold>> {
    MODAL_HOLDS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the held modal replies, which are only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()?
        .get(window)
        .cloned()
}

/// Does not return while the replies of the window window are held.
pub(crate) fn hold_modal_content(window: &str) {
    let Some(hold) = modal_hold_of(window) else {
        return;
    };
    // default: a lock that a panicking thread poisoned still holds the held reply count, which the hold amends; the
    // panic hook records the panic.
    let mut state = hold.state.lock().unwrap_or_else(PoisonError::into_inner);
    state.1 += 1;
    hold.changed.notify_all();
    while !state.0 {
        state = hold
            .changed
            .wait(state)
            // default: a wait that a poisoned lock ends still returns the guard of the held reply count, which the hold
            // reads; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
    }
}

/// When on is set, starts to hold the modal content replies of the window; otherwise sends the held replies and stops
/// holding.
fn modal_hold(window: &str, on: bool) {
    // default: a lock that a panicking thread poisoned still holds the held modal replies, which the call amends; the
    // panic hook records the panic.
    let mut holds = MODAL_HOLDS.lock().unwrap_or_else(PoisonError::into_inner);
    let holds = holds.get_or_insert_with(HashMap::new);
    if on {
        holds.entry(window.to_string()).or_default();
    } else if let Some(hold) = holds.remove(window) {
        // default: a lock that a panicking thread poisoned still holds the held reply count, which the release amends;
        // the panic hook records the panic.
        hold.state.lock().unwrap_or_else(PoisonError::into_inner).0 = true;
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
    // default: a lock that a panicking thread poisoned still holds the held answer of the modal, and the wait loses no
    // notification it was not waiting for; the panic hook records the panic.
    let mut state = hold.state.lock().unwrap_or_else(PoisonError::into_inner);
    while state.1 == 0 && !state.0 {
        state = hold
            .changed
            .wait(state)
            // default: the same recovery holds for the wait of the condition, which ends with the lock of the same
            // held answer; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
    }
    Ok(Value::Null)
}

#[cfg(test)]
#[path = "diagnostics_lock_test.rs"]
mod lock_test;

#[cfg(test)]
#[path = "diagnostics_input_reference_test.rs"]
mod input_reference_test;

#[cfg(test)]
mod capture_start_options_test {
    use super::*;

    #[test]
    fn capture_start_options_preserve_display_parsing() {
        for (json, expected) in [
            (json!({}), false),
            (json!({"display": false}), false),
            (json!({"display": true}), true),
            (json!({"display": null}), false),
        ] {
            let params = json.as_object().unwrap().clone();
            let got = parse_capture_start_options(&params).unwrap();
            assert_eq!(got.display, expected, "params {params:?}");
        }
        for value in [json!("true"), json!(1), json!([]), json!({})] {
            let mut params = Map::new();
            params.insert("display".into(), value);
            assert!(
                parse_capture_start_options(&params).is_err(),
                "params {params:?}"
            );
        }
        assert!(
            !parse_capture_start_options(&Map::new())
                .unwrap()
                .frame_identity
        );
    }

    #[test]
    fn capture_start_options_parse_frame_identity_and_reject_non_booleans() {
        for (value, expected) in [(Value::Bool(false), false), (Value::Bool(true), true)] {
            let params = Map::from_iter([("frameIdentity".into(), value)]);
            assert_eq!(
                parse_capture_start_options(&params).unwrap().frame_identity,
                expected
            );
        }
        for value in [Value::Null, json!("true"), json!(1), json!([]), json!({})] {
            let params = Map::from_iter([("frameIdentity".into(), value)]);
            assert!(
                parse_capture_start_options(&params).is_err(),
                "params {params:?}"
            );
        }
    }
}

#[cfg(test)]
#[path = "diagnostics_capture_stop_test.rs"]
mod capture_stop_test;
