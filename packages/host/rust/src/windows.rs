//! Project windows, the window registry, ready/close/exit, window state and window buttons.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};

use crate::framework::Channel;
use crate::framework::Color;
use crate::framework::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Webview, Window, WindowEvent, WindowOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::application_log::{log_error, log_failure};
use crate::modals::Overlay;
use crate::platform::{self, Handle};
use crate::projects::project_folder;
use crate::shapes::Shapes;
use crate::sidecars::WindowSidecars;
use crate::source_origins::{ViewSourceOrigins, view_source_origin_event};
use crate::surfaces::{Rect, Running, SurfaceComposition, Views, Watching};
use crate::theme::CurrentTheme;

/// The end of a reload that its new page did not report ready to: an end of the window or of its main page process, named
/// by the end (`WindowData::end_waits`), or a start of the new page that failed, with its error.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ReloadEnd {
    Ended(String),
    NotStarted(String),
}

/// A reload that waits for the next page of its window: the number of the reload and the sender of its end.
pub(crate) type Readied = (u64, mpsc::Sender<Result<(), ReloadEnd>>);

/// The state of one window.
#[derive(Default)]
pub struct WindowData {
    pub(crate) overlay: Overlay,
    pub(crate) shapes: Shapes,
    pub(crate) theme: CurrentTheme,
    pub(crate) views: Views,
    /// The handle of the logical SurfaceHost. It is a native host below the main WebView and not a DOM WebView.
    pub surface_hosts: Mutex<HashMap<String, Handle>>,
    pub(crate) watching: Watching,
    pub(crate) running: Running,
    pub root: Mutex<String>,
    pub ready: AtomicBool,
    /// Set when the host asked the ready page to reload, until the new page starts. The page no longer
    /// answers the calls of the surface documents in that time (docs/spec/native-host.md#page-reload).
    pub page_reloading: AtomicBool,
    /// The first responder that the page last received (window-responder). The lock also orders the reads and sends, so
    /// a later change is never sent before an earlier one.
    pub responder: Mutex<Option<serde_json::Value>>,
    /// The windows that received a close request that was not blocked. These windows disappear from the runtime before
    /// Destroyed, so they are not put in the list.
    pub closing: AtomicBool,
    /// The reloads that wait for the next page: the ready of the page sends `Ok`, and the close of the window, the end of
    /// its page process and a start of the new page that fails send the end of the reload.
    pub(crate) readied: Mutex<Vec<Readied>>,
    /// The ends of the window and of its main page process, which end the requests that wait in the window.
    pub(crate) ends: WindowEnds,
    /// The ends of the generations of the main page, which end the waits of the host calls that the page sent: the page reads
    /// again only after each of them has its reply (docs/spec/native-host.md#page-reload).
    pub(crate) page_calls: PageCallEnds,
    /// The settled frame waits of the window that wait for their native answer.
    pub(crate) frame_waits: FrameWaits,
    /// Set when the window asked its page with `project-close-request` and the page has answered neither `windowClose` nor
    /// `windowCloseKept`, so the end of the page answers it (`answer_close_question`).
    pub close_asked: AtomicBool,
    /// The items (surface, kind, name) that surface pages registered. When the main page is reloaded, the new page is
    /// notified again.
    pub registrations: Mutex<Vec<(String, String, String)>>,
    /// The document regions of surface pages.
    pub documents: crate::documents::Documents,
    /// The stream subscriptions of the document regions.
    pub streams: crate::documents::Streams,
    /// The image regions of surface pages.
    pub images: crate::images::Images,
    /// Orders the drawing messages to the suppliers of image regions (composition::send_image_drawing).
    pub drawing: Mutex<()>,
    /// The current view-source incarnations and the greatest generation issued in this window.
    pub view_source_origins: ViewSourceOrigins,
    /// The receivers of the sidecar messages of each pair of a sidecar and a session id (docs/spec/native-surfaces.md#view-surfaces).
    pub sidecar_routes: crate::sidecar_routes::SidecarRoutes,
    /// The ordered source events of the current main-page document.
    pub(crate) view_source_events: ViewSourceEventStream,
    /// The surface composition that the main page declared and that the host uses to check the authority of region
    /// calls.
    pub compositions: Mutex<HashMap<String, SurfaceComposition>>,
    /// The plugin of each surface that declared its composition; its document regions serve that plugin's package.
    pub surface_plugins: Mutex<HashMap<String, String>>,
    /// The folder root of each project that the window holds, by project id.
    pub projects: Mutex<HashMap<String, String>>,
    /// Project ownership reservations that the page has not committed through `project_shown`.
    pub staged_projects: Mutex<HashSet<String>>,
    /// The project that the window shows, empty when it shows none. A release of the
    /// shown project clears it, and the root, at once.
    pub shown: Mutex<String>,
    /// The complete composition revision applied last for each surface.
    pub composition_revisions: Mutex<HashMap<String, u64>>,
}

/// The ends of a window and of its main page process, counted: a request that waits in the window takes the count when it
/// begins and reads the end that came after it, so an end that comes before the wait reads it ends the wait the same way.
#[derive(Default)]
pub(crate) struct WindowEnds(Mutex<(u64, String)>);

impl WindowEnds {
    /// The count of the ends so far.
    pub(crate) fn mark(&self) -> u64 {
        // default: a lock that a panicking thread poisoned still holds the count, which is only read; the panic hook records
        // the panic.
        self.0.lock().unwrap_or_else(PoisonError::into_inner).0
    }

    /// The text of the last end after the count mark, or None when no end came after it.
    pub(crate) fn since(&self, mark: u64) -> Option<String> {
        // default: a lock that a panicking thread poisoned still holds the count and the text, which are only read; the
        // panic hook records the panic.
        let ends = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        (ends.0 > mark).then(|| ends.1.clone())
    }

    fn record(&self, end: &str) {
        // default: a lock that a panicking thread poisoned still holds the count and the text, which this call replaces; the
        // panic hook records the panic.
        let mut ends = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        ends.0 += 1;
        ends.1 = end.to_string();
    }
}

/// The end of the waits of the host calls of a page that the reload request sends (docs/spec/native-host.md#page-reload).
pub(crate) const PAGE_RELOADING_END: &str = "the page is reloading";
/// The end of the waits of the host calls of a page that the start of a new page sends.
pub(crate) const PAGE_REPLACED_END: &str = "a new page started";

/// The ends of the generations of the main page of a window, counted as `WindowEnds` counts the ends of the window, and the end
/// that holds until the next page starts, which a wait of a host call that begins after it meets at once.
#[derive(Default)]
pub(crate) struct PageCallEnds(Mutex<PageCallEnd>);

#[derive(Default)]
struct PageCallEnd {
    count: u64,
    last: String,
    holds: bool,
}

impl PageCallEnds {
    fn lock(&self) -> std::sync::MutexGuard<'_, PageCallEnd> {
        // default: a lock that a panicking thread poisoned still holds the count and the texts, which are only read or
        // replaced; the panic hook records the panic.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The count of the ends so far.
    pub(crate) fn mark(&self) -> u64 {
        self.lock().count
    }

    /// The text of the last end after the count mark, or None when no end came after it.
    pub(crate) fn since(&self, mark: u64) -> Option<String> {
        let ends = self.lock();
        (ends.count > mark).then(|| ends.last.clone())
    }

    /// The end that holds until the next page starts, or None.
    pub(crate) fn holding(&self) -> Option<String> {
        let ends = self.lock();
        ends.holds.then(|| ends.last.clone())
    }

    fn record(&self, end: &str) {
        let mut ends = self.lock();
        ends.count += 1;
        ends.last = end.to_string();
        ends.holds = true;
    }

    fn release(&self) {
        self.lock().holds = false;
    }
}

/// What a settled frame wait receives: the answer of the platform, or an end of the window, of its page process or, for a wait
/// of a host call of the page, of the generation of the page.
pub(crate) enum FrameOutcome {
    Displayed(Result<f64, String>),
    Ended(String),
}

/// The settled frame waits of a window that wait for the answer of the platform, so the ends that come during a wait reach it.
#[derive(Default)]
pub(crate) struct FrameWaits(Mutex<FrameWaitList>);

#[derive(Default)]
struct FrameWaitList {
    last: u64,
    waits: HashMap<u64, FrameWait>,
}

/// One settled frame wait: whether a host call of the page asked it, and the sender of its outcome.
struct FrameWait {
    page_call: bool,
    sender: mpsc::Sender<FrameOutcome>,
}

impl FrameWaits {
    fn lock(&self) -> std::sync::MutexGuard<'_, FrameWaitList> {
        // default: a lock that a panicking thread poisoned still holds the waits, which are only added, removed or ended; the
        // panic hook records the panic.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn begin(&self, page_call: bool, sender: mpsc::Sender<FrameOutcome>) -> u64 {
        let mut list = self.lock();
        list.last += 1;
        let id = list.last;
        list.waits.insert(id, FrameWait { page_call, sender });
        id
    }

    fn finish(&self, id: u64) {
        self.lock().waits.remove(&id);
    }

    /// Ends the waits with end: only those of host calls of the page with page_calls, every wait without.
    fn end(&self, end: &str, page_calls: bool) {
        let ended: Vec<FrameWait> = {
            let mut list = self.lock();
            let ids: Vec<u64> = list
                .waits
                .iter()
                .filter(|(_, wait)| wait.page_call || !page_calls)
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| list.waits.remove(id)).collect()
        };
        for wait in ended {
            if wait
                .sender
                .send(FrameOutcome::Ended(end.to_string()))
                .is_err()
            {
                crate::application_log::log_info(
                    "window",
                    "the end of a presented wait arrived after its request ended",
                );
            }
        }
    }
}

