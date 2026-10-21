//! Display, placement, content update, ready check, choice delivery and close of native modals.
//!
//! The [data-native-modal] element of the page is drawn by a child webview inside the main window.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::webview::Color;
use tauri::{LogicalPosition, LogicalSize, Webview, WebviewBuilder, WebviewUrl, Window};

use crate::application_log::{log_error, log_failure};
use crate::documents;
use crate::exposure;
use crate::platform;
use crate::surfaces::{PageFocus, Rect, aligned, isolate_webview};
use crate::windows::{emit_window, root_view, window_data};

/// The values that are needed to show a [data-native-modal] element in the main DOM.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayRequest {
    mode: String,
    card: Rect,
    /// The id of the element. It is used as the name of the view that draws the element.
    id: String,
    /// The accessibility name of the modal document.
    title: String,
    rect: Rect,
    class_name: String,
    html: String,
    css: String,
    /// The border color of the element composed over the backdrop. It looks the same regardless of the brightness of
    /// the surface below.
    border: String,
    /// The corner radius of the native view that draws the element.
    radius: f64,
}

/// The content that the modal webview requests after it loads.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayContent {
    mode: String,
    card: Rect,
    title: String,
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// The modal that the modal webview draws now.
///
/// The page shows one [data-native-modal] element at a time and closes it before it shows the next, so one record
/// stores the modal id too.
#[derive(Debug, Clone, Default)]
struct Modal {
    instance: u64,
    /// The id of the element. The main DOM callback sends this value with every call.
    id: String,
    content: OverlayContent,
    /// It increases whenever the content or the position changes. The modal page discards a value older than this.
    revision: u64,
    radius: f64,
    /// The rectangle in page coordinates. It is also used for the corner setting.
    at: Rect,
    /// Shows whether the webview is shown and passed the keyboard focus. host.window reports this value.
    visible: bool,
}

/// The modal webview inside the main window and the modal that the webview shows.
#[derive(Default)]
pub(crate) struct Overlay {
    pub view: Mutex<Option<Webview>>,
    open: Mutex<Option<Modal>>,
    next: AtomicU64,
}

impl Overlay {
    /// Returns the element id, the mode and the visibility of the open modal.
    pub fn open_state(&self) -> Option<(String, String, bool)> {
        // default: a lock that a panicking thread poisoned still holds the modal record, which is only read; the panic
        // hook records the panic.
        let open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.as_ref()
            .map(|modal| (modal.id.clone(), modal.content.mode.clone(), modal.visible))
    }

    /// Returns whether the open modal is in dialog mode.
    pub fn dialog(&self) -> bool {
        // default: a lock that a panicking thread poisoned still holds the modal record, which is only read; the panic
        // hook records the panic.
        let open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        open.as_ref().is_some_and(|m| m.content.mode == "dialog")
    }

