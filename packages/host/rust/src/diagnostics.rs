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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::framework::{Manager, Window};
use serde_json::{Map, Value, json};

use crate::application_log::log_error;
use crate::documents::Documents;
use crate::endpoint::Failure;
use crate::exposure::{self, Exposure, Host, on_main};
use crate::object_counts::{
    DocumentObjects, HostObjects, ObjectCounter, ObjectCounts, PageObjects,
};
use crate::platform;
use crate::platform::{DocumentViewportMarker, Handle};
use crate::recording::{
    Capture, NewWindowCapture, Plan, Recording, StillCounts, Target, layout_trace,
};
use crate::workspace::Workspace;

/// A recording in progress.
static RECORDING: Recording = Recording::new();
/// The window recording operation of the platform. `after` is the time (ms) from which a still must be requested before the
/// recording stops, 0 for a stop that requests no later still; `window` and `connection` are the label of the window and the end of the endpoint connection of the
/// request, whose ends end the waits of the operations.
struct PlatformCapture {
    platform: &'static dyn platform::Platform,
    after: f64,
    window: String,
    connection: crate::endpoint::ConnectionEnd,
    /// The window of the request, whose main thread runs the hold of a new window.
    main: Window,
}

impl NewWindowCapture for PlatformCapture {
    fn hold_new_window(&self) -> Result<(), String> {
        let platform = self.platform;
        on_main(&self.main, move || platform.capture_hold_new_window())
    }
    /// Waits as the other capture operations do, until the close of the endpoint connection of the request or of its
    /// window, also after the request returned, because the hold of a recording that the request started waits for a
    /// window that the application has not created yet.
    fn wait_new_window(
        &self,
        register_end: &dyn Fn(Box<dyn Fn(&'static str) + Send + Sync>),
    ) -> Result<isize, String> {
        let platform = self.platform;
        self.await_capture(|token| {
            register_end(Box::new(move |reason| {
                platform.capture_end_wait(token, reason)
            }));
            platform.capture_wait_new_window(token)
        })
    }
    fn release_new_window(&self) {
        self.platform.capture_release_new_window();
    }
}

impl Capture for PlatformCapture {
    fn open(&self, target: Target) -> Result<(), String> {
        self.platform.capture_open(target.window, target.display)
    }
    /// Waits, as the other capture waits do, for still 0 of the recording.
    fn start(&self, directory: &Path, plan: Plan) -> Result<(), String> {
        self.await_capture(|token| {
            self.platform.capture_start(
                &directory.to_string_lossy(),
                plan.gap,
                plan.seconds,
                plan.frames,
                token,
            )
        })
    }
    fn stop(&self) -> Result<i32, String> {
        self.await_capture(|token| self.platform.capture_stop(self.after, token))
    }
}

/// Gives each capture operation that waits a new, larger token.
static CAPTURE_TOKENS: AtomicU64 = AtomicU64::new(0);

impl PlatformCapture {
    /// Runs the capture operation call with a new token, whose wait `capture_end_wait` of the platform ends.
    fn await_capture<T>(&self, call: impl FnOnce(u64) -> T) -> T {
        let platform = self.platform;
        await_capture(
            &self.window,
            &self.connection,
            move |token, reason| platform.capture_end_wait(token, reason),
            call,
        )
    }
}

/// Runs the capture operation call with a new token. No limit ends its wait: the first of the close of connection, the
/// close of window and the end of its page ends it through `end_wait`, given the token and the reason of that end, and the
/// operation then fails with that reason. `end_wait` runs once at most, and not after the operation returned.
fn await_capture<T>(
    window: &str,
    connection: &crate::endpoint::ConnectionEnd,
    end_wait: impl Fn(u64, &'static str) + Send + Sync + 'static,
    call: impl FnOnce(u64) -> T,
) -> T {
    let token = CAPTURE_TOKENS.fetch_add(1, Ordering::Relaxed) + 1;
    let id = NATIVE_WAIT_IDS.fetch_add(1, Ordering::Relaxed);
    let pending = Arc::new(AtomicBool::new(true));
    let end = {
        let pending = pending.clone();
        let end_wait = Arc::new(end_wait);
        move |reason: &'static str| {
            if pending.swap(false, Ordering::AcqRel) {
                end_wait(token, reason);
            }
        }
    };
    native_waits()
        .get_or_insert_with(HashMap::new)
        .entry(window.to_string())
        .or_default()
        .insert(id, Box::new(end.clone()));
    // The watch ends when the operation returns, so the close of the connection ends no later wait.
    let connection_watch = connection.watch(move || end(WAIT_END_CONNECTION));
    let value = call(token);
    drop(connection_watch);
    pending.store(false, Ordering::Release);
    if let Some(waits) = native_waits()
        .get_or_insert_with(HashMap::new)
        .get_mut(window)
    {
        waits.remove(&id);
    }
    value
}

/// The recording device of the platform for a request on connection about window.
fn recorder(
    window: &Window,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<PlatformCapture, Failure> {
    Ok(PlatformCapture {
        platform: platform::current().map_err(internal)?,
        after: 0.0,
        window: window.label().to_string(),
        connection: connection.clone(),
        main: window.clone(),
    })
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
    reply: Option<&crate::endpoint::ReplyScope>,
) -> Result<Value, Failure> {
    // The waits of the request and the holds that it opens end with the connection of the request, because no answer
    // reaches a closed connection (docs/spec/endpoint.md).
    let connection = reply
        .map(crate::endpoint::ReplyScope::connection_end)
        // default: a hold that an internal request opens has no connection to end it; it ends with its own end or its window.
        .unwrap_or_else(crate::endpoint::ConnectionEnd::open);
    match method {
        "diagnostics.fixture" => fixture(host, window, params),
        "diagnostics.drag" => drag(host, window, params, &connection),
        "diagnostics.layout.trace" => layout_trace_request(window, &params, &connection),
        "diagnostics.document.viewport-marker" => document_viewport_marker(window, &params),
        "diagnostics.capture.start" => {
            let options = parse_capture_start_options(&params)?;
            if options.new_window {
                let frames = capture_start_new_window(window, &connection, options.plan)?;
                // The held window is known once the application shows it, after this reply; the stop reply names it.
                return Ok(json!({"frames": frames.to_string_lossy(), "window": null}));
            }
            let display = options.display;
            let (frames, recorded) = capture_start(window, &connection, display, options.plan)?;
            Ok(json!({"frames": frames.to_string_lossy(), "window": recorded}))
        }
        "diagnostics.capture.stop" => {
            let after = match params.get("after") {
                None | Some(Value::Null) => 0.0,
                Some(value) => value
                    .as_f64()
                    .filter(|after| *after >= 0.0)
                    .ok_or_else(|| Failure::params("after must be a non-negative number"))?,
            };
            capture_stop(window, &connection, after)
        }
        // Diagnostic methods that the main page handles. The exposure reply of a surface must be caught before it
        // leaves the page, because otherwise it arrives after the request ended, so the page also handles the catching
        // of surface replies (docs/spec/endpoint.md).
        "diagnostics.surface.hold" => {
            let surface = params
                .get("surface")
                .and_then(Value::as_str)
                .map(str::to_string);
            let held = exposure::parsed(&host.page(window, method, params, reply)?)?;
            // The page refuses a surface that is not a nonempty string, so a hold that it accepted names its surface.
            if let Some(surface) = surface {
                let released = window.clone();
                let name = surface.clone();
                remember_surface_hold(window.label(), &surface, &connection, move || {
                    if let Err(error) =
                        released.emit("diagnostics-surface-released", json!({ "surface": name }))
                    {
                        log_error("diagnostics-surface-released", error);
                    }
                });
            }
            Ok(held)
        }
        "diagnostics.transcript"
        | "diagnostics.surface.held"
        | "diagnostics.layout.fail"
        | "diagnostics.page.request"
        | "diagnostics.page.calls" => exposure::parsed(&host.page(window, method, params, None)?),
        "diagnostics.modal.hold" => {
            let Some(on) = params.get("on").and_then(Value::as_bool) else {
                return Err(Failure::params("on must be a boolean"));
            };
            modal_hold(window.label(), on, &connection);
            Ok(Value::Null)
        }
        "diagnostics.modal.held" => modal_held(window.label()),
        "diagnostics.input.source" => input_source(window, params, &connection),
        "diagnostics.input.reference" => input_reference(window, &params, &connection),
        "diagnostics.log.flush" => crate::event_record::flush_records()
            .map(|()| Value::Null)
            .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error)),
        "diagnostics.host.relaunch" => relaunch(host),
        "diagnostics.test.mark" => {
            let mark = crate::test_mark::parse_test_mark(&params)?;
            crate::test_mark::emit_test_mark(&mark)
                .map(|(boot, seq)| json!({"boot": boot, "seq": seq}))
                .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error))
        }
        "diagnostics.stall.dump" => {
            let path = crate::stall_dump::parse_stall_dump(&params)?;
            crate::stall_dump::stall_dump(
                &path,
                window.label(),
                &crate::running_calls::RUNNING_CALLS,
                std::time::Instant::now(),
            )
            .map_err(|error| Failure::new(crate::endpoint::HANDLER_FAILED, error))
        }
        "diagnostics.capture.still" => capture_still(window),
        "diagnostics.notifications" => delivered_notifications(window),
        "diagnostics.page.collect" => page_collect(window),
        "diagnostics.host.events" => host_events(window, &params),
        "diagnostics.native.objects" => native_objects(window, &params, &connection),
        "diagnostics.native.window-color-space" => native_window_color_space(window),
        "diagnostics.objects" => crate::object_counts::objects_reply(host, window.label()),
        "diagnostics.process.exit" => process_exit(window, &params, &connection),
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
        "diagnostics.window.draw-covered" => {
            let Some(draw) = params.get("draw").and_then(Value::as_bool) else {
                return Err(Failure::params("draw must be a boolean"));
            };
            draw_covered(window, draw)
        }
        _ => Err(Failure::new(
            -32601,
            format!("{method} is not a diagnostic method"),
        )),
    }
}