impl WindowData {
    /// Ends the requests that wait in the window with `end`, the close of the window or the end of its main page process: a
    /// reload that waits for the ready page, a presented wait for the first frame of the modal, a presented wait for the
    /// end of the continuous update and a presented wait for the settled frame (docs/spec/native-host.md).
    pub(crate) fn end_waits(&self, end: &str) {
        self.ends.record(end);
        self.overlay.wake_paint_waits();
        self.images.wake_waits();
        self.frame_waits.end(end, false);
        crate::surfaces::end_settled_waits(&self.running);
        end_reloads(self, Err(ReloadEnd::Ended(end.to_string())));
    }

    /// Ends the waits of the host calls that the main page sent with `end`, the end of the generation of that page, and holds
    /// the end for the calls that begin before the next page starts (`start_page_calls`): the page reads again only after each
    /// of its calls has its reply (docs/spec/native-host.md#page-reload).
    pub(crate) fn end_page_calls(&self, end: &str) {
        self.page_calls.record(end);
        self.overlay.wake_paint_waits();
        self.images.wake_waits();
        self.frame_waits.end(end, true);
    }

    /// Ends the waits of the host calls of the page before the new main page that starts, and lets the calls of the new page
    /// wait.
    pub(crate) fn start_page_calls(&self) {
        self.end_page_calls(PAGE_REPLACED_END);
        self.page_calls.release();
    }