    /// Removes the modal record and the modal webview.
    pub fn discard(&self) -> Result<(), String> {
        // default: a lock that a panicking thread poisoned still holds the modal record, which this call removes; the
        // panic hook records the panic.
        *self.open.lock().unwrap_or_else(PoisonError::into_inner) = None;
        let view = self
            .view
            .lock()
            // default: a lock that a panicking thread poisoned still holds the modal webview, which this call removes;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(view) = view {
            set_background(&view.window(), false)?;
            view.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// The new position of an open modal webview. The card decides the position, and this request is passed by the handle
/// drag.
#[derive(Debug, Deserialize)]
pub(crate) struct PlaceRequest {
    id: String,
    rect: Rect,
    card: Rect,
}

#[derive(Clone, Serialize)]
struct ModalPosition {
    id: String,
    instance: u64,
    revision: u64,
    card: Rect,
}

/// The new content of an open modal. It holds only the element content that the page measured. An open modal keeps its
/// position and size. The content fields are in the same object as id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRequest {
    id: String,
    mode: String,
    card: Rect,
    title: String,
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// The new content of one modal that the modal page receives.
#[derive(Clone, Serialize)]
struct ModalContentEvent {
    instance: u64,
    id: String,
    revision: u64,
    content: OverlayContent,
}

/// The content of a modal and the change number of that content.
#[derive(Debug, Default, Serialize)]
pub(crate) struct RevisedContent {
    revision: u64,
    content: OverlayContent,
}

/// The control that the modal page reports and its value. It uses named fields instead of a pair. Reading a pair by
/// index once read the first character of a string as the whole answer.
#[derive(Debug, Clone, Serialize)]
struct Picked {
    id: String,
    key: String,
    value: String,
}

/// Sets the modal backdrop state on the main webview and the surface webviews of a window.
pub(crate) fn set_background(window: &Window, enabled: bool) -> Result<(), String> {
    documents::set_background(window, enabled);
    for view in window.webviews() {
        if view.label() == window.label() || view.label().starts_with("surface-") {
            view.eval(format!("window.__soksakBackground = {enabled}"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Places the modal webview at content coordinates.
fn place_overlay(view: &Webview, at: Rect) -> Result<(), String> {
    let platform = platform::current()?;
    view.with_webview(move |webview| {
        log_failure(
            "modal place",
            platform.place_webview(&webview, at.x, at.y, at.w, at.h),
        )
    })
    .map_err(|e| e.to_string())
}

/// Draws one modal element in a webview inside the main window. The view stays hidden until the document reports that
/// it drew the content.
pub(crate) fn show(window: &Window, request: OverlayRequest) -> Result<Rect, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    // Removes the previous native view. A unique number is assigned to every display, so a message that the previous
    // document of the same id sent late does not affect the next display.
    state.discard()?;
    let instance = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y, w, h) = aligned(
        request.rect.x,
        request.rect.y,
        request.rect.w.max(1.0),
        request.rect.h.max(1.0),
        scale,
    );
    let at = Rect { x, y, w, h };
    let mut target = root_view(window)
        .ok_or("the main webview is gone")?
        .url()
        .map_err(|e| e.to_string())?;
    target.set_path("/overlay.html");
    target.set_query(None);
    target
        .query_pairs_mut()
        .append_pair("id", &request.id)
        .append_pair("instance", &instance.to_string());
    // default: a lock that a panicking thread poisoned still holds the modal record, which this call replaces; the
    // panic hook records the panic.
    *state.open.lock().unwrap_or_else(PoisonError::into_inner) = Some(Modal {
        id: request.id.clone(),
        instance,
        content: OverlayContent {
            mode: request.mode.clone(),
            card: request.card,
            title: request.title,
            css: request.css,
            class_name: request.class_name,
            html: request.html,
            border: request.border,
        },
        revision: 1,
        radius: request.radius,
        at,
        visible: false,
    });
    let built = window.add_child(
        WebviewBuilder::new(
            format!("modal-{}-{instance}", window.label()),
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .background_color(Color(0, 0, 0, 0))
        .focused(false),
        LogicalPosition::new(x, y),
        LogicalSize::new(0.0, 0.0),
    );
    let view = match built {
        Ok(view) => view,
        Err(error) => {
            // default: a lock that a panicking thread poisoned still holds the modal record, which this removal
            // clears; the panic hook records the panic.
            *state.open.lock().unwrap_or_else(PoisonError::into_inner) = None;
            return Err(error.to_string());
        }
    };
    isolate_webview(&view, PageFocus::Ignored)?;
    view.hide().map_err(|e| e.to_string())?;
    place_overlay(&view, at)?;
    view.set_auto_resize(request.mode == "dialog")
        .map_err(|e| e.to_string())?;
    // default: a lock that a panicking thread poisoned still holds the modal webview, which this call stores; the
    // panic hook records the panic.
    *state.view.lock().unwrap_or_else(PoisonError::into_inner) = Some(view.clone());
    if let Err(error) = view.navigate(target) {
        let close_error = view.close().err();
        // default: a lock that a panicking thread poisoned still holds the modal webview, which this removal clears;
        // the panic hook records the panic.
        *state.view.lock().unwrap_or_else(PoisonError::into_inner) = None;
        // default: a lock that a panicking thread poisoned still holds the modal record, which this removal clears; the
        // panic hook records the panic.
        *state.open.lock().unwrap_or_else(PoisonError::into_inner) = None;
        return Err(match close_error {
            Some(close_error) => format!("{error}; modal close failed: {close_error}"),
            None => error.to_string(),
        });
    }
    Ok(at)
}

/// Moves and resizes the open modal webview and returns the rectangle that was applied.
///
/// The applied rectangle is the page rectangle fitted to display pixels. The two values differ, so the difference is
/// reported to the page.
pub(crate) fn place(window: &Window, request: PlaceRequest) -> Result<Rect, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let current = state
        .open
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal record, which is only read; the panic
        // hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_some_and(|m| m.id == request.id);
    let Some(view) = state
        .view
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal webview, which is only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .filter(|_| current)
    else {
        return Ok(Rect::default());
    };
    let (x, y, w, h) = aligned(
        request.rect.x,
        request.rect.y,
        request.rect.w.max(1.0),
        request.rect.h.max(1.0),
        scale,
    );
    let at = Rect { x, y, w, h };
    place_overlay(&view, at)?;
    if let Some(modal) = state
        .open
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal record, which this call amends; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .as_mut()
        .filter(|m| m.id == request.id)
    {
        modal.at = at;
        modal.content.card = request.card;
        modal.revision += 1;
        let position = ModalPosition {
            id: modal.id.clone(),
            instance: modal.instance,
            revision: modal.revision,
            card: request.card,
        };
        emit_window(window, "modal-position", position).map_err(|e| e.to_string())?;
    }
    Ok(at)
}

/// Returns the modal content when id and instance equal the current modal. For another modal it returns empty content
/// with number 0, and the modal page discards it.
pub(crate) fn content(
    window: &Window,
    id: String,
    instance: u64,
) -> Result<RevisedContent, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let content = state
        .open
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal record, which is only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .filter(|modal| modal.id == id && modal.instance == instance)
        .map(|modal| RevisedContent {
            revision: modal.revision,
            content: modal.content.clone(),
        })
        // default: a request of another modal is answered with empty content of number 0, and the modal page discards
        // it (the description above).
        .unwrap_or_default();
    // When a check holds the response, it is not sent until it is released.
    #[cfg(feature = "diagnostics")]
    crate::diagnostics::hold_modal_content(window.label());
    Ok(content)
}

/// What a ready request of a modal does, decided from the open modal record.
#[derive(Debug, PartialEq)]
enum ReadyStep {
    /// No open modal has the id and instance, so the request came from a document that was removed. It changes nothing.
    Stale,
    /// The open modal is visible already, and the request reports a new render of its document.
    Visible,
    /// The open modal is not visible yet, so it is shown with this mode and radius.
    Show { dialog: bool, radius: f64 },
}

/// Decides what a ready request of the modal of id and instance does.
fn ready_step(overlay: &Overlay, id: &str, instance: u64) -> Result<ReadyStep, String> {
    // default: a lock that a panicking thread poisoned still holds the modal record, which is only read; the panic
    // hook records the panic.
    let held = overlay.open.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(modal) = held
        .as_ref()
        .filter(|m| m.id == id && m.instance == instance)
    else {
        return Ok(ReadyStep::Stale);
    };
    if modal.visible {
        return Ok(ReadyStep::Visible);
    }
    Ok(ReadyStep::Show {
        dialog: modal.content.mode == "dialog",
        radius: modal.radius,
    })
}

/// Sets the visible flag of the open modal of id and instance. It is an error when that modal is no longer open.
fn mark_visible(overlay: &Overlay, id: &str, instance: u64) -> Result<(), String> {
    // default: a lock that a panicking thread poisoned still holds the modal record, which this call amends; the
    // panic hook records the panic.
    let mut held = overlay.open.lock().unwrap_or_else(PoisonError::into_inner);
    let modal = held
        .as_mut()
        .filter(|m| m.id == id && m.instance == instance)
        .ok_or_else(|| {
            format!("modal ready: {id} instance {instance} is no longer the open modal")
        })?;
    modal.visible = true;
    Ok(())
}

/// Shows the modal webview when the document of this display has rendered. The webview is shown, focused and marked
/// visible on the main thread before the request is answered, so a window status read after the answer reports the
/// modal as visible. A request for a modal that is not open is stale: it changes nothing, answers ok and writes
/// `host.trace.modal.stale-ready`. It is an error when showing the modal fails.
pub(crate) fn ready(window: &Window, id: String, instance: u64) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let (dialog, radius) = match ready_step(state, &id, instance)? {
        ReadyStep::Stale => {
            crate::event_record::emit_host(
                soksak_sok::event_log::Level::Debug,
                "host.trace.modal.stale-ready",
                serde_json::json!({"modal": id, "instance": instance}),
            );
            return Ok(());
        }
        ReadyStep::Visible => {
            emit_window(window, "modal-rendered", &id).map_err(|e| e.to_string())?;
            exposure::note(window, &format!("observe: modal rendered {id}"));
            return Ok(());
        }
        ReadyStep::Show { dialog, radius } => (dialog, radius),
    };
    let view = state
        .view
        .lock()
        // default: a lock that a panicking thread poisoned still holds the modal webview, which is only read; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .ok_or("modal webview is gone")?;
    let platform = platform::current()?;
    set_background(window, dialog)?;
    exposure::with_view(&view, move |webview| {
        log_failure("modal corners", platform.round_corners(webview, radius));
        log_failure("modal raise", platform.raise_webview(webview));
        Ok(())
    })?;
    view.show().map_err(|e| e.to_string())?;
    exposure::with_view(&view, move |webview| platform.focus_webview(webview))?;
    mark_visible(state, &id, instance)?;
    if let Err(error) = emit_window(window, "modal-rendered", &id) {
        log_error("modal-rendered", error);
    }
    exposure::note(window, &format!("observe: modal rendered {id}"));
    exposure::window_changed(window);
    Ok(())
}

/// Closes the modal of id if it is open and returns the focus to the main webview.
pub(crate) fn hide(window: &Window, id: String) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    {
        // default: a lock that a panicking thread poisoned still holds the modal record, which this call removes; the
        // panic hook records the panic.
        let mut held = state.open.lock().unwrap_or_else(PoisonError::into_inner);
        if !matches!(held.as_ref(), Some(modal) if modal.id == id) {
            return Ok(());
        }
        *held = None;
    }
    // `discard` also clears the open record. It is not called while holding the same mutex. Otherwise the main thread
    // waits for its own lock and stops the handling of every endpoint request.
    state.discard()?;
    exposure::window_changed(window);
    // The terminal image region reports `resignFirstResponder` synchronously. Calling `set_focus` here re-enters the
    // main WebView while the current Tauri invoke still owns the WebKit dispatch lock, so the focus callback can
    // deadlock the event loop. The focus is restored in the next AppKit turn after the hide command returns. A
    // replacement modal may have opened before that turn. In that case the earlier restoration must not take the focus
    // of the replacement child WebView.
    let host = window.clone();
    platform::current()?
        .enqueue_ui(Box::new(move || {
            let has_modal = window_data(&host)
                // default: a closed window has no overlay state and no root view to focus, so the restoration finds no modal.
                .ok()
                .and_then(|context| context.overlay.open_state())
                .is_some();
            if has_modal {
                return;
            }
            if let Some(main) = root_view(&host)
                && let Err(error) = main.set_focus()
            {
                log_error("modal focus restoration", error);
            }
        }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Passes the choice of the current modal document to the page. The previous document can send its answer even after
/// its view was removed, so id and instance are checked.
pub(crate) fn pick(
    window: &Window,
    id: String,
    instance: u64,
    key: String,
    value: String,
) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    // default: a lock that a panicking thread poisoned still holds the modal record, which is only read; the panic
    // hook records the panic.
    let open = state
        .open
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map(|m| OpenModal {
            id: m.id.clone(),
            instance: m.instance,
        });
    if let Some(fields) = dropped_pick(open.as_ref(), &id, instance, &key) {
        crate::event_record::emit_host(
            soksak_sok::event_log::Level::Info,
            "host.overlay.dropped",
            fields,
        );
        return Ok(());
    }
    if root_view(window).is_none() {
        return Err(format!(
            "overlay pick: the window {} has no page",
            window.label()
        ));
    }
    emit_window(window, "overlay-pick", Picked { id, key, value }).map_err(|e| e.to_string())?;
    Ok(())
}

/// Names the modal that a window shows: the id of its element and its instance.
pub struct OpenModal {
    pub id: String,
    pub instance: u64,
}

/// Tells whether the reply of the modal `id` and `instance` is dropped because that modal is not the open one (a closing
/// modal still sends its last state report), and returns the fields of its record `host.overlay.dropped`.
pub fn dropped_pick(
    open: Option<&OpenModal>,
    id: &str,
    instance: u64,
    key: &str,
) -> Option<serde_json::Value> {
    if open.is_some_and(|modal| modal.id == id && modal.instance == instance) {
        return None;
    }
    let shown = open.map_or("", |modal| modal.id.as_str());
    Some(serde_json::json!({"id": id, "instance": instance, "key": key, "open": shown}))
}

/// Changes the content of an open modal without recreating the view. A modal with a control that changes the page state
/// is redrawn while it is open, and recreating the view would make it flicker.
pub(crate) fn update(window: &Window, request: UpdateRequest) -> Result<(), String> {
    let context = window_data(window)?;
    let overlay = &context.overlay;

    let content = OverlayContent {
        mode: request.mode,
        card: request.card,
        title: request.title,
        css: request.css,
        class_name: request.class_name,
        html: request.html,
        border: request.border,
    };
    let (instance, revision) = {
        // default: a lock that a panicking thread poisoned still holds the modal record, which this call amends; the
        // panic hook records the panic.
        let mut held = overlay.open.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(modal) = held.as_mut().filter(|m| m.id == request.id) else {
            return Ok(());
        };
        modal.content = content.clone();
        modal.revision += 1;
        (modal.instance, modal.revision)
    };
    // Every page receives the event, so it includes id, and each modal page uses only its own event.
    emit_window(
        window,
        "modal-content",
        ModalContentEvent {
            instance,
            id: request.id,
            revision,
            content,
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{Modal, Overlay, OverlayContent};
    use std::sync::PoisonError;
    use crate::event_log;
    use crate::event_record::use_host_event_log;
    use std::sync::Arc;
    use std::time::Duration;

    // contract: modal.state.poisoned-lock-is-recovered
    #[test]
    fn a_poisoned_modal_record_is_recovered_when_it_is_read() {
        let config = crate::test_folder::Folder::new();
        let writer = Arc::new(event_log::start_host(config.path()).unwrap());
        use_host_event_log(Some(Arc::clone(&writer)));
        let overlay = Overlay::default();
        // default: the test poisons the lock afterwards, so the read recovers the poisoned state; the panic hook
        // records the panic.
        *overlay.open.lock().unwrap_or_else(PoisonError::into_inner) = Some(Modal {
            id: "ask".to_string(),
            content: OverlayContent {
                mode: "dialog".to_string(),
                ..Default::default()
            },
            ..Default::default()
        });
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    // default: the test holds the lock while its thread panics, which poisons the lock for the
                    // operation under test.
                    let _held = overlay.open.lock().unwrap_or_else(PoisonError::into_inner);
                    panic!("modal record holder panicked");
                })
                .join()
                .unwrap_err();
        });
        let state = overlay.open_state();
        assert_eq!(
            state.map(|(id, mode, _)| (id, mode)),
            Some(("ask".to_string(), "dialog".to_string())),
            "the open modal was lost while the modal record lock was poisoned"
        );
        assert!(
            overlay.dialog(),
            "the mode of the open modal was lost while the modal record lock was poisoned"
        );
        writer.flush(Duration::from_secs(5)).unwrap();
        use_host_event_log(None);
        let text = std::fs::read_to_string(writer.path()).unwrap();
        let errors = text
            .lines()
            .filter(|line| line.contains("host.record.error") && line.contains("modal state"))
            .count();
        assert_eq!(errors, 0, "log {text}");
    }
}

#[cfg(test)]
#[path = "modals_readiness_test.rs"]
mod readiness_test;