/// Makes the image regions and the documents of the document regions of the window draw while the window is covered, or ends
/// that, and sends the drawing state that changed. The window keeps reporting its occlusion
/// (docs/spec/native-surfaces.md#image-regions, docs/spec/native-surfaces.md#document-regions).
fn draw_covered(window: &Window, draw: bool) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    crate::windows::with_native_owner(window, move |handle| {
        platform.draw_documents_covered(handle, draw)
    })
    .map_err(exposure::native_failure(
        window.label(),
        crate::endpoint::HANDLER_FAILED,
    ))?;
    crate::windows::with_open_window(&crate::windows::window_data(window), |data| {
        data.images.set_draw_covered(draw);
        crate::composition::send_image_drawing_of(window, data)
    })
    .map(|()| Value::Null)
    .map_err(internal)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DocumentViewportMarkerRequest {
    surface: String,
    document: String,
    enabled: bool,
}

fn parse_document_viewport_marker_request(
    params: &Map<String, Value>,
) -> Result<DocumentViewportMarkerRequest, Failure> {
    let text = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| Failure::params(format!("{name} must be a non-empty string")))
    };
    let enabled = params
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| Failure::params("enabled must be a boolean"))?;
    Ok(DocumentViewportMarkerRequest {
        surface: text("surface")?,
        document: text("document")?,
        enabled,
    })
}

fn resolve_document_viewport_marker_handle(
    documents: &Documents,
    request: &DocumentViewportMarkerRequest,
) -> Result<Option<Handle>, String> {
    let key = (request.surface.clone(), request.document.clone());
    let document = documents
        .attached()
        .into_iter()
        .find_map(|(attached, handle)| (attached == key).then_some(handle));
    match (document, request.enabled) {
        (Some(handle), _) => Ok(Some(handle)),
        (None, false) => Ok(None),
        (None, true) => Err(format!(
            "document {:?} is not attached to surface {:?} in this window",
            request.document, request.surface
        )),
    }
}

type DocumentViewportMarkerWork =
    Box<dyn FnOnce() -> Result<DocumentViewportMarker, String> + Send>;

fn dispatch_document_viewport_marker(
    request: DocumentViewportMarkerRequest,
    schedule: impl FnOnce(DocumentViewportMarkerWork) -> Result<DocumentViewportMarker, String>,
    apply: impl FnOnce(DocumentViewportMarkerRequest) -> Result<DocumentViewportMarker, String>
    + Send
    + 'static,
) -> Result<Value, Failure> {
    let result = schedule(Box::new(move || apply(request))).map_err(internal)?;
    Ok(result.payload())
}

fn document_viewport_marker(
    window: &Window,
    params: &Map<String, Value>,
) -> Result<Value, Failure> {
    let request = parse_document_viewport_marker_request(params)?;
    let scheduled_window = window.clone();
    let operation_window = window.clone();
    dispatch_document_viewport_marker(
        request,
        move |work| on_main(&scheduled_window, work),
        move |request| {
            let data = crate::windows::window_data(&operation_window)?;
            let document = resolve_document_viewport_marker_handle(&data.documents, &request)?;
            platform::current()?.document_viewport_marker(document, request.enabled)
        },
    )
}

#[derive(Debug, Default, PartialEq)]
struct CaptureStartOptions {
    display: bool,
    new_window: bool,
    plan: Plan,
}

/// The largest number of stills that a recording plans (native/darwin/src/capture.h).
const CAPTURE_PLAN_LIMIT: f64 = 4096.0;

/// Reads the plan of the stills of a recording, gap and seconds or frames, and refuses it with the messages of the native
/// start (native/darwin/src/capture.h) before any window is held or prepared.
fn parse_capture_plan(params: &Map<String, Value>) -> Result<Plan, Failure> {
    let given = |name: &str| params.get(name).filter(|value| !value.is_null());
    let gap = given("gap")
        .and_then(Value::as_f64)
        .filter(|gap| (1.0..=1000.0).contains(gap))
        .ok_or_else(|| Failure::params("gap must be a number of milliseconds from 1 to 1000"))?;
    match (given("seconds"), given("frames")) {
        (Some(_), Some(_)) => Err(Failure::params("give seconds or frames, not both")),
        (None, None) => Err(Failure::params("a recording needs seconds or frames")),
        (Some(seconds), None) => {
            let seconds = seconds
                .as_f64()
                .filter(|seconds| *seconds > 0.0 && *seconds <= 600.0)
                .ok_or_else(|| Failure::params("seconds must be above 0 and at most 600"))?;
            // Every still whose planned time n·gap is before the length.
            let count = (seconds * 1000.0 / gap).ceil();
            if count > CAPTURE_PLAN_LIMIT {
                return Err(Failure::params(format!(
                    "the recording plans {count:.0} stills, more than {CAPTURE_PLAN_LIMIT:.0}"
                )));
            }
            Ok(Plan {
                gap,
                seconds,
                frames: 0,
            })
        }
        (None, Some(frames)) => {
            let frames = frames
                .as_f64()
                .filter(|frames| {
                    frames.fract() == 0.0 && (1.0..=CAPTURE_PLAN_LIMIT).contains(frames)
                })
                .ok_or_else(|| {
                    Failure::params(format!(
                        "frames must be an integer from 1 to {CAPTURE_PLAN_LIMIT:.0}"
                    ))
                })?;
            Ok(Plan {
                gap,
                seconds: 0.0,
                frames: frames as i32,
            })
        }
    }
}

fn parse_capture_start_options(
    params: &Map<String, Value>,
) -> Result<CaptureStartOptions, Failure> {
    let plan = parse_capture_plan(params)?;
    let display = match params.get("display") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(display)) => *display,
        Some(_) => return Err(Failure::params("display must be a boolean")),
    };
    let new_window = match params.get("newWindow") {
        None => false,
        Some(Value::Bool(new_window)) => *new_window,
        Some(_) => return Err(Failure::params("newWindow must be a boolean")),
    };
    if new_window && display {
        return Err(Failure::params(
            "newWindow records the new window alone and cannot be combined with display",
        ));
    }
    Ok(CaptureStartOptions {
        display,
        new_window,
        plan,
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
    crate::event_record::quit_with_cause(
        "update",
        crate::event_record::host_quit_source("update"),
        || host.0.quit(),
    );
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
    for _ in 0..count {
        window
            .emit("diagnostics-unlistened", ())
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
        // The library answers each count once on every path, so the host waits without a limit of its own.
        let (key, counts) = rx
            .recv()
            .map_err(|_| internal("the object counts ended before they answered"))?;
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
fn native_objects(
    window: &Window,
    params: &Map<String, Value>,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<Value, Failure> {
    let expected = params
        .get("equal")
        .map(platform::WindowObjects::from_equal)
        .transpose()
        .map_err(Failure::params)?;
    let ((counts, reached), end) = await_native(window, connection, move |done| {
        let end = platform::current()?.window_objects_when(
            expected,
            Box::new(move |counts, reached| done((counts, reached))),
        )?;
        Ok(Box::new(move |_| end()) as NativeEnd)
    })?;
    // default: a wait that its event answered has no end, which the answer names as no reason.
    native_objects_answer(expected, counts, reached, end.unwrap_or_default())
}

/// The answer of diagnostics.native.objects to the counts that the library gave and the end of a wait that did not reach
/// them. Counts that the library did not reach without expected counts mean that the wait ended before the application
/// handled an event.
fn native_objects_answer(
    expected: Option<platform::WindowObjects>,
    counts: platform::WindowObjects,
    reached: bool,
    end: &str,
) -> Result<Value, Failure> {
    match (reached, expected) {
        (true, _) => Ok(counts.payload()),
        (false, None) => Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!(
                "the window object counts ended before the application handled an event: {end}"
            ),
        )),
        (false, Some(expected)) => Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!(
                "window object counts did not reach {expected} before {end}; they are {counts}"
            ),
        )),
    }
}