    /// Waits for the answer of the settled frame wait that start asks of the platform with the sender of the answer, and returns
    /// the time of that screen. An end of the window or of its page process during the wait ends it with 1003 and that end, and
    /// so does, for a wait of a host call of the page (page_call), the end of the generation of the page, which ends such a wait
    /// that begins after it at once until the next page starts.
    pub(crate) fn wait_settled_frame(
        &self,
        page_call: bool,
        start: impl FnOnce(mpsc::Sender<FrameOutcome>) -> Result<(), String>,
    ) -> Result<f64, crate::endpoint::Failure> {
        use crate::endpoint::{Failure, MISSING_DOCUMENT};
        // The failures of the start and of the platform are internal failures, as the other failures of the presented wait.
        let internal = |error: String| Failure::new(-32603, error);
        if page_call && let Some(end) = self.page_calls.holding() {
            return Err(Failure::new(MISSING_DOCUMENT, end));
        }
        let (sender, outcome) = mpsc::channel();
        let id = self.frame_waits.begin(page_call, sender.clone());
        let started = start(sender);
        let answer = started.map(|()| outcome.recv());
        self.frame_waits.finish(id);
        match answer {
            Err(error) => Err(internal(error)),
            Ok(Ok(FrameOutcome::Displayed(Ok(displayed)))) => Ok(displayed),
            Ok(Ok(FrameOutcome::Displayed(Err(error)))) => Err(internal(error)),
            Ok(Ok(FrameOutcome::Ended(end))) => Err(Failure::new(MISSING_DOCUMENT, end)),
            // default: the registration holds a sender until the wait finishes, so the channel cannot close before an answer.
            Ok(Err(_)) => Err(Failure::new(
                MISSING_DOCUMENT,
                "the window closed before it presented",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ViewSourceEvent {
    pub name: String,
    pub value: Value,
}

#[derive(Default)]
pub(crate) struct ViewSourceEventStream(Mutex<Option<Channel<ViewSourceEvent>>>);

impl ViewSourceEventStream {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Channel<ViewSourceEvent>>> {
        // default: the lock holds only the replaceable event sender; the panic hook records the panic.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn install(&self, channel: Channel<ViewSourceEvent>) {
        self.lock().replace(channel);
    }

    pub(crate) fn retire(&self) {
        self.lock().take();
    }

    pub(crate) fn send(&self, name: &str, value: Value) -> Result<(), String> {
        if !is_view_source_event(name) {
            return Err(format!("{name} is not a view source event"));
        }
        let channels = self.lock();
        let channel = channels
            .as_ref()
            .ok_or_else(|| "view source event channel is not registered".to_string())?;
        channel
            .send(ViewSourceEvent {
                name: name.to_string(),
                value,
            })
            .map_err(|error| format!("view source event {name}: {error}"))
    }
}

fn is_view_source_event(name: &str) -> bool {
    matches!(
        name,
        "view-source-registered"
            | "view-source-ended"
            | "view-call"
            | "view-reply"
            | "view-process-ended"
            | "view-stopped"
            | "view-responsiveness"
    )
}

pub(crate) fn emit_view_source_event(
    window: &Window,
    name: &str,
    value: Value,
) -> Result<(), String> {
    window_data(window)?.view_source_events.send(name, value)
}

pub fn register_view_source_event_stream(
    webview: &Webview,
    channel: Channel<ViewSourceEvent>,
) -> Result<(), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(
        webview.label(),
        window.label(),
        "view source event stream",
    )?;
    window_data(&window)?.view_source_events.install(channel);
    Ok(())
}

#[cfg(test)]
#[path = "../tests/view_source_stream/stream_test.rs"]
mod view_source_stream_test;

/// A reload of the app DOM replaces all plugin documents but does not end the sessions: the modules of the new page reach
/// the same session owners (docs/spec/surface-composition.md). The reload sends the sidecars only the detach of each
/// captured image of `surface` in `targets`, without waiting for the acknowledgements, so the surface stays pending until
/// its detaches end (docs/spec/sidecars.md).
pub fn reload_surface_sidecars<O: crate::sidecars::Owner>(
    sidecars: &crate::sidecars::Sidecars<O>,
    owner: &O,
    images: &crate::images::Images,
    targets: Vec<crate::images::DetachTarget>,
    ended_event: crate::sidecars::image_detach::EndedEvent,
) -> Result<(), String> {
    crate::sidecars::image_detach::begin_image_detaches(
        sidecars,
        owner,
        images,
        targets,
        ended_event,
    )?;
    Ok(())
}

/// Ends what the earlier page left in the layout of its window: the waits of its presentations, its open layout and the
/// keys that wait for the decision of its workbench, because that workbench ended with the page
/// (docs/spec/native-surfaces.md#keyboard-of-a-surface). Every step runs also when an earlier one fails, because each
/// leaves its own state open.
pub(crate) fn end_page_layout(
    abandon: impl FnOnce() -> Result<(), String>,
    cancel: impl FnOnce() -> Result<(), String>,
    keys_page_ended: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let failures: Vec<String> = [
        abandon(),
        cancel().map_err(|error| format!("cancelling layout: {error}")),
        keys_page_ended().map_err(|error| format!("ending the key wait: {error}")),
    ]
    .into_iter()
    .filter_map(Result::err)
    .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// Tauri calls this from the main-webview `PageLoadEvent::Started` callback. The cleanup here is deliberately
/// synchronous: while the previous image handle waits for removal in the same AppKit run loop, the replacement page
/// must not attach a new native image.
pub(crate) fn reload_surface_documents(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    let owner = native_owner(window)?;
    let platform = platform::current()?;
    let window = window.clone();
    end_page_layout(
        || crate::documents::abandon_all_layout_presentation_waits(&window),
        || platform.cancel_layout(owner),
        || platform.keys_page_ended(owner),
    )?;
    // The new main document registers its own sidecar receivers, and its views subscribe again.
    data.sidecar_routes.clear();
    let surfaces: Vec<_> = data
        .surface_hosts
        .lock()
        // default: a lock that a panicking thread poisoned still holds the surface registrations, which are only read;
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(id, handle)| (id.clone(), *handle))
        .collect();
    let ended_window = window.clone();
    let ended_event: crate::sidecars::image_detach::EndedEvent = Arc::new(move |event| {
        if let Err(error) = emit_window(&ended_window, "image-detach-ended", event) {
            log_error("image-detach-ended", error);
        }
    });
    for (surface, handle) in surfaces {
        let surface_detachments = data.images.begin_reload(&surface);
        platform.set_surface_hidden_handle(handle, true)?;
        crate::exposure::surface_closed(&window, &surface);
        let view_plugin = data.documents.views().plugin(&surface);
        let view_generation = data.view_source_origins.current_view(&surface);
        if let (Some(plugin), Some(generation)) = (view_plugin, view_generation)
            && data.view_source_origins.end_view(&surface, generation)
            && let Err(error) = emit_view_source_event(
                &window,
                "view-source-ended",
                view_source_origin_event(&plugin, Some(&surface), generation),
            )
        {
            log_error("view channel", error);
        }
        for document in
            crate::documents::remove_surface_for_reload(&data.documents, &data.streams, &surface)
        {
            platform.close_document(document)?;
        }
        for image in data.images.remove_surface(&surface) {
            platform.close_image(image)?;
        }
        reload_surface_sidecars(
            &window.state::<WindowSidecars>(),
            &window,
            &data.images,
            surface_detachments,
            Arc::clone(&ended_event),
        )?;
    }
    data.composition_revisions
        .lock()
        // default: a lock that a panicking thread poisoned still holds the composition revisions, which this call
        // clears; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
    crate::surfaces::clear_page_compositions(&data.compositions, &data.surface_plugins);
    crate::exposure::window_changed(&window);
    Ok(())
}

/// The window registry and the project-owned windows of the application.
#[derive(Default)]
pub struct Windows {
    pub(crate) quit: std::sync::Arc<crate::quit::Quit>,
    /// The command of the pending application update or relaunch, which the exit starts
    /// (docs/spec/installation.md#application-update, docs/spec/endpoint.md#diagnostic-builds).
    pub update: Mutex<Option<crate::app_update::PendingStart>>,
    removals: crate::project_removal::Removals,
    next_window: AtomicU64,
    opening: Mutex<()>,
    windows: Mutex<HashMap<String, Arc<WindowData>>>,
    owners: Mutex<HashMap<String, String>>,
}

/// Removes the window from the owner and window records, and returns whether no window is left while the application quits.
fn remove_window_records(registry: &Windows, label: &str) -> bool {
    let mut owners = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, and the record of the destroyed window is
        // removed from it; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    owners.retain(|_, owner| owner != label);
    drop(owners);
    let mut windows = registry
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window record, and the record of the destroyed window is
        // removed from it; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    windows.remove(label);
    windows.is_empty() && registry.quit.active()
}

/// Registers records as the records of the window of label, without the native steps of register.
#[cfg(test)]
pub(crate) fn register_records(registry: &Windows, label: &str, records: Arc<WindowData>) {
    registry
        .windows
        .lock()
        // default: a test that panicked poisoned the lock of its own registry, which this test does not share.
        .unwrap_or_else(PoisonError::into_inner)
        .insert(label.to_string(), records);
}

/// Returns the state of the window.
pub fn window_data(window: &Window) -> Result<Arc<WindowData>, String> {
    window_records_in(&window.state::<Windows>(), window.label())
}

/// Runs an action of a notification of a window. The window closes before a late notification runs, and a closed window has
/// nothing to read or to draw, so the action does not run and no failure is reported.
pub(crate) fn with_open_window(
    records: &Result<Arc<WindowData>, String>,
    action: impl FnOnce(&Arc<WindowData>) -> Result<(), String>,
) -> Result<(), String> {
    let Ok(data) = records else {
        return Ok(());
    };
    action(data)
}

/// Returns window state when its record is still registered. A missing record means the window has been destroyed.
pub(crate) fn window_data_if_registered(window: &Window) -> Option<Arc<WindowData>> {
    window_records_if_registered(&window.state::<Windows>(), window.label())
}

/// Returns a registered window record without turning window destruction into an operational error.
pub(crate) fn window_records_if_registered(
    registry: &Windows,
    label: &str,
) -> Option<Arc<WindowData>> {
    registry
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which are only read; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(label)
        .cloned()
}

/// Returns the state of the window of label in the registry, or the error of a window that is closed.
pub(crate) fn window_records_in(
    registry: &Windows,
    label: &str,
) -> Result<Arc<WindowData>, String> {
    window_records_if_registered(registry, label).ok_or_else(|| "project window is closed".into())
}

/// Returns the main webview of the window.
pub(crate) fn root_view(window: &Window) -> Option<Webview> {
    window.get_webview(window.label())
}

/// Returns the native address of the window.
pub(crate) fn native_owner(window: &Window) -> Result<Handle, String> {
    platform::current()?.window_handle(window)
}

/// The failure of an operation that writes the native address of a window.
#[derive(Debug, PartialEq)]
pub enum NativeFailure {
    /// The window closed before the main-thread step of the operation. The native code did not receive the window.
    Closed,
    /// The address could not be read or the native code failed.
    Failed(String),
}

impl std::fmt::Display for NativeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NativeFailure::Closed => f.write_str("project window is closed"),
            NativeFailure::Failed(error) => f.write_str(error),
        }
    }
}

/// The work to run in one step of the main thread.
pub type MainStep = Box<dyn FnOnce() + Send>;

/// Reads the native address of the window with owner and runs work with that address. The read and the run are in one
/// main-thread step that on_main runs. The close of a window is handled by the main thread, and in that handling the
/// runtime closes and releases the NSWindow, so if the step were split, a close between the parts would pass the
/// address of a closed window to the native code. A window that closed before the step has owner None, does not run
/// work and returns Closed.
pub fn use_owner<W: Send + 'static, T: Send + 'static>(
    window: W,
    on_main: impl FnOnce(MainStep) -> Result<(), String>,
    owner: impl FnOnce(&W) -> Result<Option<Handle>, String> + Send + 'static,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, NativeFailure> {
    let (tx, rx) = mpsc::channel();
    on_main(Box::new(move || {
        let result = match owner(&window) {
            Ok(Some(handle)) => work(handle).map_err(NativeFailure::Failed),
            Ok(None) => Err(NativeFailure::Closed),
            Err(error) => Err(NativeFailure::Failed(error)),
        };
        match tx.send(result) {
            Ok(()) => {}
            // A failure after the request ended was not reported by that request, so it is left as an error line.
            Err(mpsc::SendError(Err(error))) => log_error("native window work", error),
            Err(mpsc::SendError(Ok(_))) => crate::application_log::log_info(
                "window",
                "native window result arrived after its request ended",
            ),
        }
    }))
    .map_err(NativeFailure::Failed)?;
    rx.recv()
        .map_err(|e| NativeFailure::Failed(e.to_string()))?
}

/// The native address of a window that is registered and whose close was not accepted. It is None for a window that is
/// closing or a window whose registration Destroyed deleted. Call it on the main thread. If the close request is not
/// blocked, the runtime sets closing in the same main-thread handling and then closes the window, so a window that is
/// not closing on the main thread is open.
pub(crate) fn open_owner(window: &Window) -> Result<Option<Handle>, String> {
    let open = window
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which are only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(window.label())
        .is_some_and(|data| !data.closing.load(Ordering::Relaxed));
    if !open {
        return Ok(None);
    }
    native_owner(window).map(Some)
}

/// Reads the native address of the window in one step of the main thread and runs work with that address. A window that
/// closed before that step does not run work and is Closed.
pub(crate) fn with_native_owner<T: Send + 'static>(
    window: &Window,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, NativeFailure> {
    use_owner(
        window.clone(),
        |step| {
            crate::exposure::on_main(window, move || {
                step();
                Ok(())
            })
        },
        open_owner,
        work,
    )
}

/// Cancels only the queued or active surface placement ticket of the window.
pub(crate) fn cancel_window_layout_ticket(window: &Window, ticket: u64) -> Result<(), String> {
    let platform = platform::current()?;
    match with_native_owner(window, move |owner| {
        platform.cancel_layout_ticket(owner, ticket)
    }) {
        Ok(()) | Err(NativeFailure::Closed) => Ok(()),
        Err(NativeFailure::Failed(error)) => Err(error),
    }
}

/// Sends an event to the web views of the window.
pub(crate) fn emit_window<S: Serialize + Clone>(
    window: &Window,
    event: &str,
    payload: S,
) -> crate::framework::Result<()> {
    window.emit_webviews(event, payload)
}

/// Sends workspace-changed to all windows.
pub(crate) fn notify_workspace(app: &AppHandle) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "workspace-changed", ()) {
            log_error("workspace-changed", error);
        }
    }
}

/// Sends the host event `debug-log-changed` to every window and the value of the host status `host.log` to its watchers: the notice
/// of a change of the event log (docs/spec/debug.md#following).
pub(crate) fn notify_log_notice(app: &AppHandle, notice: &crate::debug_follow::LogNotice) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "debug-log-changed", notice.clone()) {
            log_error("debug-log-changed", error);
        }
    }
    crate::exposure::log_notice_changed(app, notice);
}

/// Sends the host event to every window; every document of a window receives it.
pub(crate) fn notify_windows(app: &AppHandle, name: &str, payload: serde_json::Value) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, name, payload.clone()) {
            log_error(name, error);
        }
    }
}

/// Whether the application is quitting, which ends the WebContent process of each window on purpose.
pub(crate) fn is_quitting(app: &AppHandle) -> bool {
    app.state::<Windows>().quit.active()
}

/// Sends sidecars-changed to every window (docs/spec/installation.md).
pub(crate) fn notify_sidecars(app: &AppHandle) {
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "sidecars-changed", ()) {
            log_error("sidecars-changed", error);
        }
    }
}

/// Sends plugins-changed to all windows.
pub(crate) fn notify_plugins(app: &AppHandle, change: crate::plugins::Changed) {
    // The enable of a plugin clears the sidecar stops of its manifest in one step, as a surface open does.
    if change.action == "enable" {
        app.state::<crate::sidecars::WindowSidecars>()
            .plugin_enabled(&change.plugin);
    }
    for window in app.windows().values() {
        if let Err(error) = emit_window(window, "plugins-changed", change.clone()) {
            log_error("plugins-changed", error);
        }
    }
}

/// Returns the window with the label label among the registered windows.
pub(crate) fn find(app: &AppHandle, label: &str) -> Option<Window> {
    let registered = app
        .state::<Windows>()
        .windows
        .lock()
        .is_ok_and(|windows| windows.contains_key(label));
    if !registered {
        return None;
    }
    app.get_window(label)
}

/// Returns the identifier, the title, the owning project ids and the key window state of the registered windows in the
/// order of window identifiers.
pub(crate) fn list(app: &AppHandle) -> Result<serde_json::Value, String> {
    // The identifiers and the state are read at once. If they were read separately, Destroyed could delete the
    // registration in between.
    let mut registered: Vec<(String, Arc<WindowData>)> = app
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which are only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(label, data)| (label.clone(), data.clone()))
        .collect();
    registered.sort_by(|a, b| a.0.cmp(&b.0));
    let windows: Vec<(Window, Arc<WindowData>)> = registered
        .into_iter()
        .filter_map(|(label, data)| app.get_window(&label).map(|window| (window, data)))
        .collect();
    list_entries(
        windows,
        |step| crate::exposure::app_on_main(app, step),
        |(window, data)| {
            let root = data
                .root
                .lock()
                // default: a lock that a panicking thread poisoned still holds the root webview of the window, which is
                // only read; the panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            window_entry(
                window.label(),
                data.closing.load(Ordering::Relaxed),
                data.ready.load(Ordering::Relaxed),
                root,
                || window.title().map_err(|e| e.to_string()),
                || window.is_focused().map_err(|e| e.to_string()),
            )
        },
    )
}

/// One main-thread step of the host.windows list.
pub type ListStep = Box<dyn FnOnce() -> Result<Vec<serde_json::Value>, String> + Send>;

/// Creates the list entry with entry for each window. The entries of all windows are created in one main-thread step
/// that on_main runs. The close of a window is handled by the main thread, so within one step the window does not leave
/// the runtime between reading closing and the lookup. A window lookup made on the main thread is handled at once
/// without waiting (send_user_message of tauri-runtime-wry).
pub fn list_entries<W: Send + 'static>(
    windows: Vec<W>,
    on_main: impl FnOnce(ListStep) -> Result<Vec<serde_json::Value>, String>,
    entry: impl Fn(&W) -> Result<Option<serde_json::Value>, String> + Send + 'static,
) -> Result<serde_json::Value, String> {
    let listed = on_main(Box::new(move || {
        let mut listed = Vec::new();
        for window in &windows {
            listed.extend(entry(window)?);
        }
        Ok(listed)
    }))?;
    Ok(serde_json::Value::Array(listed))
}

/// One window of host.windows. A window whose close was accepted is not looked up and is None, because that window
/// disappears from the runtime before Destroyed and the lookup of its title and focus fails. The lookup failure of
/// another window is returned as an error.
pub fn window_entry(
    label: &str,
    closing: bool,
    ready: bool,
    root: String,
    title: impl FnOnce() -> Result<String, String>,
    key: impl FnOnce() -> Result<bool, String>,
) -> Result<Option<serde_json::Value>, String> {
    if closing {
        return Ok(None);
    }
    let project = if root.is_empty() { None } else { Some(root) };
    Ok(Some(serde_json::json!({
        "ready": ready,
        "window": label,
        "title": title()?,
        "project": project,
        "key": key()?,
    })))
}

/// Returns the list of project ids opened in the window.
pub(crate) fn opened(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(app
        .state::<Windows>()
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .keys()
        .cloned()
        .collect())
}

/// The title of a window that has no project open, with the display name of the framework (framework::display_name). The
/// configuration of the framework declares the title of the first window with the same value.
fn window_title(display_name: &str) -> String {
    format!("soksak / {display_name}")
}

fn new_window(app: &AppHandle, label: &str, url: &str, title: &str) -> Result<Window, String> {
    // The window starts hidden, and register shows it once it has prepared the presentation of the first screen. A
    // dropped file is received by the file drop view of the window (docs/spec/native-surfaces.md).
    let window = app.window_of(
        app.framework()
            .new_window(WindowOptions {
                label: label.to_string(),
                url: url.to_string(),
                title: title.to_string(),
                width: 1200.0,
                height: 760.0,
                background: Color(16, 17, 23, 255),
            })
            .map_err(|e| e.to_string())?,
    );
    register(window.clone())?;
    crate::exposure::windows_changed(app);
    Ok(window)
}

/// Opens a new project window.
pub(crate) fn window_new_on_main(app: AppHandle) -> Result<(), String> {
    let id = app
        .state::<Windows>()
        .next_window
        .fetch_add(1, Ordering::Relaxed);
    new_window(
        &app,
        &format!("project-window-{id}"),
        "index.html",
        &window_title(crate::framework::display_name()),
    )?;
    Ok(())
}