/// The ends of a native wait for an event that may not come (docs/spec/endpoint.md); no limit ends it.
pub(crate) const WAIT_END_CONNECTION: &str = "the endpoint connection of the request closed";
pub(crate) const WAIT_END_WINDOW: &str = "the window closed";
pub(crate) const WAIT_END_PAGE: &str = "the page of the window ended";

/// Ends a native wait that has not answered, given the reason of its end; the library then answers it. It runs on the main
/// thread.
type NativeEnd = Box<dyn FnOnce(&'static str) + Send>;

/// What a native wait receives: the answer of the library or an end.
enum NativeEvent<T> {
    Answer(T),
    End(&'static str),
}

/// The end of each native wait of each window that has not answered, by window and wait.
type NativeWaits = HashMap<String, HashMap<u64, Box<dyn Fn(&'static str) + Send>>>;

static NATIVE_WAITS: Mutex<Option<NativeWaits>> = Mutex::new(None);
static NATIVE_WAIT_IDS: AtomicU64 = AtomicU64::new(1);

fn native_waits() -> MutexGuard<'static, Option<NativeWaits>> {
    // default: a lock that a panicking thread poisoned still holds the native waits, which the caller amends; the panic
    // hook records the panic.
    NATIVE_WAITS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Ends the native waits of window that have not answered, naming end.
pub(crate) fn end_native_waits(window: &str, end: &'static str) {
    let waits = native_waits()
        .get_or_insert_with(HashMap::new)
        .remove(window);
    for wait in waits.into_iter().flat_map(HashMap::into_values) {
        wait(end);
    }
}

/// Starts a native wait of window on the main thread and returns its answer. The wait ends by its answer or by the first
/// of the close of connection, the close of the window and the end of its page; the end that start returned then makes
/// the library answer, and the reason of that end is returned with the answer. An answer that came first has no reason.
fn await_native<T: Send + 'static>(
    window: &Window,
    connection: &crate::endpoint::ConnectionEnd,
    start: impl FnOnce(Box<dyn FnOnce(T) + Send>) -> Result<NativeEnd, String> + Send + 'static,
) -> Result<(T, Option<&'static str>), Failure> {
    native_wait(
        window.label(),
        connection,
        |work| {
            on_main(window, move || {
                work();
                Ok(())
            })
        },
        start,
    )
}

/// The wait of await_native for the window with label, where main runs work on the main thread and returns after it ran.
fn native_wait<T: Send + 'static>(
    label: &str,
    connection: &crate::endpoint::ConnectionEnd,
    main: impl Fn(Box<dyn FnOnce() + Send>) -> Result<(), String>,
    start: impl FnOnce(Box<dyn FnOnce(T) + Send>) -> Result<NativeEnd, String> + Send + 'static,
) -> Result<(T, Option<&'static str>), Failure> {
    let (tx, rx) = std::sync::mpsc::channel();
    let label = label.to_string();
    let id = NATIVE_WAIT_IDS.fetch_add(1, Ordering::Relaxed);
    // The ends reach the wait while it waits; forget takes the sender away before the receiver goes, so an end that comes
    // later finds nothing to end.
    let ends = Arc::new(Mutex::new(Some(tx.clone())));
    let send_end = {
        let ends = ends.clone();
        move |end: &'static str| {
            // default: a lock that a panicking thread poisoned still holds the sender of the wait, which the end uses;
            // the panic hook records the panic.
            if let Some(sender) = ends.lock().unwrap_or_else(PoisonError::into_inner).as_ref()
                && sender.send(NativeEvent::End(end)).is_err()
            {
                log_error(
                    "diagnostics",
                    "a native wait lost its receiver before it ended",
                );
            }
        }
    };
    native_waits()
        .get_or_insert_with(HashMap::new)
        .entry(label.clone())
        .or_default()
        .insert(id, Box::new(send_end.clone()));
    // The watch ends when the wait returns, so the close of the connection ends no later wait.
    let _connection_watch = connection.watch(move || send_end(WAIT_END_CONNECTION));
    let forget = || {
        // default: a lock that a panicking thread poisoned still holds the sender of the wait, which the end takes; the
        // panic hook records the panic.
        ends.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(waits) = native_waits()
            .get_or_insert_with(HashMap::new)
            .get_mut(&label)
        {
            waits.remove(&id);
        }
    };
    let answer = tx;
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let started = main(Box::new(move || {
        let end = start(Box::new(move |value| {
            // The receiver waits for the answer, unless the wait failed before it.
            if answer.send(NativeEvent::Answer(value)).is_err() {
                crate::application_log::log_info(
                    "diagnostics",
                    "a native answer arrived after its request ended",
                );
            }
        }));
        // main returns after the work ran, so the receiver takes the end.
        if started_tx.send(end).is_err() {
            log_error(
                "diagnostics",
                "a native wait started after its request ended",
            );
        }
    }))
    .and_then(|()| {
        started_rx
            .recv()
            .map_err(|_| "the native wait did not start".to_string())?
    });
    let mut end = match started {
        Ok(end) => Some(end),
        Err(error) => {
            forget();
            return Err(internal(error));
        }
    };
    let mut reason = None;
    let value = loop {
        match rx.recv() {
            Ok(NativeEvent::Answer(value)) => break value,
            Ok(NativeEvent::End(ended)) => {
                if let Some(end) = end.take() {
                    reason = Some(ended);
                    // The library answers an ended wait before end returns, and a wait that answered keeps its answer.
                    if let Err(error) = main(Box::new(move || end(ended))) {
                        forget();
                        return Err(internal(error));
                    }
                }
            }
            Err(_) => {
                forget();
                return Err(internal("the native wait ended without an answer"));
            }
        }
    };
    forget();
    Ok((value, reason))
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
fn process_exit(
    window: &Window,
    params: &Map<String, Value>,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<Value, Failure> {
    let pid = platform::parse_process_id(params.get("pid")).map_err(Failure::params)?;
    let (exited, end) = await_native(window, connection, move |done| {
        let end = platform::current()?.when_process_exited(pid, done)?;
        Ok(Box::new(move |_| end()) as NativeEnd)
    })?;
    process_exit_answer(pid, exited, end)
}

/// The answer of diagnostics.process.exit to the answer of the library and the end of a wait that did not see the exit.
/// A wait that the library could not register answers without an end.
fn process_exit_answer(pid: i32, exited: bool, end: Option<&str>) -> Result<Value, Failure> {
    match (exited, end) {
        (true, _) => Ok(Value::Null),
        (false, None) => Err(internal(format!(
            "process {pid} exit wait could not be registered"
        ))),
        (false, Some(end)) => Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("process {pid} did not exit before {end}"),
        )),
    }
}

/// Takes one still image of the window without giving it focus, writes it to `<config-dir>/captures/still-*/window.png`
/// and returns the path. It is observation material that a person checks visually during development, and the requester
/// deletes the directory after checking.
fn capture_still(window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let held = window.clone();
    let numbers = on_main(window, move || platform.window_numbers(&held)).map_err(internal)?;
    if numbers.is_empty() {
        return Err(internal("the window has no window number"));
    }
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
    // The child windows of an open modal or settings window stand over the window, so the image holds them too.
    platform
        .capture_still(numbers[0], &path.to_string_lossy())
        .map_err(internal)?;
    Ok(json!({"path": path.to_string_lossy()}))
}

/// Writes a still capture of each window for the debug view and returns their paths (docs/spec/debug.md).
pub(crate) fn capture_windows(app: &crate::framework::AppHandle) -> Result<Vec<String>, String> {
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
        .filter(|value| {
            matches!(
                *value,
                "open" | "read" | "focus" | "wait-document" | "wait" | "close"
            )
        })
        .ok_or_else(|| {
            Failure::params(
                "input reference action must be open, read, focus, wait-document, wait or close",
            )
        })?;
    if action != "wait" && action != "wait-document" {
        if params.contains_key("document") {
            return Err(Failure::params(
                "input reference document is only for wait-document and wait",
            ));
        }
        return Ok((action.into(), None));
    }
    let document = params
        .get("document")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Failure::params("input reference wait-document and wait require a document string")
        })?;
    Ok((action.into(), Some(document.into())))
}

/// Acts on the input reference of window. A wait ends by its document, by the close of the reference or its window, or by the
/// connection or the page of the request, whose end the failure names.
fn input_reference(
    window: &Window,
    params: &Map<String, Value>,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<Value, Failure> {
    let (action, document) = parse_input_reference(params)?;
    let platform = platform::current().map_err(internal)?;
    let native = platform.window_handle(window).map_err(internal)?;
    let (result, _) = await_native(window, connection, move |done| {
        let done = std::cell::Cell::new(Some(done));
        platform.input_reference(
            native,
            &action,
            document.as_deref(),
            Box::new(move |result| {
                // The library calls the completion once.
                if let Some(done) = done.take() {
                    done(result);
                }
            }),
        );
        Ok(Box::new(move |reason| platform.end_input_reference_wait(native, reason)) as NativeEnd)
    })?;
    result.map_err(internal)
}

/// The input source roles that `select` of `diagnostics.input.source` takes (docs/spec/endpoint.md). The platform maps each role to
/// its input source; no identifier of a platform's input source is named here.
const INPUT_SOURCE_ROLES: [&str; 3] = ["latin", "korean", "japanese"];

/// The change of the selected input source that a `diagnostics.input.source` request asks for.
#[derive(Debug, PartialEq)]
enum InputSourceChange {
    /// Selects the input source of the role.
    Select(String),
    /// Selects the input source with this platform identifier, a `source` value of an earlier reply.
    Restore(String),
}

/// Reads the params of `diagnostics.input.source`: no change for a read of the current input source. A `select` that is not an
/// input source role, an empty `restore`, and a request with both are refused.
fn parse_input_source(params: &Map<String, Value>) -> Result<Option<InputSourceChange>, Failure> {
    let select = params.get("select").filter(|value| !value.is_null());
    let restore = params.get("restore").filter(|value| !value.is_null());
    match (select, restore) {
        (Some(_), Some(_)) => Err(Failure::params("select and restore exclude each other")),
        (Some(select), None) => match select.as_str() {
            Some(role) if INPUT_SOURCE_ROLES.contains(&role) => {
                Ok(Some(InputSourceChange::Select(role.to_string())))
            }
            _ => Err(Failure::params(
                "select must be one of latin, korean, japanese",
            )),
        },
        (None, Some(restore)) => match restore.as_str() {
            Some(source) if !source.is_empty() => {
                Ok(Some(InputSourceChange::Restore(source.to_string())))
            }
            _ => Err(Failure::params("restore must be a non-empty string")),
        },
        (None, None) => Ok(None),
    }
}

/// Performs `change` with `adopt` and replies `{current, source}` from `read`: the role of the selected input source, null for an
/// input source without a role, and its platform identifier.
fn answer_input_source(
    change: Option<InputSourceChange>,
    adopt: impl FnOnce(InputSourceChange) -> Result<(), String>,
    read: impl FnOnce() -> Result<(Option<String>, String), String>,
) -> Result<Value, Failure> {
    if let Some(change) = change {
        adopt(change).map_err(internal)?;
    }
    let (role, source) = read().map_err(internal)?;
    Ok(json!({"current": role, "source": source}))
}

fn input_source(
    window: &Window,
    params: Map<String, Value>,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<Value, Failure> {
    let change = parse_input_source(&params)?;
    let platform = platform::current().map_err(internal)?;
    answer_input_source(
        change,
        |change| {
            // The selection ends on the main thread when the active text context adopts the source, or by the connection,
            // the window or the page of the request, whose end the failure names.
            let (result, _) = await_native(window, connection, move |done| {
                let done = std::cell::Cell::new(Some(done));
                let adopted: Box<dyn Fn(Result<(), String>)> = Box::new(move |result| {
                    // The library calls the adoption once.
                    if let Some(done) = done.take() {
                        done(result);
                    }
                });
                let end = match change {
                    InputSourceChange::Select(role) => platform.select_input_source(&role, adopted),
                    InputSourceChange::Restore(source) => {
                        platform.restore_input_source(&source, adopted)
                    }
                };
                Ok(Box::new(end) as NativeEnd)
            })
            .map_err(|failure| failure.message)?;
            result
        },
        || on_main(window, move || platform.input_source()),
    )
}

/// Creates `<config-dir>/test-project` with an empty folder setting and requests the page to open only that project.
fn fixture(host: &Host, window: &Window, request: Map<String, Value>) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let root = window.state::<Workspace>().directory().join("test-project");
    let settings = root.join(".soksak");
    platform.private_directory(&settings).map_err(internal)?;
    // The project settings file is written in the current numbered form (docs/spec/installation.md#stored-data-formats).
    let format = crate::workspace::SETTINGS_FORMAT;
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
    if let Some(entries) = request.get("debugEntries") {
        if !entries.is_array() {
            return Err(Failure::params(
                "diagnostics.fixture debugEntries must be an array",
            ));
        }
        params.insert("debugEntries".into(), entries.clone());
    }
    exposure::parsed(&host.page(window, "diagnostics.fixture", params, None)?)
}

/// Requests the page to drag one boundary back and forth and sends the step times. It answers after the drag ends and
/// the window has drawn the result. When capture is set, it starts the window record before the drag and returns the
/// record directory.
struct DragCaptureOptions {
    capture: bool,
    plan: Plan,
}

fn parse_drag_capture_options(
    params: &mut Map<String, Value>,
) -> Result<DragCaptureOptions, Failure> {
    // capture is absent, null or false for a drag without a recording, or the plan of the recording, which
    // diagnostics.capture.start checks with the same messages; the page receives none of it.
    let (capture, plan) = match params.remove("capture") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => (false, Plan::default()),
        Some(Value::Object(plan)) => (true, parse_capture_plan(&plan)?),
        Some(_) => {
            return Err(Failure::params(
                "capture must be false or a plan {gap, seconds | frames}",
            ));
        }
    };
    Ok(DragCaptureOptions { capture, plan })
}

/// Reads native, which makes the host deliver the drag as native pointer input instead of the page
/// (docs/spec/endpoint.md), and removes it from the parameters of the page. It is false when absent.
fn parse_drag_native(params: &mut Map<String, Value>) -> Result<bool, Failure> {
    match params.remove("native") {
        None => Ok(false),
        Some(Value::Bool(native)) => Ok(native),
        Some(_) => Err(Failure::params("native must be a boolean")),
    }
}

/// The drag that the host delivers as native input: the offset of the boundary, the time of one leg in milliseconds and the
/// round trips.
struct NativeDragPlan {
    dx: f64,
    dy: f64,
    ms: f64,
    times: u64,
}

/// Delivers the drag of plan from the boundary point from as native input of the primary button, as a person drags: for
/// each round trip a press at from, the steps of each leg as a drag of the button at from plus the offset times the
/// fraction of the leg reached, out and back, and a release at from after the last step. Each leg runs until plan.ms
/// milliseconds have passed on clock, the clock of the host, so the position follows the time of the host and the steps
/// are the refreshes that the window presented. deliver delivers one input without activating the window or the
/// application, step(previous) returns at the host time of the next step, one display period after previous, the host time
/// of the step before it, and answers that time, and presented returns when the window has presented its
/// current layout; it runs before each press, because a press goes where the last frame drew. A failed input after a press
/// releases the button at the last point, so no press stays open in the window. The reply is {from, steps, took, asked,
/// pressWaits}: took is the time from the first press to the last release without the waits before the presses, asked the
/// time that the steps ask (times × 2 × ms), and pressWaits the wait before each press, all in milliseconds.
fn native_drag(
    plan: &NativeDragPlan,
    from: (f64, f64),
    clock: impl Fn() -> Duration,
    mut deliver: impl FnMut(platform::Pointer) -> Result<(), Failure>,
    mut step: impl FnMut(Duration) -> Result<Duration, Failure>,
    mut presented: impl FnMut() -> Result<(), Failure>,
) -> Result<Value, Failure> {
    let input = |phase: i32, (x, y): (f64, f64)| platform::Pointer {
        pointer: exposure::MAIN_POINTER.to_string(),
        x,
        y,
        phase,
        button: 0,
        delta_x: 0.0,
        delta_y: 0.0,
        clicks: 1,
        activate: false,
    };
    let at = |fraction: f64| (from.0 + plan.dx * fraction, from.1 + plan.dy * fraction);
    let span = plan.ms / 1000.0;
    let began = clock();
    let mut waited = Duration::ZERO;
    let mut press_waits = Vec::with_capacity(plan.times as usize);
    let mut steps: u64 = 0;
    for turn in 0..plan.times {
        let waiting = clock();
        presented().map_err(|error| {
            Failure::new(
                error.code,
                format!(
                    "native drag wait before the press of round trip {}: {}",
                    turn + 1,
                    error.message
                ),
            )
        })?;
        let wait = clock() - waiting;
        waited += wait;
        press_waits.push(wait.as_millis() as u64);
        deliver(input(1, from)).map_err(|error| {
            Failure::new(
                error.code,
                format!(
                    "native drag press of round trip {}: {}",
                    turn + 1,
                    error.message
                ),
            )
        })?;
        let mut last = from;
        for back in [false, true] {
            let leg_start = clock();
            // The period of a step runs from the time of the step before it, so the delivery of an input, which is inside
            // the period, does not lengthen the step (docs/spec/diagnostics.md).
            let mut previous = leg_start;
            loop {
                previous = match step(previous) {
                    Ok(taken) => taken,
                    Err(error) => {
                        let mut message =
                            format!("native drag step {}: {}", steps + 1, error.message);
                        if let Err(released) = deliver(input(3, last)) {
                            message = format!(
                                "{message}; release after the failed step: {}",
                                released.message
                            );
                        }
                        return Err(Failure::new(error.code, message));
                    }
                };
                steps += 1;
                let elapsed = (clock() - leg_start).as_secs_f64() / span;
                let reached = elapsed.min(1.0);
                last = at(if back { 1.0 - reached } else { reached });
                if let Err(error) = deliver(input(2, last)) {
                    let mut message = format!("native drag step {steps}: {}", error.message);
                    if let Err(released) = deliver(input(3, last)) {
                        message = format!(
                            "{message}; release after the failed step: {}",
                            released.message
                        );
                    }
                    return Err(Failure::new(error.code, message));
                }
                if elapsed >= 1.0 {
                    break;
                }
            }
        }
        deliver(input(3, from)).map_err(|error| {
            Failure::new(
                error.code,
                format!(
                    "native drag release of round trip {}: {}",
                    turn + 1,
                    error.message
                ),
            )
        })?;
    }
    Ok(json!({
        "from": {"x": from.0, "y": from.1},
        "steps": steps,
        "took": (clock() - began - waited).as_millis() as u64,
        "asked": ((plan.times * 2) as f64 * plan.ms).round() as u64,
        "pressWaits": press_waits,
    }))
}