/// Schedules the creation on the AppKit event-loop thread without blocking that thread.
pub fn window_new(app: AppHandle) -> Result<(), String> {
    let task = app.clone();
    let (tx, rx) = mpsc::channel();
    app.post(move || {
        if tx.send(window_new_on_main(task)).is_err() {
            crate::application_log::log_info(
                "window",
                "window creation result arrived after its request ended",
            );
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Adds the window to the registry and handles the window events. The window buttons are placed when the page is ready
/// and when the window size changes.
/// Answers a move or a change of the backing scale of a window. A frame of the earlier backing scale is refused, so each supplier
/// draws at the new raster when the window changes display: `refresh_rasters` starts that, and its native part runs on the main
/// thread.
pub fn placement_changed(
    event: &WindowEvent,
    changed: impl FnOnce(),
    refresh_rasters: impl FnOnce(),
) {
    changed();
    if matches!(event, WindowEvent::ScaleFactorChanged) {
        refresh_rasters();
    }
}

pub(crate) fn register(window: Window) -> Result<(), String> {
    let context = Arc::new(WindowData::default());
    window
        .state::<Windows>()
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window records, which this call fills; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .insert(window.label().into(), context.clone());
    let reading = window.clone();
    crate::performance::window_add(
        window.label(),
        std::sync::Arc::new(move || crate::exposure::window_processes(&reading)),
    );
    let platform = platform::current()?;
    let owner = native_owner(&window)?;
    let main = root_view(&window).ok_or("the main webview is gone")?;
    let main = crate::exposure::with_view(&main, move |view| platform.view_id(view))?;
    platform.set_main_webview(owner, main)?;
    show_new_window(&NewWindow {
        platform,
        owner,
        window: &window,
    })?;
    // The native view lies over the DOM, so the page handles a dropped file relative to the DOM element at that point.
    let dropped = window.clone();
    // The page interprets the content and reports errors (core.drop).
    platform.file_drop(
        main,
        Box::new(move |json| {
            if let Err(error) = emit_window(&dropped, "files-dropped", json) {
                log_error("files-dropped", error);
            }
        }),
    )?;
    // The page combines the first responder with the focus of its documents in core.focus.
    let responding = window.clone();
    // The close of the window ends the observation in a later main-thread step, when AppKit may have released the window, so
    // the step ends the observation and not the window.
    let responder_observation =
        platform.observe_responder(owner, Box::new(move || responder_changed(&responding)))?;
    // The cursor that the application sets for the virtual key window is a value of host.window.
    let cursor_host = window.clone();
    let cursor_observation = platform.observe_cursor(
        owner,
        Box::new(move || crate::exposure::window_changed(&cursor_host)),
    )?;
    // The sheet that a panel or an alert attaches to the window is a value of host.window, so a check knows that it opened.
    let sheet_host = window.clone();
    let sheet_observation = platform.observe_sheet(
        owner,
        Box::new(move || crate::exposure::window_changed(&sheet_host)),
    )?;
    // Notifies the connections that watch host.window of the change of the occlusion state. Tauri does not send this
    // change as a window event.
    let occluded = window.clone();
    platform.observe_occlusion(
        owner,
        Box::new(move |on_screen| {
            crate::window_events::record_window_event(occluded.label(), "occlusion_changed");
            // An occluded or minimized window draws no image region (docs/spec/native-surfaces.md#image-regions).
            if let Err(error) = with_open_window(&window_data(&occluded), |data| {
                // The notice carries the state of its window: the handle of a closing window is no longer available.
                data.images.set_on_screen(on_screen);
                Ok(())
            }) {
                log_error("window on screen", error);
            }
            let drawing = occluded.clone();
            crate::routine::spawn_named("image-drawing", move || {
                if let Err(error) = with_open_window(&window_data(&drawing), |data| {
                    crate::composition::send_image_drawing_of(&drawing, data)
                }) {
                    log_error("image drawing", error);
                }
            });
            crate::exposure::window_changed(&occluded)
        }),
    )?;
    // The title bar has its initial height until the page requests the height of the first row. It is set before the
    // window is shown.
    initial_titlebar(&window)?;
    let host = window.clone();
    let window_events_label = window.label().to_string();
    window.on_window_event(move |event| {
        let kind = match event {
            WindowEvent::Resized => Some("resize"),
            WindowEvent::Moved => Some("move"),
            WindowEvent::ScaleFactorChanged => Some("scale_factor_changed"),
            WindowEvent::Focused(true) => Some("focus"),
            WindowEvent::Focused(false) => Some("lost_focus"),
            _ => None,
        };
        if let Some(kind) = kind {
            crate::window_events::record_window_event(window_events_label.as_str(), kind);
        }
    });
    let closing_host = window.clone();
    let closing_context = context.clone();
    window.on_closing(move || {
        let ready = closing_context.ready.load(Ordering::Relaxed);
        crate::window_events::record_window_event(
            closing_host.label(),
            if ready { "close_requested" } else { "closed" },
        );
        close_requested(&closing_context, ready, || {
            if let Err(error) = emit_window(&closing_host, "project-close-request", ()) {
                log_error("project-close-request", error);
            }
        })
    });
    window.on_window_event(move |event| match event {
        WindowEvent::Destroyed => {
            context.end_waits("the window closed");
            context.documents.views().forget_all();
            // The close of the window ends its run with its transactions (docs/spec/native-surfaces.md#layout-transaction).
            crate::surfaces::end_run(&context.running);
            // A window that ends keeps no tab, so a removal that asked it is allowed.
            host.state::<Windows>().removals.abandon(host.label());
            crate::exposure::window_closed(&host);
            let natives = context.clone();
            // The records of the window are removed below, before the main-thread step runs, so the step takes them now.
            let closing = window_data(&host);
            log_failure(
                "window close",
                platform.enqueue_ui(Box::new(move || {
                    if let Ok(data) = &closing {
                        log_failure(
                            "surface layout cancel",
                            data.documents.presentation().abandon_all(),
                        );
                    }
                    log_failure("surface layout cancel", platform.cancel_layout(owner));
                    platform.end_responder_observation(responder_observation);
                    platform.end_cursor_observation(cursor_observation);
                    platform.end_sheet_observation(sheet_observation);
                    // A logical surface holds the main webview, so if it is not closed, the main webview and its web
                    // content process remain.
                    let surfaces = std::mem::take(
                        &mut *natives
                            .surface_hosts
                            .lock()
                            // default: a lock that a panicking thread poisoned still holds the surface registrations,
                            // which the close of the window takes and closes; the panic hook records the panic.
                            .unwrap_or_else(PoisonError::into_inner),
                    );
                    log_failure(
                        "window close",
                        crate::surfaces::close_window_surfaces(
                            surfaces,
                            &natives.documents,
                            &natives.streams,
                            &natives.images,
                            &mut |native| match native {
                                crate::surfaces::WindowNative::Document(handle) => {
                                    platform.close_document(handle)
                                }
                                crate::surfaces::WindowNative::Image(handle) => {
                                    platform.close_image(handle)
                                }
                                crate::surfaces::WindowNative::Surface(handle) => {
                                    platform.close_surface(handle)
                                }
                            },
                        ),
                    );
                })),
            );
            let monitor = context
                .watching
                .0
                .lock()
                // default: a lock that a panicking thread poisoned still holds the input monitor, which is taken and removed; the panic
                // hook records the panic.
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(monitor) = monitor {
                log_failure("surface input", platform.unwatch_input(monitor));
            }
            let mut shapes = context
                .shapes
                .0
                .lock()
                // default: a lock that a panicking thread poisoned still holds the shapes of the window, which are all destroyed; the
                // panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            for (_, shape) in shapes.drain() {
                log_failure("shape", platform.destroy_shape(shape));
            }
            log_failure(
                "sidecar retain",
                host.state::<WindowSidecars>().retain(&host, &|_| false),
            );
            let registry = host.state::<Windows>();
            crate::performance::window_remove(host.label());
            if remove_window_records(&registry, host.label()) {
                crate::event_record::quit_with_cause(
                    "last-window-closed",
                    crate::event_record::host_quit_source("last-window-closed"),
                    || host.app_handle().quit(),
                );
            }
            notify_workspace(host.app_handle());
            crate::exposure::windows_changed(host.app_handle());
        }
        WindowEvent::Resized => {
            crate::exposure::window_changed(&host);
        }
        WindowEvent::Focused(focused) => {
            if *focused {
                crate::window_events::record_window_event(host.label(), "window-active");
                if let Err(error) = emit_window(&host, "window-active", ()) {
                    log_error("window-active", error);
                }
            }
            crate::exposure::window_changed(&host);
            crate::exposure::windows_changed(host.app_handle());
        }
        event @ (WindowEvent::Moved | WindowEvent::ScaleFactorChanged) => {
            placement_changed(
                event,
                || crate::exposure::window_changed(&host),
                || {
                    let window = host.clone();
                    crate::routine::spawn_named("image-rasters", move || {
                        if let Err(error) = crate::composition::refresh_image_rasters(&window) {
                            log_error("image rasters", error);
                        }
                    });
                },
            );
        }
    });
    Ok(())
}

/// The window position and size. The position is in physical pixels and the size is in logical pixels.
#[derive(Clone, Deserialize, Serialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
pub struct OpenProject {
    id: String,
    root: String,
    separate: bool,
    geometry: Option<Geometry>,
}

/// The project that a page has selected after loading its project data context.
#[derive(Clone, Debug)]
pub struct ProjectShown {
    project: Option<ShownProject>,
}

impl<'de> Deserialize<'de> for ProjectShown {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ProjectShownVisitor;

        impl<'de> serde::de::Visitor<'de> for ProjectShownVisitor {
            type Value = ProjectShown;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a project-shown request object")
            }

            fn visit_map<M>(self, mut fields: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut project = None;
                let mut has_project = false;
                while let Some(key) = fields.next_key::<String>()? {
                    if key == "project" {
                        if has_project {
                            return Err(serde::de::Error::duplicate_field("project"));
                        }
                        project = fields.next_value::<Option<ShownProject>>()?;
                        has_project = true;
                    } else {
                        fields.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
                if !has_project {
                    return Err(serde::de::Error::missing_field("project"));
                }
                Ok(ProjectShown { project })
            }
        }

        deserializer.deserialize_map(ProjectShownVisitor)
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ShownProject {
    id: String,
    root: String,
    title: String,
}

/// Opens a project. An already open project activates its owning window, and a separate request creates a new window
/// when the requesting window owns another project.
/// The operations that bring a window in front: a project open (`show_project_owner`) and an activated notification use
/// them. The real window implements them, and a test supplies a recorder.
pub trait WindowFront {
    fn show(&self) -> crate::framework::Result<()>;
    fn focus(&self) -> crate::framework::Result<()>;
    /// Whether the window is the key window of the application.
    fn is_focused(&self) -> crate::framework::Result<bool>;
}

impl WindowFront for Window {
    fn show(&self) -> crate::framework::Result<()> {
        Window::show(self)
    }

    fn focus(&self) -> crate::framework::Result<()> {
        Window::focus(self)
    }

    fn is_focused(&self) -> crate::framework::Result<bool> {
        Window::is_focused(self)
    }
}

/// The steps that put a new window on the screen. The real window implements them, and a test supplies a recorder.
pub trait NewWindowShow {
    /// Centers the window in the work area of the display of the frontmost window of the application.
    fn place(&self) -> Result<(), String>;
    /// Keeps the window transparent until its first screen is presented.
    fn reveal(&self) -> Result<(), String>;
    fn show(&self) -> Result<(), String>;
}

/// A window that register shows, with the platform and the native window that it shows it through.
struct NewWindow<'a> {
    platform: &'a dyn platform::Platform,
    owner: Handle,
    window: &'a Window,
}

impl NewWindowShow for NewWindow<'_> {
    fn place(&self) -> Result<(), String> {
        self.platform.place_new_window(self.owner)
    }

    fn reveal(&self) -> Result<(), String> {
        self.platform.reveal_after_load(self.owner)
    }

    fn show(&self) -> Result<(), String> {
        self.window.show().map_err(|e| e.to_string())
    }
}

/// Puts a new window on the screen. A framework places a new window on the display of the key window of the active
/// application, which for an application that is not active is a display of another application, so the window goes to the
/// display of the frontmost window of this application first (native/darwin/src/window_reveal.h). The window is shown after
/// its first screen is presented (docs/spec/native-host.md#page-start): it is created hidden, put on the screen transparent,
/// and becomes opaque when the first screen is presented.
pub fn show_new_window(window: &impl NewWindowShow) -> Result<(), String> {
    window.place()?;
    window.reveal()?;
    window.show()
}

/// Shows the window that owns a project opened from another window. The window comes in front of the other windows of
/// the application as the key window; it does not activate the application, whose activation the system may refuse
/// (docs/spec/projects.md).
pub fn show_project_owner(owner: &impl WindowFront) -> Result<(), String> {
    owner.show().map_err(|e| e.to_string())
}

/// Stores the front of the owner window after it is shown, with whether the window is the key window and whether the
/// application is active (window_events::record_project_front). A read that fails is reported on the application log, and
/// the record is not written when the key state cannot be read.
fn record_project_front(owner: &Window, project: &str) {
    let key = match owner.is_focused() {
        Ok(key) => key,
        Err(error) => {
            log_error("project front", error);
            return;
        }
    };
    let app_active =
        match crate::exposure::on_main(owner, || platform::current()?.application_active()) {
            Ok(active) => Some(active),
            Err(error) => {
                log_error("project front", error);
                None
            }
        };
    crate::window_events::record_project_front(owner.label(), project, key, app_active);
}

/// Shows and focuses the window of a notification that the person activated.
pub fn show_notification_owner(owner: &impl WindowFront) -> crate::framework::Result<()> {
    owner.show().and_then(|()| owner.focus())
}

pub fn project_open(window: &Window, request: OpenProject) -> Result<serde_json::Value, String> {
    let host = window.clone();
    crate::exposure::on_main(window, move || project_open_on_main(&host, request))
}

fn project_open_on_main(
    window: &Window,
    request: OpenProject,
) -> Result<serde_json::Value, String> {
    if request.id.is_empty()
        || !request
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("invalid project id".into());
    }
    let folder = project_folder(window.app_handle(), request.root)?;
    let registry = window.state::<Windows>();
    let _opening = registry
        .opening
        .lock()
        // default: a lock that a panicking thread poisoned still holds the open flag of the project open, which this call
        // holds again; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    let owner = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(&request.id)
        .cloned();
    if let Some(label) = owner {
        let owner = window
            .get_window(&label)
            .ok_or("project window is closed")?;
        let data = window_data(&owner)?;
        let staged = register_project_open(&data, &request.id, &folder.root, false);
        if label != window.label() {
            emit_window(&owner, "project-activate", &request.id).map_err(|e| e.to_string())?;
            show_project_owner(&owner)?;
            record_project_front(&owner, &request.id);
        }
        return Ok(serde_json::json!({
            "local": label == window.label(),
            "staged": staged,
        }));
    }
    let occupied = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .values()
        .any(|label| label == window.label());
    let separate = request.separate && occupied;
    let owner = if separate {
        let label = format!("project-{}", request.id);
        new_window(
            window.app_handle(),
            &label,
            &format!("index.html?project={}", request.id),
            &window_title(crate::framework::display_name()),
        )?
    } else {
        window.clone()
    };
    let data = window_data(&owner)?;
    let geometry = request
        .geometry
        .filter(|geometry| geometry.width > 0.0 && geometry.height > 0.0);
    let previous_geometry = if !separate && geometry.is_some() {
        Some((
            owner.size().map_err(|error| error.to_string())?,
            owner.position().map_err(|error| error.to_string())?,
        ))
    } else {
        None
    };
    configure_project_window(
        geometry,
        separate,
        |geometry| {
            owner
                .set_size(LogicalSize::new(geometry.width, geometry.height))
                .map_err(|error| error.to_string())?;
            owner
                .set_position(LogicalPosition::new(geometry.x, geometry.y))
                .map_err(|error| error.to_string())
        },
        || {
            let Some((size, position)) = previous_geometry else {
                return Err("previous window geometry was not captured".into());
            };
            owner.set_size(size).map_err(|error| error.to_string())?;
            owner
                .set_position(position)
                .map_err(|error| error.to_string())
        },
        || owner.close().map_err(|error| error.to_string()),
    )?;
    let staged = register_project_open(&data, &request.id, &folder.root, true);
    registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which this call fills; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .insert(request.id, owner.label().into());
    crate::exposure::windows_changed(window.app_handle());
    notify_workspace(window.app_handle());
    Ok(serde_json::json!({
        "local": owner.label() == window.label(),
        "staged": staged,
    }))
}

/// Registers project ownership without changing the project selected by the page.
fn register_project_open(data: &WindowData, id: &str, root: &str, new_owner: bool) -> bool {
    data.projects
        .lock()
        // default: the map stores independent project-root strings, and this insertion does not invoke user code; the
        // panic hook records a prior panic while the map was held.
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id.to_string(), root.to_string());
    let mut staged = data
        .staged_projects
        .lock()
        // default: staging is independent set membership; repeating insertion preserves the pending-open contract, and
        // the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    if new_owner {
        staged.insert(id.to_string());
    }
    staged.contains(id)
}

fn configure_project_window(
    geometry: Option<Geometry>,
    created: bool,
    configure: impl FnOnce(&Geometry) -> Result<(), String>,
    restore_existing: impl FnOnce() -> Result<(), String>,
    close_created: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Some(geometry) =
        geometry.filter(|geometry| geometry.width > 0.0 && geometry.height > 0.0)
        && let Err(error) = configure(&geometry)
    {
        let cleanup = if created {
            close_created()
        } else {
            restore_existing()
        };
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; project window cleanup failed: {cleanup_error}"
            )),
        };
    }
    Ok(())
}

fn release_project_reservation(data: &WindowData, id: &str) {
    data.projects
        .lock()
        // default: removing an absent reservation is safe and repeated release is idempotent.
        .unwrap_or_else(PoisonError::into_inner)
        .remove(id);
    data.staged_projects
        .lock()
        // default: removing an absent staged marker is safe and repeated release is idempotent.
        .unwrap_or_else(PoisonError::into_inner)
        .remove(id);
}

/// Commits the project selected by the page and publishes it only after the committed state is visible.
fn commit_project_shown(
    data: &WindowData,
    project: Option<&ShownProject>,
    display_name: &str,
    set_title: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let title = if let Some(project) = project {
        let root = data
            .projects
            .lock()
            // default: project roots are independent strings and this call only reads the ownership record; the panic
            // hook records a prior panic while the map was held.
            .unwrap_or_else(PoisonError::into_inner)
            .get(&project.id)
            .cloned()
            .ok_or_else(|| format!("project {} is not owned by this window", project.id))?;
        if root != project.root {
            return Err(format!(
                "project {} root does not match the root recorded by this window",
                project.id
            ));
        }
        format!("{} / {display_name}", project.title)
    } else {
        window_title(display_name)
    };
    set_title(&title)?;
    if let Some(project) = project {
        // default: the shown project and root are plain strings replaced as whole values after title setup succeeds; the
        // panic hook records a prior panic while either field was held.
        *data.shown.lock().unwrap_or_else(PoisonError::into_inner) = project.id.clone();
        // default: the shown project and root are plain strings replaced as whole values after title setup succeeds; the
        // panic hook records a prior panic while either field was held.
        *data.root.lock().unwrap_or_else(PoisonError::into_inner) = project.root.clone();
        data.staged_projects
            .lock()
            // default: removing the staged marker is idempotent after the project becomes shown.
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&project.id);
    } else {
        data.shown
            .lock()
            // default: clearing an already-empty shown project is idempotent.
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        data.root
            .lock()
            // default: clearing an already-empty project root is idempotent.
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
    Ok(())
}

fn project_shown_on_main(window: &Window, request: ProjectShown) -> Result<(), String> {
    if let Some(project) = request.project.as_ref() {
        if project.id.is_empty()
            || !project
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err("invalid project id".into());
        }
        let owner = window
            .state::<Windows>()
            .owners
            .lock()
            // default: this lookup reads the plain project-owner map; the panic hook records a prior panic while it was
            // held.
            .unwrap_or_else(PoisonError::into_inner)
            .get(&project.id)
            .cloned();
        if owner.as_deref() != Some(window.label()) {
            return Err(format!(
                "project {} is not owned by this window",
                project.id
            ));
        }
        let canonical = project_folder(window.app_handle(), project.root.clone())?;
        if canonical.root != project.root {
            return Err(format!("project {} root is not canonical", project.id));
        }
    }
    let data = window_data(window)?;
    commit_project_shown(
        &data,
        request.project.as_ref(),
        crate::framework::display_name(),
        |title| window.set_title(title).map_err(|error| error.to_string()),
    )?;
    crate::exposure::windows_changed(window.app_handle());
    Ok(())
}

/// Commits the page-selected project on the main thread after its data context is ready.
pub fn project_shown(window: &Window, request: ProjectShown) -> Result<(), String> {
    let host = window.clone();
    crate::exposure::on_main(window, move || project_shown_on_main(&host, request))
}

/// Releases the link between a project id and a window. A window with no remaining project shows the library, so the
/// project root and the title are cleared.
pub fn project_release(window: &Window, id: String) -> Result<(), String> {
    let registry = window.state::<Windows>();
    let (released, empty) = release_owner(&registry.owners, &id);
    if let Some(label) = released {
        // When the window is already closed, there is no state to clear.
        if let Some(owner) = window.app_handle().get_window(&label) {
            let data = window_data(&owner)?;
            release_project_reservation(&data, &id);
            // A release of the shown project clears the shown root at once, even when another project is still held: the window
            // shows no project until the page shows one explicitly.
            let shown_released = clear_released_shown(
                &mut data
                    .shown
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the shown project, which this call may clear;
                    // the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner),
                &id,
            );
            if empty || shown_released {
                window_data(&owner)?
                    .root
                    .lock()
                    // default: a lock that a panicking thread poisoned still holds the root webview of the window, which
                    // this call clears; the panic hook records the panic.
                    .unwrap_or_else(PoisonError::into_inner)
                    .clear();
                owner
                    .set_title(&window_title(crate::framework::display_name()))
                    .map_err(|e| e.to_string())?;
                crate::exposure::windows_changed(window.app_handle());
            }
        }
    }
    notify_workspace(window.app_handle());
    Ok(())
}

/// Clears the shown project of a window when it is the released project id, and reports whether it cleared it.
/// A shown project that is still held is kept.
pub(crate) fn clear_released_shown(shown: &mut String, id: &str) -> bool {
    let released = *shown == id;
    if released {
        shown.clear();
    }
    released
}