/// Waits with sleep until one period after previous, the host time of the step before, and answers the host time of the
/// step: that time, or now when the delivery of the step before outlasted the period, so a late step does not bring the
/// steps after it closer than one period.
fn next_step(
    previous: Duration,
    period: Duration,
    now: Duration,
    sleep: impl FnOnce(Duration),
) -> Duration {
    let at = previous + period;
    if at <= now {
        return now;
    }
    sleep(at - now);
    at
}

/// The length of one step at refresh_rate, the refresh rate of the display that shows the window at the moment the step is
/// taken. A missing rate is an error: no step length is assumed.
fn step_period(refresh_rate: Option<u64>) -> Result<Duration, Failure> {
    match refresh_rate {
        Some(rate) if rate > 0 => Ok(Duration::from_nanos(1_000_000_000 / rate)),
        _ => Err(internal("the window is on no display with a refresh rate")),
    }
}

/// Reads the point of a boundary of a native drag after the window presented its current layout. A press goes where the
/// last frame drew, so a boundary that a change just made takes no press before it.
fn presented_boundary(
    presented: impl FnOnce() -> Result<f64, Failure>,
    boundary: impl FnOnce() -> Result<(f64, f64), Failure>,
) -> Result<(f64, f64), Failure> {
    presented()?;
    boundary()
}

/// Asks the page for the point of the boundary of the drag in window content coordinates.
fn drag_boundary(
    host: &Host,
    window: &Window,
    params: &Map<String, Value>,
) -> Result<(f64, f64), Failure> {
    let mut request = Map::new();
    request.insert("axis".into(), params["axis"].clone());
    request.insert("line".into(), params["line"].clone());
    let answer =
        exposure::parsed(&host.page(window, "diagnostics.drag.boundary", request, None)?)?;
    match (answer["x"].as_f64(), answer["y"].as_f64()) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err(internal(format!(
            "the page boundary of the drag is not {{x, y}}: {answer}"
        ))),
    }
}