/// Removes the link of the project id from the owner record, and returns the released window label and whether no other
/// project shows that window.
fn release_owner(owners: &Mutex<HashMap<String, String>>, id: &str) -> (Option<String>, bool) {
    let mut owners = owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which this call amends; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    let released = owners.remove(id);
    let empty = released
        .as_ref()
        .is_some_and(|label| !owners.values().any(|other| other == label));
    (released, empty)
}

/// Asks the window that shows the project whether the project may be removed and returns its answer; returns true at
/// once when no other window shows the project (docs/spec/projects.md).
pub fn project_remove_ask(window: &Window, id: &str) -> Result<bool, String> {
    let registry = window.state::<Windows>();
    let owner = registry
        .owners
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(id)
        .cloned();
    let Some(label) = owner.filter(|label| label != window.label()) else {
        return Ok(true);
    };
    let asked = registry.removals.begin(id, &label)?;
    let target = window
        .get_window(&label)
        .ok_or("project window is closed")?;
    if let Err(error) = emit_window(&target, "project-remove-request", id) {
        registry.removals.abandon(&label);
        return Err(error.to_string());
    }
    asked.recv().map_err(|e| e.to_string())
}

/// Answers the removal request that `project_remove_ask` sent to this window.
pub fn project_remove_answer(window: &Window, id: &str, allowed: bool) -> Result<(), String> {
    window.state::<Windows>().removals.answer(id, allowed)
}

/// Returns the position and size of a window in the normal state. It is None for a maximized, full screen or minimized
/// window.
pub fn window_state(window: &Window) -> Result<Option<Geometry>, String> {
    if window.is_maximized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    // The position and size are stored in window coordinates. If they were stored in physical pixels, the same number
    // would point twice as far on a screen with scale 2, and the window would be pushed off the screen at every
    // reopening.
    let at = window.position().map_err(|e| e.to_string())?;
    let size = window.size().map_err(|e| e.to_string())?;
    Ok(Some(Geometry {
        x: at.x.round() as i32,
        y: at.y.round() as i32,
        width: size.width,
        height: size.height,
    }))
}

/// Allows each removal that asked the page of window, because that page ended: its WebContent process ended or its next page
/// starts (docs/spec/projects.md).
pub(crate) fn removal_page_ended(window: &Window) {
    window.state::<Windows>().removals.abandon(window.label());
}

/// Records that the main page started. Call it before the start document request answers. It leaves the window not
/// ready, ends the requests sent to the previous page, and cleans up the surface documents, the image regions and the
/// modals of the previous page.
pub(crate) fn page_started(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    // The start of a new page ends the waits of the host calls of the earlier page.
    data.start_page_calls();
    // The start of a new page ends the run of the earlier page with its transactions
    // (docs/spec/native-surfaces.md#layout-transaction).
    crate::surfaces::end_run(&data.running);
    let cleanup = (|| {
        data.ready.store(false, Ordering::Relaxed);
        removal_page_ended(window);
        // No page shows the failures of the cleared ends, so the host writes them.
        for failure in data.images.detach_page_starting() {
            log_error("image detach", failure);
        }
        crate::exposure::page_reloaded(window, &data);
        answer_close_question(&data, || close_window(window))?;
        reload_surface_documents(window)?;
        crate::modals::discard(window, &data.overlay)?;
        Ok(())
    })();
    data.view_source_events.retire();
    cleanup
}

/// Sends the first responder to the page when it changed since the last send. A page that has not reported ready receives
/// none; its ready sends the current responder (docs/spec/exposure.md#keyboard-focus). The native observation calls it on the
/// main thread, and the status is read in another thread.
fn responder_changed(window: &Window) {
    crate::exposure::window_changed(window);
    let window = window.clone();
    crate::routine::spawn_named("window-responder", move || send_responder(&window, false));
}

/// Sends the current first responder to the workbench that reported ready.
fn responder_workbench_ready(window: &Window) {
    let window = window.clone();
    crate::routine::spawn_named("window-responder", move || send_responder(&window, true));
}

fn send_responder(window: &Window, ready: bool) {
    // silent: a window whose records the close removed has no workbench that receives the responder.
    let Some(data) = window_data_if_registered(window) else {
        return;
    };
    let result = crate::responder::send_changed_responder(
        &data.responder,
        ready,
        || data.ready.load(Ordering::Relaxed),
        || crate::exposure::window_responder(window),
        |responder| {
            emit_window(window, "window-responder", responder).map_err(|error| error.to_string())
        },
        // The close of the window removes its records; a read after that finds no window.
        |_| window_data_if_registered(window).is_none(),
    );
    if let Err(error) = result {
        log_error("window responder", error);
    }
}

pub fn window_ready(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    data.ready.store(true, Ordering::Relaxed);
    for event in data.images.detach_page_ready() {
        if let Err(error) = emit_window(window, "image-detach-ended", event) {
            log_error("image-detach-ended", error);
        }
    }
    responder_workbench_ready(window);
    crate::exposure::replay_registrations(window);
    crate::exposure::windows_changed(window.app_handle());
    end_reloads(&data, Ok(()));
    crate::exposure::rewatch(window);
    crate::deep_link::ready(window.app_handle());
    emit_window(window, "page-ready", ()).map_err(|e| e.to_string())
}

/// Ends each reload of the window that waits for its new page with result: `Ok` for the ready of that page, and the error
/// that ends the reload otherwise.
pub(crate) fn end_reloads(data: &WindowData, result: Result<(), ReloadEnd>) {
    let readied = std::mem::take(
        &mut *data
            .readied
            .lock()
            // default: a lock that a panicking thread poisoned still holds the reloads, which this end drains; the panic
            // hook records the panic.
            .unwrap_or_else(PoisonError::into_inner),
    );
    for (_, ready) in readied {
        if ready.send(result.clone()).is_err() {
            crate::application_log::log_info(
                "window",
                "window readiness arrived after its request ended",
            );
        }
    }
}

/// Answers a request to close the window: a window whose page is ready asks its page with ask (`project-close-request`) and
/// stays open, and the page answers the question or its end does (`answer_close_question`). The close of a window whose page
/// is not ready is not blocked, so the window soon disappears from the runtime and is removed from the list. Returns whether
/// the window stays open.
fn close_requested(data: &WindowData, ready: bool, ask: impl FnOnce()) -> bool {
    if ready {
        data.close_asked.store(true, Ordering::SeqCst);
        ask();
        return true;
    }
    data.closing.store(true, Ordering::Relaxed);
    data.documents.views().forget_all();
    false
}

/// Ends the generation of the main page of the window in the turn of the end of the process of its page
/// (docs/spec/hosts.md#process-lifecycle): every request to the page and to its surface documents ends with 1003 and later
/// requests to those documents are refused until the next page starts, and the rest that the page owed ends (`leave_page`).
pub(crate) fn end_page(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    end_page_of(
        &window.state::<crate::exposure::Exposure>().relay,
        &data,
        window.label(),
        || removal_page_ended(window),
        || crate::surfaces::keys_page_ended(window),
        || close_window(window),
    )
}

/// Ends the page of the window data whose main page is main, as `end_page` does: removals allows the removals that asked the
/// page, keys gives the keys that waited for the decision of its workbench, and close closes the window.
fn end_page_of(
    relay: &crate::exposure::Relay,
    data: &WindowData,
    main: &str,
    removals: impl FnOnce(),
    keys: impl FnOnce() -> Result<(), String>,
    close: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    crate::exposure::end_page_requests(relay, &data.page_reloading, main);
    leave_page(data, removals, keys, close)
}

/// Asks the ready page of the window data whose main page is main to reload with emit (`ask_page_to_reload`). The event ends
/// the page, so the rest that it owed ends in the same turn (`leave_page`), as the end of the process of the page ends it.
pub(crate) fn reload_ready_page(
    relay: &crate::exposure::Relay,
    data: &WindowData,
    main: &str,
    emit: impl FnOnce() -> Result<(), String>,
    removals: impl FnOnce(),
    keys: impl FnOnce() -> Result<(), String>,
    close: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    crate::exposure::ask_page_to_reload(relay, &data.page_reloading, main, emit)?;
    data.end_page_calls(PAGE_RELOADING_END);
    leave_page(data, removals, keys, close)
}

/// Ends what a page that ended owed besides its requests: the window is no longer ready, the removals that asked it are
/// allowed (removals), the keys that waited for the decision of its workbench go (keys), and the close question that it left
/// is answered (`answer_close_question`). An end that finds nothing owed changes nothing.
fn leave_page(
    data: &WindowData,
    removals: impl FnOnce(),
    keys: impl FnOnce() -> Result<(), String>,
    close: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    data.ready.store(false, Ordering::Relaxed);
    // The page that a removal asked ended, so the removal is allowed (docs/spec/projects.md).
    removals();
    let keys = keys();
    answer_close_question(data, close)?;
    keys
}

/// Answers a close question that the window asked its page and that the page left unanswered: close closes the window as a
/// window whose page is not ready closes, because a page that ended keeps no tab, so a quit that asked the window continues.
fn answer_close_question(
    data: &WindowData,
    close: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if data.close_asked.swap(false, Ordering::SeqCst) {
        close()?;
    }
    Ok(())
}