fn drag(
    host: &Host,
    window: &Window,
    mut params: Map<String, Value>,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<Value, Failure> {
    if !matches!(params.get("axis").and_then(Value::as_str), Some("x" | "y")) {
        return Err(Failure::params("axis must be x or y"));
    }
    let capture_options = parse_drag_capture_options(&mut params)?;
    let native = parse_drag_native(&mut params)?;
    for name in ["line", "dx", "dy", "ms", "times"] {
        if !params.get(name).is_some_and(Value::is_number) {
            return Err(Failure::params(format!("{name} must be a number")));
        }
    }
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
    // With native, the page answers the point of the boundary, and the host delivers the drag as native input there.
    let from = if native {
        Some(presented_boundary(
            || exposure::presented(window, None),
            || drag_boundary(host, window, &params),
        )?)
    } else {
        None
    };

    // The recording of a drag is its log: a recording that does not start is told in the result (recorded_drag_result), and
    // the drag runs and answers without it.
    let mut capture_error: Option<String> = None;
    let frames = if capture_options.capture {
        match capture_start(window, connection, false, capture_options.plan) {
            Ok(started) => Some(started),
            Err(error) => {
                capture_error = Some(format!("the recording did not start: {}", error.message));
                None
            }
        }
    } else {
        None
    };

    exposure::note(
        window,
        &format!(
            "diagnostics: drag {}:{} by {},{} for {ms} ms, {times} times, native {native}",
            // default: only the log text is built. The page checks the axis and answers an invalid value as an error.
            params["axis"].as_str().unwrap_or_default(),
            params["line"],
            params["dx"],
            params["dy"]
        ),
    );
    let ticking = window.clone();
    // The layout trace and the time of each step are the record of every drag, on the clock of diagnostics.clock, so a check
    // judges the drag by them. A trace that does not start or end fails the drag.
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::<f64>::new()));
    let traced = (|| {
        let clock = platform::current().map_err(internal)?;
        let run = Arc::new(LayoutTraceRun { endpoint: false });
        start_layout_trace(&run, || {
            on_main(window, move || clock.layout_trace_start()).map_err(internal)
        })?;
        Ok::<_, Failure>((clock, run))
    })();
    let (clock, run) = match traced {
        Ok(traced) => traced,
        Err(error) => {
            if frames.is_some() {
                let cleanup = recorder(window, connection)
                    .and_then(|capture| RECORDING.abort(&capture).map_err(internal));
                if let Err(cleanup) = cleanup {
                    return Err(internal(format!(
                        "{}; abort capture: {}",
                        error.message, cleanup.message
                    )));
                }
            }
            return Err(error);
        }
    };
    let clock = Some(clock);
    let recorded = sent.clone();
    let result = match from {
        Some(from) => {
            let plan = NativeDragPlan {
                dx: params["dx"]
                    .as_f64()
                    .ok_or_else(|| Failure::params("dx must be a number"))?,
                dy: params["dy"]
                    .as_f64()
                    .ok_or_else(|| Failure::params("dy must be a number"))?,
                ms,
                times,
            };
            let start = Instant::now();
            native_drag(
                &plan,
                from,
                || start.elapsed(),
                |pointer| host.input_pointer(window, pointer).map(|_| ()),
                |previous| {
                    // The period is read from the display that shows the window at the moment of the step, so a window
                    // that moves between a 60 Hz and a 120 Hz display follows the display it is on.
                    let period =
                        step_period(exposure::window_refresh_rate(window).map_err(internal)?)?;
                    let taken = next_step(previous, period, start.elapsed(), std::thread::sleep);
                    if let Some(platform) = clock {
                        match (platform.capture_clock(), recorded.lock()) {
                            (Ok(now), Ok(mut ticks)) => ticks.push(now),
                            (Err(error), _) => log_error("drag tick clock", error),
                            (_, Err(error)) => log_error("drag tick clock", error),
                        }
                    }
                    Ok(taken)
                },
                || {
                    exposure::presented(window, None)?;
                    Ok(())
                },
            )
        }
        // The page discards the previous steps when it starts a drag, so the steps are sent after the request event.
        None => host
            .page_then(window, "diagnostics.drag", params, None, move || {
                tick(ticking, times, ms, clock, recorded)
            })
            .and_then(|result| exposure::parsed(&result)),
    };
    let (result, layouts) = stop_after_settled(
        || {
            let result = result?;
            // Waits until the last placement is committed and presented. Waiting for one next presentation could end
            // at a presentation before the commit of the last step.
            exposure::window_presented(host, window, None)?;
            exposure::note(window, "diagnostics: drag presented");
            Ok(result)
        },
        || {
            stop_layout_trace(&run, || {
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.layout_trace_stop()).map_err(internal)
            })
        },
    );
    let finished = (|| -> Result<Value, Failure> {
        let (result, layouts) = match (result, layouts) {
            (Ok(result), Ok(layouts)) => (result, layout_trace(&layouts)),
            (Err(error), Ok(_)) | (Ok(_), Err(error)) => return Err(error),
            (Err(error), Err(trace)) => {
                return Err(internal(format!(
                    "{}; layout trace: {}",
                    error.message, trace.message
                )));
            }
        };
        let merged = match result {
            Value::Object(fields) => fields,
            Value::Null => Map::new(),
            _ => return Err(internal("the page drag result is not an object")),
        };
        // default: a lock that a panicking thread poisoned still holds the pointer ticks of the drag, which are
        // only read; the panic hook records the panic.
        let ticks = sent.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let recording = frames.as_ref().map(|(frames, recorded)| DragRecording {
            frames: frames.to_string_lossy().into_owned(),
            window: json!(recorded),
        });
        Ok(Value::Object(recorded_drag_result(
            merged,
            ticks,
            layouts,
            recording,
            capture_error.take(),
        )))
    })();
    // When the requester cannot receive the frame folder, the recording is stopped and the folder is deleted.
    if let Err(error) = finished {
        if frames.is_some() {
            let cleanup = recorder(window, connection)
                .and_then(|capture| RECORDING.abort(&capture).map_err(internal));
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

/// The recording of a drag that started: its frame folder and its recorded window.
struct DragRecording {
    frames: String,
    window: Value,
}

/// Adds to the result of a drag the time of each step, its layout trace and its recording: a recording that started adds frames
/// and window, and captureError tells what failed of the recording. The recording is the log of the drag, so the drag does not
/// fail on it.
fn recorded_drag_result(
    mut result: Map<String, Value>,
    ticks: Vec<f64>,
    layouts: Value,
    recording: Option<DragRecording>,
    capture_error: Option<String>,
) -> Map<String, Value> {
    result.insert("ticks".into(), json!(ticks));
    result.insert("layouts".into(), layouts);
    if let Some(recording) = recording {
        result.insert("frames".into(), Value::String(recording.frames));
        result.insert("window".into(), recording.window);
    }
    if let Some(error) = capture_error {
        result.insert("captureError".into(), Value::String(error));
    }
    result
}

/// One run of the layout trace of the host. The native layout trace records the transactions of the application and a start
/// discards what it recorded, so one run holds it at a time: a drag, or diagnostics.layout.trace, whose run is an endpoint run
/// and ends also with the close of the endpoint connection that started it.
struct LayoutTraceRun {
    endpoint: bool,
}

/// The run that holds the layout trace, none when no trace runs.
static LAYOUT_TRACE: Mutex<Option<Arc<LayoutTraceRun>>> = Mutex::new(None);

fn held_layout_trace() -> MutexGuard<'static, Option<Arc<LayoutTraceRun>>> {
    // default: a lock that a panicking thread poisoned still names the run that holds the trace; the panic hook records the
    // panic.
    LAYOUT_TRACE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Starts the layout trace for run with start; it fails while another run holds the trace.
fn start_layout_trace(
    run: &Arc<LayoutTraceRun>,
    start: impl FnOnce() -> Result<(), Failure>,
) -> Result<(), Failure> {
    let mut held = held_layout_trace();
    if held.is_some() {
        return Err(internal("the layout trace is already running"));
    }
    start()?;
    *held = Some(run.clone());
    Ok(())
}

/// Stops the layout trace of run with stop and returns its records; it fails when run does not hold the trace.
fn stop_layout_trace<T>(
    run: &Arc<LayoutTraceRun>,
    stop: impl FnOnce() -> Result<T, Failure>,
) -> Result<T, Failure> {
    let mut held = held_layout_trace();
    if !held.as_ref().is_some_and(|holder| Arc::ptr_eq(holder, run)) {
        return Err(internal("no layout trace is running"));
    }
    *held = None;
    stop()
}

/// Starts the layout trace with on set, and with on unset stops the trace that it started and answers {layouts}, the layout
/// transactions recorded since its start on the clock of diagnostics.clock in milliseconds. The trace also ends with the close
/// of the endpoint connection that started it (docs/spec/endpoint.md).
fn layout_trace_request(
    window: &Window,
    params: &Map<String, Value>,
    connection: &crate::endpoint::ConnectionEnd,
) -> Result<Value, Failure> {
    let on = params
        .get("on")
        .and_then(Value::as_bool)
        .ok_or_else(|| Failure::params("on must be a boolean"))?;
    let stop = |window: Window| {
        move || {
            let platform = platform::current().map_err(internal)?;
            on_main(&window, move || platform.layout_trace_stop()).map_err(internal)
        }
    };
    if !on {
        let run = held_layout_trace()
            .clone()
            .filter(|run| run.endpoint)
            .ok_or_else(|| internal("no layout trace of diagnostics.layout.trace is running"))?;
        let records = stop_layout_trace(&run, stop(window.clone()))?;
        return Ok(json!({"layouts": layout_trace(&records)}));
    }
    let run = Arc::new(LayoutTraceRun { endpoint: true });
    start_layout_trace(&run, || {
        let platform = platform::current().map_err(internal)?;
        on_main(window, move || platform.layout_trace_start()).map_err(internal)
    })?;
    let ended = window.clone();
    connection.on_close(move || {
        if stop_layout_trace(&run, stop(ended.clone())).is_ok() {
            exposure::note(
                &ended,
                "diagnostics: the layout trace ended with its endpoint connection",
            );
        }
    });
    Ok(Value::Null)
}

/// Runs settle, which waits until the last placement of a drag is committed and presented, and then stop, which ends the
/// layout trace, so that the trace holds the presentation of the last placement. stop runs also when settle fails.
fn stop_after_settled<T, L>(
    settle: impl FnOnce() -> Result<T, Failure>,
    stop: impl FnOnce() -> Result<L, Failure>,
) -> (Result<T, Failure>, Result<L, Failure>) {
    let settled = settle();
    (settled, stop())
}

/// Sends the steps of the 2 × times one-way legs of a drag of ms milliseconds to the page as diagnostics-tick events. Each
/// leg runs until ms has passed on the clock of the drag. Each step comes one display period after the one before, the
/// period the window has at the moment of the step, so the length of a step follows the display the window is on. A failed
/// read sends one error tick and ends the drag.
fn tick(
    window: Window,
    times: u64,
    ms: f64,
    clock: Option<&'static dyn platform::Platform>,
    sent: std::sync::Arc<std::sync::Mutex<Vec<f64>>>,
) {
    crate::routine::spawn_named("diagnostics-ticks", move || {
        let began = Instant::now();
        send_legs(
            times,
            ms,
            || exposure::window_refresh_rate(&window),
            std::thread::sleep,
            || began.elapsed(),
            |step| {
                let payload = match step {
                    Ok((fraction, last)) => {
                        if let Some(platform) = clock {
                            match (platform.capture_clock(), sent.lock()) {
                                (Ok(now), Ok(mut ticks)) => ticks.push(now),
                                (Err(error), _) => log_error("drag tick clock", error),
                                (_, Err(error)) => log_error("drag tick clock", error),
                            }
                        }
                        json!({"fraction": fraction, "last": last})
                    }
                    Err(message) => json!({"error": message}),
                };
                match window.emit("diagnostics-tick", payload) {
                    Ok(()) => true,
                    Err(error) => {
                        log_error("diagnostics-tick", error);
                        false
                    }
                }
            },
        );
    });
}

/// Runs the legs of a drag of times round trips of ms milliseconds on clock. Each step waits one display period, the period
/// of the window at the moment of the step, then calls send with its fraction and whether it ends the leg; a failed read
/// calls send with the error and ends the drag. send returns false when the window can no longer receive, which ends the run.
fn send_legs(
    times: u64,
    ms: f64,
    mut refresh_rate: impl FnMut() -> Result<Option<u64>, String>,
    mut wait: impl FnMut(Duration),
    clock: impl Fn() -> Duration,
    mut send: impl FnMut(Result<(f64, bool), String>) -> bool,
) {
    let span = ms / 1000.0;
    for _ in 0..2 * times {
        let began = clock();
        loop {
            let period = match refresh_rate()
                .and_then(|rate| step_period(rate).map_err(|error| error.message))
            {
                Ok(period) => period,
                Err(message) => {
                    send(Err(message));
                    return;
                }
            };
            wait(period);
            let elapsed = (clock() - began).as_secs_f64();
            let last = elapsed >= span;
            let fraction = if last { 1.0 } else { elapsed / span };
            if !send(Ok((fraction, last))) {
                return;
            }
            if last {
                break;
            }
        }
    }
}

/// Holds the next new window of the application and answers with the frame directory once the hold is set; the recording
/// of that window starts when the application shows it (`Recording::start_new_window`).
fn capture_start_new_window(
    window: &Window,
    connection: &crate::endpoint::ConnectionEnd,
    plan: Plan,
) -> Result<PathBuf, Failure> {
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
            "{stamp}-new-{}",
            CAPTURES.fetch_add(1, Ordering::Relaxed)
        ));
    let recorder = Arc::new(recorder(window, connection)?);
    let platform = recorder.platform;
    RECORDING
        .start_new_window(recorder, &directory, plan, &|path| {
            platform.private_directory(path)
        })
        .map_err(internal)?;
    Ok(directory)
}

/// Starts the window recording of plan and returns the record directory once still 0 is written. When display is set, it
/// records the windows of this application on the display that holds the window.
fn capture_start(
    window: &Window,
    connection: &crate::endpoint::ConnectionEnd,
    display: bool,
    plan: Plan,
) -> Result<(PathBuf, Option<isize>), Failure> {
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
    let recorder = recorder(window, connection)?;
    RECORDING
        .start(
            &recorder,
            Target {
                window: number,
                display,
            },
            &directory,
            plan,
            &|path| recorder.platform.private_directory(path),
        )
        .map_err(internal)?;
    // A display recording records every window of the application on the display, so it has no window of its own.
    Ok((directory, (!display).then_some(number)))
}

/// Records until a still requested at or after after has completed, ends the recording in progress and returns the
/// directory, the record of the stills and the number of frames.
fn capture_stop(
    window: &Window,
    connection: &crate::endpoint::ConnectionEnd,
    after: f64,
) -> Result<Value, Failure> {
    let recorder = PlatformCapture {
        after,
        ..recorder(window, connection)?
    };
    let (directory, count, recorded_window) = RECORDING
        .finish(&recorder)
        .map_err(|error| internal(format!("stop capture: {error}")))?;
    let stills = StillCounts {
        missed: recorder.platform.capture_missed().map_err(internal)?,
        late: recorder.platform.capture_late().map_err(internal)?,
        longest_gap: recorder.platform.capture_longest_gap().map_err(internal)?,
    };
    Ok(crate::recording::stop_payload(
        &directory,
        count,
        stills,
        recorded_window,
    ))
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
/// holding. A hold also ends when its window closes or when the endpoint connection that turned it on closes
/// (docs/spec/endpoint.md).
fn modal_hold(window: &str, on: bool, connection: &crate::endpoint::ConnectionEnd) {
    if !on {
        end_modal_hold(window, None);
        return;
    }
    let hold = {
        // default: a lock that a panicking thread poisoned still holds the held modal replies, which the call amends; the
        // panic hook records the panic.
        let mut holds = MODAL_HOLDS.lock().unwrap_or_else(PoisonError::into_inner);
        let holds = holds.get_or_insert_with(HashMap::new);
        if holds.contains_key(window) {
            return;
        }
        let hold = Arc::new(ModalHold::default());
        holds.insert(window.to_string(), hold.clone());
        hold
    };
    let window = window.to_string();
    connection.on_close(move || end_modal_hold(&window, Some(&hold)));
}

/// Ends the modal content hold of window, or only the hold only when it is still the hold of window: the held replies are
/// sent and diagnostics.modal.held answers.
fn end_modal_hold(window: &str, only: Option<&Arc<ModalHold>>) {
    let hold = {
        // default: a lock that a panicking thread poisoned still holds the held modal replies, which the end amends; the
        // panic hook records the panic.
        let mut holds = MODAL_HOLDS.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(holds) = holds.as_mut() else {
            return;
        };
        match (holds.get(window), only) {
            (Some(current), Some(only)) if !Arc::ptr_eq(current, only) => return,
            (None, _) => return,
            _ => {}
        }
        holds.remove(window)
    };
    if let Some(hold) = hold {
        // default: a lock that a panicking thread poisoned still holds the held reply count, which the release amends;
        // the panic hook records the panic.
        hold.state.lock().unwrap_or_else(PoisonError::into_inner).0 = true;
        hold.changed.notify_all();
    }
}

/// The connection that asked for the latest reply hold of each surface, by window and surface.
type SurfaceHolds = HashMap<(String, String), crate::endpoint::ConnectionEnd>;

static SURFACE_HOLDS: Mutex<Option<SurfaceHolds>> = Mutex::new(None);

/// Remembers that connection asked for the reply hold of surface in window. When connection closes, release runs unless a
/// later hold of the surface took it or the window closed (docs/spec/endpoint.md).
fn remember_surface_hold(
    window: &str,
    surface: &str,
    connection: &crate::endpoint::ConnectionEnd,
    release: impl FnOnce() + Send + 'static,
) {
    let key = (window.to_string(), surface.to_string());
    SURFACE_HOLDS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the surface holds, which the call amends; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(key.clone(), connection.clone());
    let asked = connection.clone();
    connection.on_close(move || {
        let latest = {
            // default: a lock that a panicking thread poisoned still holds the surface holds, which the release amends;
            // the panic hook records the panic.
            let mut holds = SURFACE_HOLDS.lock().unwrap_or_else(PoisonError::into_inner);
            let holds = holds.get_or_insert_with(HashMap::new);
            let latest = holds.get(&key).is_some_and(|current| current.is(&asked));
            if latest {
                holds.remove(&key);
            }
            latest
        };
        if latest {
            release();
        }
    });
}

/// Ends the diagnostic holds of window when it closes: its modal content hold ends, and its surface holds are forgotten,
/// since the page that held them ends with the window.
pub(crate) fn end_window_holds(window: &str) {
    end_native_waits(window, WAIT_END_WINDOW);
    end_modal_hold(window, None);
    if let Some(holds) = SURFACE_HOLDS
        .lock()
        // default: a lock that a panicking thread poisoned still holds the surface holds, which the close amends; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .as_mut()
    {
        holds.retain(|(held, _), _| held != window);
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
    // The library answers once on every path, so the host waits for the list without a limit of its own.
    let list = rx
        .recv()
        .map_err(|_| internal("the delivered notifications ended before they answered"))?;
    serde_json::from_str(&list)
        .map_err(|error| internal(format!("delivered notifications {list:?}: {error}")))
}

fn modal_held(window: &str) -> Result<Value, Failure> {
    let hold = modal_held_hold(window)?;
    await_modal_held(&hold);
    Ok(Value::Null)
}

/// Reads the hold of window when diagnostics.modal.held arrives; it fails when the window does not hold answers.
fn modal_held_hold(window: &str) -> Result<Arc<ModalHold>, Failure> {
    modal_hold_of(window)
        .ok_or_else(|| internal("modal content answers are not held in this window"))
}

/// Returns when the window of hold holds a modal content answer or the hold ends.
fn await_modal_held(hold: &ModalHold) {
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
}

#[cfg(test)]
#[path = "diagnostics_lock_test.rs"]
mod lock_test;

#[cfg(test)]
#[path = "diagnostics_input_reference_test.rs"]
mod input_reference_test;

#[cfg(test)]
#[path = "diagnostics_input_source_test.rs"]
mod input_source_test;

#[cfg(test)]
mod capture_start_options_test {
    use super::*;

    fn parse(value: Value) -> Result<CaptureStartOptions, Failure> {
        parse_capture_start_options(value.as_object().unwrap())
    }

    // contract: diagnostics.capture-start.preserves-display-option-parsing
    #[test]
    fn capture_start_options_preserve_display_parsing() {
        for (json, expected) in [
            (json!({"gap": 8, "frames": 10}), false),
            (json!({"gap": 8, "frames": 10, "display": false}), false),
            (json!({"gap": 8, "frames": 10, "display": true}), true),
            (json!({"gap": 8, "frames": 10, "display": null}), false),
        ] {
            let got = parse(json.clone()).unwrap();
            assert_eq!(got.display, expected, "params {json}");
        }
        for value in [json!("true"), json!(1), json!([]), json!({})] {
            let params = json!({"gap": 8, "frames": 10, "display": value});
            assert!(parse(params.clone()).is_err(), "params {params}");
        }
    }

    // contract: diagnostics.capture-start.validates-still-plan
    #[test]
    fn the_plan_of_a_recording_takes_gap_and_seconds_or_frames() {
        for (params, expected) in [
            (
                json!({"gap": 8.333, "seconds": 2}),
                Plan {
                    gap: 8.333,
                    seconds: 2.0,
                    frames: 0,
                },
            ),
            (
                json!({"gap": 1, "frames": 4096}),
                Plan {
                    gap: 1.0,
                    seconds: 0.0,
                    frames: 4096,
                },
            ),
            (
                json!({"gap": 1000, "seconds": 600}),
                Plan {
                    gap: 1000.0,
                    seconds: 600.0,
                    frames: 0,
                },
            ),
            (
                json!({"gap": 146.484375, "seconds": 600}),
                Plan {
                    gap: 146.484375,
                    seconds: 600.0,
                    frames: 0,
                },
            ),
            (
                json!({"gap": 10, "frames": 1, "seconds": null}),
                Plan {
                    gap: 10.0,
                    seconds: 0.0,
                    frames: 1,
                },
            ),
        ] {
            assert_eq!(
                parse(params.clone()).unwrap().plan,
                expected,
                "params {params}"
            );
        }
        for (params, expected) in [
            (
                json!({"frames": 10}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
            (
                json!({"gap": null, "frames": 10}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
            (
                json!({"gap": "8", "frames": 10}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
            (
                json!({"gap": 0.5, "frames": 10}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
            (
                json!({"gap": 1000.5, "frames": 10}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
            (
                json!({"gap": 8, "seconds": 1, "frames": 10}),
                "give seconds or frames, not both",
            ),
            (json!({"gap": 8}), "a recording needs seconds or frames"),
            (
                json!({"gap": 8, "seconds": 0}),
                "seconds must be above 0 and at most 600",
            ),
            (
                json!({"gap": 8, "seconds": 600.5}),
                "seconds must be above 0 and at most 600",
            ),
            (
                json!({"gap": 8, "seconds": "1"}),
                "seconds must be above 0 and at most 600",
            ),
            (
                json!({"gap": 8, "frames": 0}),
                "frames must be an integer from 1 to 4096",
            ),
            (
                json!({"gap": 8, "frames": 4097}),
                "frames must be an integer from 1 to 4096",
            ),
            (
                json!({"gap": 8, "frames": 2.5}),
                "frames must be an integer from 1 to 4096",
            ),
            (
                json!({"gap": 8, "seconds": 40}),
                "the recording plans 5000 stills, more than 4096",
            ),
            (
                json!({"gap": 146, "seconds": 600}),
                "the recording plans 4110 stills, more than 4096",
            ),
            // The plan is checked before newWindow holds a window.
            (
                json!({"newWindow": true}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
        ] {
            assert_eq!(
                parse(params.clone()).map(|_| ()).unwrap_err().message,
                expected,
                "params {params}"
            );
        }
    }
}

#[cfg(test)]
mod drag_capture_options_test {
    use super::*;

    fn parse(value: Value) -> Result<DragCaptureOptions, Failure> {
        let mut params = value.as_object().unwrap().clone();
        parse_drag_capture_options(&mut params)
    }

    // contract: diagnostics.drag.takes-a-capture-plan
    #[test]
    fn drag_capture_takes_a_plan() {
        let none = Plan::default();
        for (params, capture, plan) in [
            (json!({}), false, none),
            (json!({"capture": null}), false, none),
            (json!({"capture": false}), false, none),
            (
                json!({"capture": {"gap": 8.333, "frames": 4096}}),
                true,
                Plan {
                    gap: 8.333,
                    seconds: 0.0,
                    frames: 4096,
                },
            ),
            (
                json!({"capture": {"gap": 10, "seconds": 2}}),
                true,
                Plan {
                    gap: 10.0,
                    seconds: 2.0,
                    frames: 0,
                },
            ),
            // A plan at the top level of the drag is not a plan of its recording.
            (json!({"gap": 8, "frames": 10}), false, none),
        ] {
            let options = parse(params.clone()).unwrap();
            assert_eq!(
                (options.capture, options.plan),
                (capture, plan),
                "params {params}"
            );
        }
        for (params, expected) in [
            (
                json!({"capture": true}),
                "capture must be false or a plan {gap, seconds | frames}",
            ),
            (
                json!({"capture": "yes"}),
                "capture must be false or a plan {gap, seconds | frames}",
            ),
            (
                json!({"capture": 1}),
                "capture must be false or a plan {gap, seconds | frames}",
            ),
            (
                json!({"capture": []}),
                "capture must be false or a plan {gap, seconds | frames}",
            ),
            (
                json!({"capture": true, "gap": 8, "frames": 10}),
                "capture must be false or a plan {gap, seconds | frames}",
            ),
            (
                json!({"capture": {}}),
                "gap must be a number of milliseconds from 1 to 1000",
            ),
            (
                json!({"capture": {"gap": 8, "seconds": 1, "frames": 10}}),
                "give seconds or frames, not both",
            ),
            (
                json!({"capture": {"gap": 8}}),
                "a recording needs seconds or frames",
            ),
            (
                json!({"capture": {"gap": 8, "seconds": 601}}),
                "seconds must be above 0 and at most 600",
            ),
            (
                json!({"capture": {"gap": 8, "frames": 4097}}),
                "frames must be an integer from 1 to 4096",
            ),
            (
                json!({"capture": {"gap": 8, "seconds": 40}}),
                "the recording plans 5000 stills, more than 4096",
            ),
        ] {
            let error = match parse(params.clone()) {
                Ok(_) => panic!("params {params} unexpectedly parsed"),
                Err(error) => error,
            };
            assert_eq!(error.message, expected, "params {params}");
        }
        // The page does not receive capture.
        let mut params = json!({"capture": {"gap": 8, "seconds": 2}, "line": 1})
            .as_object()
            .unwrap()
            .clone();
        parse_drag_capture_options(&mut params).unwrap();
        assert_eq!(Value::Object(params), json!({"line": 1}));
    }
}

#[cfg(test)]
mod document_viewport_marker_test {
    use super::*;

    fn params(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn request(enabled: bool) -> DocumentViewportMarkerRequest {
        DocumentViewportMarkerRequest {
            surface: "surface-a".into(),
            document: "page".into(),
            enabled,
        }
    }

    fn marker(enabled: bool) -> DocumentViewportMarker {
        DocumentViewportMarker {
            enabled,
            color: [0, 255, 255],
            border_width_pt: 2.0,
        }
    }

    // contract: diagnostics.document.viewport-marker.requires-valid-parameters
    #[test]
    fn document_viewport_marker_requires_nonempty_names_and_a_boolean() {
        for (value, expected) in [
            (
                json!({"surface":"surface-a","document":"page","enabled":true}),
                true,
            ),
            (
                json!({"surface":"surface-a","document":"page","enabled":false}),
                false,
            ),
        ] {
            assert_eq!(
                parse_document_viewport_marker_request(&params(value))
                    .unwrap()
                    .enabled,
                expected
            );
        }
        for value in [
            json!({"document":"page","enabled":true}),
            json!({"surface":"","document":"page","enabled":true}),
            json!({"surface":"surface-a","document":"","enabled":true}),
            json!({"surface":"surface-a","document":"page"}),
            json!({"surface":"surface-a","document":"page","enabled":null}),
            json!({"surface":"surface-a","document":"page","enabled":"true"}),
        ] {
            assert!(
                parse_document_viewport_marker_request(&params(value.clone())).is_err(),
                "invalid params unexpectedly parsed: {value}"
            );
        }
    }

    // contract: diagnostics.document.viewport-marker.uses-the-owning-window-document
    #[test]
    fn document_viewport_marker_resolves_only_attached_documents_in_the_window() {
        let owner = Documents::default();
        let other_window = Documents::default();
        let key = ("surface-a".into(), "page".into());
        owner.reserve(&key).unwrap();
        assert!(owner.set(&key, 23));
        assert_eq!(
            resolve_document_viewport_marker_handle(&owner, &request(true)).unwrap(),
            Some(23)
        );
        assert!(resolve_document_viewport_marker_handle(&other_window, &request(true)).is_err());
        assert_eq!(
            resolve_document_viewport_marker_handle(&other_window, &request(false)).unwrap(),
            None,
            "stopping after the region was removed must be idempotent"
        );
        let wrong_surface = DocumentViewportMarkerRequest {
            surface: "surface-b".into(),
            ..request(true)
        };
        assert!(resolve_document_viewport_marker_handle(&owner, &wrong_surface).is_err());
    }

    // contract: diagnostics.document.viewport-marker.schedules-native-work-and-returns-native-result
    #[test]
    fn document_viewport_marker_runs_through_ui_dispatch_and_preserves_native_result() {
        let mut scheduled_on_ui = false;
        let result = dispatch_document_viewport_marker(
            request(true),
            |work| {
                scheduled_on_ui = true;
                work()
            },
            |request| {
                assert_eq!(request, super::document_viewport_marker_test::request(true));
                Ok(marker(request.enabled))
            },
        )
        .unwrap();
        assert!(
            scheduled_on_ui,
            "native marker work bypassed the UI dispatcher"
        );
        assert_eq!(
            result,
            json!({
                "enabled": true,
                "kind": "native",
                "markerColor": [0, 255, 255],
                "borderWidthPt": 2.0,
            })
        );
    }

    // contract: diagnostics.document.viewport-marker.reports-native-errors
    #[test]
    fn document_viewport_marker_returns_native_errors() {
        let error = dispatch_document_viewport_marker(
            request(false),
            |work| work(),
            |_| Err("native marker failure".into()),
        )
        .unwrap_err();
        assert_eq!(error.code, -32603);
        assert_eq!(error.message, "native marker failure");
    }
}

#[cfg(test)]
#[path = "diagnostics_test.rs"]
mod capture_stop_test;

#[cfg(test)]
#[path = "diagnostics_new_window_test.rs"]
mod new_window_test;