/// Closes window through the framework.
pub(crate) fn close_window(window: &Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// Closes a window.
pub fn window_close(window: &Window) -> Result<(), String> {
    let data = window_data(window)?;
    data.ready.store(false, Ordering::Relaxed);
    data.close_asked.store(false, Ordering::SeqCst);
    window.close().map_err(|e| e.to_string())
}

/// Records that the page kept a modified tab when the window was asked to close, which ends a quit that asked the
/// window (docs/spec/hosts.md#process-lifecycle).
pub fn window_close_kept(window: &Window) -> Result<(), String> {
    window_data(window)?
        .close_asked
        .store(false, Ordering::SeqCst);
    window.state::<Windows>().quit.cancel();
    *window
        .state::<Windows>()
        .update
        .lock()
        // default: a lock that a panicking thread poisoned still holds the pending update, which the cancellation
        // clears; the panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner) = None;
    // A request of the operating system waits for its answer; the application does not quit, so the answer is the
    // cancellation.
    window
        .post(|| match platform::current() {
            Ok(platform) => platform.cancel_quit_requests(),
            Err(error) => log_error("quit request cancel", error),
        })
        .map_err(|e| e.to_string())
}

/// Handles a termination request. When a ready window exists, it blocks the termination and sends a close request to
/// each window. A quit that no ready window holds begins the quit stop of the sidecars and is blocked until that stop
/// ends; the host then asks for the quit again, which the ended stop accepts, and a request while the stop runs is the
/// second quit of the stop (docs/spec/hosts.md#process-lifecycle).
pub(crate) fn quit(app: &AppHandle, api: crate::ExitRequestApi) {
    let registry = app.state::<Windows>();
    let waiting: Vec<_> = registry
        .windows
        .lock()
        // default: a lock that a panicking thread poisoned still holds the window registry, which is only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .filter(|(_, context)| context.ready.load(Ordering::Relaxed))
        .map(|(label, _)| label.clone())
        .collect();
    // Every termination request begins the quit state, with or without a ready window (docs/spec/hosts.md#process-lifecycle).
    if registry.quit.begin_quit_request(waiting.len()) {
        // An application update or a relaunch keeps the persistent services running for the application that starts
        // next.
        let detach = registry
            .update
            .lock()
            // default: a lock that a panicking thread poisoned still holds the pending update, which is only read; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .is_some();
        let again = app.clone();
        if !app
            .state::<crate::sidecars::WindowSidecars>()
            .quit_stop(detach, move || again.quit())
        {
            api.prevent_exit();
        }
        return;
    }
    api.prevent_exit();
    for (label, window) in app.windows() {
        let result = if waiting.contains(&label) {
            if let Ok(data) = window_data(&window) {
                data.close_asked.store(true, Ordering::SeqCst);
            }
            emit_window(&window, "project-close-request", ())
        } else {
            window.close()
        };
        if let Err(error) = result {
            log_error("window quit", error);
        }
    }
}

/// The title bar height (pt) that is set when a window is created. It equals the height of the first row at frame text
/// scale 1 (--chrome-h of packages/workbench/app.css).
const INITIAL_TITLEBAR_HEIGHT: f64 = 40.0;

/// Creates the title bar of the window with its initial height. AppKit places the window buttons at the vertical center
/// of that height.
///
/// AppKit places views on the main thread. The window registration also runs outside the main thread, and waiting for
/// an answer on the main thread would stop there, so this is scheduled on the main thread. It is scheduled as soon as
/// the window is created, so it runs before the page requests the title bar height.
fn initial_titlebar(window: &Window) -> Result<(), String> {
    let target = window.clone();
    window
        .post(move || {
            // The address is read in this step, which uses the address. A window that closed before has no title bar to
            // set.
            let result = open_owner(&target).and_then(|owner| match owner {
                Some(handle) => {
                    platform::current()?.set_titlebar_height(handle, INITIAL_TITLEBAR_HEIGHT)
                }
                None => Ok(()),
            });
            if let Err(error) = result {
                log_error("window title bar", error);
            }
        })
        .map_err(|e| e.to_string())
}

/// Checks the title bar height (pt) that a surface preparation holds. The first row is between 40 pt and 108 pt, which
/// is frame text scale 3. AppKit uses a value of 0 or less to mean that there is no custom height, so such a value is
/// also outside this range.
pub fn validate_titlebar_height(height: f64) -> Result<(), String> {
    if height.is_nan() || !(32.0..=200.0).contains(&height) {
        return Err("title bar height must be a finite number from 32 through 200 points".into());
    }
    Ok(())
}

/// Creates the title bar of the window with height (pt) and returns the window button area and the title bar height
/// after it. A surface preparation calls it on the main thread inside the placement transaction of the window, so the
/// new height reaches the screen together with the commit of that transaction. A window in full screen does not change
/// the height and returns row 0.
pub(crate) fn titlebar_chrome(handle: Handle, height: f64) -> Result<TitlebarChange, String> {
    let platform = platform::current()?;
    let previous = platform.titlebar_height(handle)?;
    platform.set_titlebar_height(handle, height)?;
    let (x, y, w, h) = platform.window_controls(handle)?;
    Ok(TitlebarChange {
        chrome: Chrome {
            controls: Rect { x, y, w, h },
            row: platform.titlebar_height(handle)?,
        },
        previous,
    })
}

/// The title bar that a surface preparation set. chrome is the window value after it was set and previous is the height
/// (pt) before the preparation. It is 0 for full screen.
pub(crate) struct TitlebarChange {
    pub(crate) chrome: Chrome,
    pub(crate) previous: f64,
}

/// Restores the title bar height before the preparation. When nothing was set in full screen (0), there is nothing to
/// restore. Call it on the main thread.
pub(crate) fn restore_titlebar(handle: Handle, previous: f64) -> Result<(), String> {
    if previous <= 0.0 {
        return Ok(());
    }
    platform::current()?.set_titlebar_height(handle, previous)
}

/// The height (pt) of the first row that the first draw of the page will show. It is round(max(40, 36 × textSize)) of
/// the common setting textSize, and 40 when the setting is absent (docs/spec/native-surfaces.md#title-bar-height).
/// textSize is common only, so the page draws the first row with the same value.
pub fn start_titlebar_height(common: &serde_json::Value) -> Result<f64, String> {
    let Some(value) = common.get("textSize") else {
        return Ok(INITIAL_TITLEBAR_HEIGHT);
    };
    let Some(factor) = value.as_f64() else {
        return Err(format!(
            "common setting textSize must be a number, not {}",
            crate::arguments::kind(value)
        ));
    };
    if !(0.5..=3.0).contains(&factor) {
        return Err("common setting textSize must be from 0.5 through 3".into());
    }
    Ok((36.0 * factor).max(INITIAL_TITLEBAR_HEIGHT).round())
}

/// Before it answers the start document, sets the title bar of the window to the first row height of the common
/// setting. A new window that is not visible yet is set at once, and a window that shows the previous page is set
/// inside the start transaction of a new ticket and committed together with the first presentation of the new page
/// (docs/spec/native-surfaces.md#title-bar-height). A window in full screen does not change the height.
pub(crate) fn start_titlebar(window: &Window, common: &serde_json::Value) -> Result<(), String> {
    let height = start_titlebar_height(common)?;
    let handle = native_owner(window)?;
    let ticket = window_data(window)?
        .running
        .prepared
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    crate::exposure::on_main(window, move || {
        platform::current()?.start_page_titlebar(
            handle,
            ticket,
            height,
            Box::new(move |result| {
                if tx.send(result).is_err() {
                    crate::application_log::log_info(
                        "window",
                        "the start title bar result arrived after its request ended",
                    );
                }
            }),
        )
    })?;
    rx.recv().map_err(|e| e.to_string())?
}

/// The values of the window that the page uses to draw the first line. controls is the window button area and row is
/// the title bar height (pt). row is 0 when there is no title bar, as in full screen.
#[derive(Clone, Serialize)]
pub struct Chrome {
    controls: Rect,
    row: f64,
}

/// Returns the window button area and the title bar height.
pub fn window_chrome(window: &Window) -> Result<Chrome, String> {
    let controls = window_controls(window)?;
    let handle = native_owner(window)?;
    let row =
        crate::exposure::on_main(window, move || platform::current()?.titlebar_height(handle))?;
    Ok(Chrome { controls, row })
}

/// Returns the area that the window buttons occupy in page coordinates. The page leaves that area empty in its first
/// line.
pub(crate) fn window_controls(window: &Window) -> Result<Rect, String> {
    let handle = native_owner(window)?;
    // The window buttons belong to the main thread, and the start document reads them off it.
    let (x, y, w, h) =
        crate::exposure::on_main(window, move || platform::current()?.window_controls(handle))?;
    Ok(Rect { x, y, w, h })
}

#[cfg(test)]
#[path = "windows_records_test.rs"]
mod records_test;

#[cfg(test)]
#[path = "page_end_test.rs"]
mod page_end_test;

#[cfg(test)]
#[path = "windows_removal_end_test.rs"]
mod removal_end_test;

#[cfg(test)]
#[path = "windows_ends_test.rs"]
mod ends_test;

#[cfg(test)]
#[path = "../tests/project_data_order/project_data_order_test.rs"]
mod project_data_order_test;
