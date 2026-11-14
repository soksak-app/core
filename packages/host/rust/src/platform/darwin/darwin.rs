//! The macOS implementation.
//!
//! The window, webview, surface placement, input, capture and Dock functions call the native/darwin library and the
//! public AppKit interface. The local endpoint is a Unix domain socket. Pointer routing uses one private WebKit input
//! API in native/darwin.

use std::fs::Metadata;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
#[path = "ui_queue.rs"]
mod ui_queue;
use std::path::Path;

use crate::framework::PlatformWebview;
use crate::framework::Window;
use serde_json::Value;

#[cfg(feature = "diagnostics")]
use super::DocumentViewportMarker;
use super::{
    CoreRootHost, CoreRootResolver, DOMOverlay, Delivery, DocumentOptions, Frame, FullscreenResult,
    Handle, Hit, ImagePresentation, ImageReleased, Insets, Key, Listener, NativeEventWait,
    OutputEnd, OutputPipe, PersistentStream, Platform, Pointer, ProcessFootprint, Raster,
    TextInput, WindowOverlay,
};

#[cfg(feature = "diagnostics")]
#[path = "capture.rs"]
mod capture;
#[path = "child_process.rs"]
mod child_process;
#[cfg(test)]
#[path = "child_process_test.rs"]
mod child_process_test;
#[path = "clipboard.rs"]
mod clipboard;
#[path = "diagnostic_reports.rs"]
mod diagnostic_reports;
#[path = "dock.rs"]
mod dock;
#[path = "document.rs"]
mod document;
#[path = "endpoint.rs"]
mod endpoint;
#[path = "identity.rs"]
mod identity;
#[path = "image.rs"]
mod image;
#[path = "input.rs"]
mod input;
#[cfg(feature = "diagnostics")]
#[path = "input_reference.rs"]
mod input_reference;
#[cfg(all(test, feature = "diagnostics"))]
#[path = "input_reference_test.rs"]
mod input_reference_test;
#[cfg(feature = "diagnostics")]
#[path = "input_source.rs"]
mod input_source;
#[path = "layout.rs"]
mod layout;
#[path = "link.rs"]
mod link;

#[path = "connection_activity.rs"]
mod connection_activity;
#[path = "events.rs"]
mod events;
#[path = "file_watch.rs"]
mod file_watch;
#[path = "memory_pressure.rs"]
mod memory_pressure;
#[path = "mouse_buttons.rs"]
mod mouse_buttons;
mod notifications;
#[cfg(feature = "diagnostics")]
#[path = "page_objects.rs"]
mod page_objects;
#[path = "private_files.rs"]
mod private_files;
#[cfg(feature = "diagnostics")]
#[path = "process_exit.rs"]
mod process_exit;
mod process_footprint;
#[path = "shapes.rs"]
mod shapes;
#[path = "stall_sample.rs"]
mod stall_sample;
#[path = "standard_error.rs"]
mod standard_error;
pub(crate) use standard_error::end_on_exception;
#[path = "system.rs"]
mod system;
#[path = "termination.rs"]
mod termination;
#[path = "webview.rs"]
mod webview;
#[path = "window.rs"]
mod window;
#[cfg(feature = "diagnostics")]
#[path = "window_objects.rs"]
mod window_objects;

/// The point that AppKit returns for the event location. It is declared because objc2 must know the layout of the
/// message return value.
#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}

unsafe impl objc2::Encode for NSPoint {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("CGPoint", &[<f64 as objc2::Encode>::ENCODING; 2]);
}

/// A rectangle in AppKit coordinates. It is declared for the same reason as NSPoint.
#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSPoint,
}

impl From<Frame> for NSRect {
    fn from((x, y, w, h): Frame) -> Self {
        NSRect {
            origin: NSPoint { x, y },
            size: NSPoint { x: w, y: h },
        }
    }
}

unsafe impl objc2::Encode for NSRect {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSPoint::ENCODING]);
}

/// The macOS platform implementation.
pub struct Darwin;

impl CoreRootHost for Darwin {
    fn set_core_root(&self, resolve: CoreRootResolver) -> Result<(), String> {
        document::set_core_root(resolve)
    }

    fn set_view_import_map(&self, map: &str) -> Result<(), String> {
        document::set_view_import_map(map)
    }
}

impl Platform for Darwin {
    fn enqueue_ui(&self, work: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        ui_queue::enqueue(work);
        Ok(())
    }
    fn window_handle(&self, window: &Window) -> Result<Handle, String> {
        window::handle(window)
    }
    fn set_main_webview(&self, window: Handle, main: Handle) -> Result<(), String> {
        window::set_main_webview(window, main)
    }
    fn reveal_after_load(&self, window: Handle) -> Result<(), String> {
        window::reveal_after_load(window)
    }
    fn place_new_window(&self, window: Handle) -> Result<(), String> {
        window::place_new_window(window)
    }
    fn show_window(&self, window: Handle) -> Result<(), String> {
        window::show_window(window)
    }
    fn set_main_appearance(&self, view: &PlatformWebview, dark: bool) -> Result<(), String> {
        webview::set_main_appearance(view, dark)
    }
    fn observe_occlusion(&self, window: Handle, changed: Box<dyn Fn(bool)>) -> Result<(), String> {
        window::observe_occlusion(window, changed)
    }
    fn observe_responder(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<Handle, String> {
        window::observe_responder(window, changed)
    }
    fn end_responder_observation(&self, observation: Handle) {
        window::end_responder_observation(observation)
    }
    fn observe_cursor(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<Handle, String> {
        input::observe_cursor(window, changed)
    }
    fn end_cursor_observation(&self, observation: Handle) {
        input::end_cursor_observation(observation)
    }
    fn observe_sheet(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<Handle, String> {
        window::observe_sheet(window, changed)
    }
    fn end_sheet_observation(&self, observation: Handle) {
        window::end_sheet_observation(observation)
    }
    fn hold_dialogs(
        &self,
        window: Handle,
        requested: Box<dyn Fn(u64, String)>,
    ) -> Result<Handle, String> {
        window::hold_dialogs(window, requested)
    }
    fn release_dialogs(&self, hold: Handle) {
        window::release_dialogs(hold)
    }
    fn answer_dialog(
        &self,
        request: u64,
        paths: Vec<String>,
        cancel: bool,
        answered: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) {
        window::answer_dialog(request, paths, cancel, answered)
    }

    fn fullscreen(
        &self,
        window: Handle,
        on: bool,
        done: Box<dyn Fn(FullscreenResult, String)>,
    ) -> Result<(), String> {
        window::fullscreen(window, on, done)
    }
    fn titlebar_height(&self, window: Handle) -> Result<f64, String> {
        window::titlebar_height(window)
    }
    fn set_titlebar_height(&self, window: Handle, height: f64) -> Result<(), String> {
        window::set_titlebar_height(window, height)
    }
    fn window_controls(&self, window: Handle) -> Result<Frame, String> {
        Ok(window::controls(window))
    }
    #[cfg(feature = "diagnostics")]
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String> {
        Ok(window::numbers(window::handle(window)?))
    }
    fn hit(&self, window: Handle, x: f64, y: f64) -> Result<Hit, String> {
        input::hit(window, x, y)
    }
    fn window_facts(&self, window: Handle) -> Result<Value, String> {
        window::facts(window)
    }
    fn window_on_screen(&self, window: Handle) -> Result<bool, String> {
        window::on_screen(window)
    }

    #[cfg(feature = "diagnostics")]
    fn window_color_space(&self, window: Handle) -> Result<Value, String> {
        window::color_space(window)
    }
    fn process_footprint(&self, pid: u32) -> Result<ProcessFootprint, String> {
        process_footprint::process_footprint(pid)
    }
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String> {
        window::move_to(window, x, y)
    }
    fn raise_window(&self, window: Handle) -> Result<(), String> {
        window::raise(window)
    }
    fn lower_window(&self, window: Handle) -> Result<(), String> {
        window::lower(window)
    }
    fn screens(&self) -> Result<Value, String> {
        window::screens()
    }
    fn stays_open_without_windows(&self) -> bool {
        true
    }

    fn place_webview(
        &self,
        view: &PlatformWebview,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        webview::place(view, x, y, w, h);
        Ok(())
    }
    fn render_occluded(&self, view: &PlatformWebview, render: bool) -> Result<(), String> {
        webview::render_occluded(view, render)
    }
    fn create_surface(&self, window: Handle) -> Result<Handle, String> {
        webview::create_surface(window)
    }
    fn close_surface(&self, surface: Handle) -> Result<(), String> {
        webview::close_surface(surface);
        Ok(())
    }
    fn place_surface(&self, surface: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        webview::place_surface(surface, x, y, w, h);
        Ok(())
    }
    fn surface_frame(&self, surface: Handle) -> Result<[f64; 4], String> {
        Ok(webview::surface_frame(surface))
    }
    fn set_surface_hidden_handle(&self, surface: Handle, hidden: bool) -> Result<(), String> {
        webview::set_surface_hidden_handle(surface, hidden);
        Ok(())
    }
    fn set_surface_alpha_handle(&self, surface: Handle, alpha: f64) -> Result<(), String> {
        webview::set_surface_alpha_handle(surface, alpha);
        Ok(())
    }
    fn set_window_overlays(&self, main: Handle, overlays: &[WindowOverlay]) -> Result<(), String> {
        webview::set_window_overlays(main, overlays);
        Ok(())
    }
    fn file_drop(&self, main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String> {
        webview::file_drop(main, receive)
    }
    fn set_surface_overlays(&self, surface: Handle, overlays: &[DOMOverlay]) -> Result<(), String> {
        webview::overlays(surface, overlays);
        Ok(())
    }

    fn sample_threads(&self, path: &std::path::Path) -> Result<(), String> {
        stall_sample::sample_threads(path)
    }

    fn stall_heartbeat(&self) -> Result<(u64, u64), String> {
        Ok(stall_sample::stall_heartbeat())
    }

    fn stall_await_awake(&self) -> Result<(), String> {
        stall_sample::stall_await_awake();
        Ok(())
    }

    fn stall_schedule(&self) -> Result<(i32, u64), String> {
        stall_sample::stall_schedule()
    }

    fn hold_connection_activity(&self, held: bool) -> Result<(), String> {
        connection_activity::hold_connection_activity(held);
        Ok(())
    }

    fn collect_garbage(&self, view: &PlatformWebview) -> Result<(), String> {
        webview::collect_garbage(view)
    }

    fn raise_webview(&self, view: &PlatformWebview) -> Result<(), String> {
        webview::raise(view);
        Ok(())
    }
    fn round_corners(&self, view: &PlatformWebview, radius: f64) -> Result<(), String> {
        webview::corners(view, radius);
        Ok(())
    }
    fn focus_webview(&self, view: &PlatformWebview) -> Result<(), String> {
        webview::focus(view)
    }
    fn focus_surface(&self, surface: Handle) -> Result<(), String> {
        webview::focus_surface(surface);
        Ok(())
    }
    fn focus_surface_for_region(&self, surface: Handle) -> Result<(), String> {
        webview::focus_surface_for_region(surface);
        Ok(())
    }
    fn focus_workbench(&self, window: Handle) -> Result<(), String> {
        webview::focus_workbench(window);
        Ok(())
    }
    fn keys_decided(&self, window: Handle) -> Result<(), String> {
        webview::keys_decided(window);
        Ok(())
    }
    fn keys_page_ended(&self, window: Handle) -> Result<(), String> {
        webview::keys_page_ended(window);
        Ok(())
    }
    fn keyboard_after_modal(&self, window: Handle) -> Result<(), String> {
        webview::keyboard_after_modal(window);
        Ok(())
    }
    fn modal_hold(&self, window: Handle) -> Result<(), String> {
        webview::modal_hold(window);
        Ok(())
    }
    fn modal_hold_end(&self, window: Handle) -> Result<(), String> {
        webview::modal_hold_end(window);
        Ok(())
    }
    fn create_document(
        &self,
        surface: Handle,
        options: DocumentOptions<'_>,
        changed: Box<dyn Fn(String)>,
    ) -> Result<Handle, String> {
        document::create(surface, options, changed)
    }
    fn set_view_message(
        &self,
        document: Handle,
        message: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        document::set_view_message(document, message)
    }
    fn set_view_ended(&self, document: Handle, ended: Box<dyn Fn() + Send>) -> Result<(), String> {
        document::set_view_ended(document, ended)
    }
    fn set_view_responsiveness(
        &self,
        document: Handle,
        responsiveness: Box<dyn Fn(bool) + Send>,
    ) -> Result<(), String> {
        document::set_view_responsiveness(document, responsiveness)
    }
    fn take_document_binary(&self, document: Handle, id: &str) -> Result<Vec<u8>, String> {
        document::take_document_binary(document, id)
    }
    fn put_document_binary(
        &self,
        document: Handle,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<String, String> {
        document::put_document_binary(document, bytes, content_type)
    }
    fn add_document_script(&self, document: Handle, source: &str) -> Result<(), String> {
        document::add_document_script(document, source)
    }
    fn set_document_message(
        &self,
        document: Handle,
        message: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        document::set_message(document, message)
    }
    fn set_document_stream(
        &self,
        document: Handle,
        stream: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        document::set_stream(document, stream)
    }
    fn set_document_stream_on(
        &self,
        document: Handle,
        stream: &str,
        on: bool,
    ) -> Result<bool, String> {
        document::set_stream_on(document, stream, on)
    }
    fn ack_document_stream(&self, document: Handle, seq: u64) -> Result<bool, String> {
        Ok(document::ack_stream(document, seq))
    }
    fn post_document(&self, document: Handle, json: &str) -> Result<bool, String> {
        document::post(document, json)
    }
    fn set_document_event(
        &self,
        document: Handle,
        event: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        document::set_event(document, event)
    }
    fn load_document(&self, document: Handle, url: &str) -> Result<bool, String> {
        document::load(document, url)
    }
    fn zoom_document(&self, document: Handle, zoom: f64) -> Result<bool, String> {
        Ok(document::zoom(document, zoom))
    }
    fn go_document(&self, document: Handle, action: i32, offset: i32) -> Result<bool, String> {
        Ok(document::go(document, action, offset))
    }
    fn query_document(
        &self,
        document: Handle,
        reply: Box<dyn FnOnce(String) + Send>,
    ) -> Result<(), String> {
        document::query(document, reply);
        Ok(())
    }
    fn document_interaction_state(&self, document: Handle) -> Result<Option<String>, String> {
        Ok(document::interaction_state(document))
    }
    fn restore_document(&self, document: Handle, state: &str) -> Result<(), String> {
        document::restore(document, state)
    }
    fn place_document(
        &self,
        document: Handle,
        insets: Insets,
        visible: bool,
    ) -> Result<(), String> {
        document::place(document, insets, visible);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn draw_documents_covered(&self, window: Handle, draw: bool) -> Result<(), String> {
        document::draw_covered(window, draw)
    }
    #[cfg(feature = "diagnostics")]
    fn document_viewport_marker(
        &self,
        document: Option<Handle>,
        enabled: bool,
    ) -> Result<DocumentViewportMarker, String> {
        document::viewport_marker(document, enabled)
    }
    fn set_document_background(&self, document: Handle, enabled: bool) -> Result<(), String> {
        document::background(document, enabled);
        Ok(())
    }
    fn set_document_appearance(&self, document: Handle, dark: bool) -> Result<(), String> {
        document::appearance(document, dark);
        Ok(())
    }
    fn close_document(&self, document: Handle) -> Result<(), String> {
        document::close(document);
        Ok(())
    }
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String> {
        Ok(webview::id(view))
    }

    fn create_image(
        &self,
        surface: Handle,
        name: &str,
        event: Box<dyn Fn(String)>,
        released: ImageReleased,
    ) -> Result<Handle, String> {
        image::create(surface, name, event, released)
    }
    fn place_image(&self, image: Handle, insets: Insets, visible: bool) -> Result<(), String> {
        image::place(
            image,
            insets.left,
            insets.top,
            insets.right,
            insets.bottom,
            visible,
        );
        Ok(())
    }
    fn image_raster(&self, image: Handle) -> Result<Option<Raster>, String> {
        Ok(image::raster(image))
    }
    fn image_surface_placed(&self, image: Handle) -> Result<bool, String> {
        Ok(image::surface_placed(image))
    }
    fn set_image_background(&self, image: Handle, enabled: bool) -> Result<(), String> {
        image::background(image, enabled);
        Ok(())
    }
    fn image_facts(&self, image: Handle) -> Result<String, String> {
        image::facts(image)
    }
    fn present_image(
        &self,
        image: Handle,
        presentation: ImagePresentation,
    ) -> Result<bool, String> {
        image::present(image, presentation)
    }
    fn focus_image(&self, image: Handle) -> Result<(), String> {
        image::focus(image);
        Ok(())
    }
    fn caret_image(&self, image: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        image::caret(image, x, y, w, h);
        Ok(())
    }
    fn text_image(&self, image: Handle, utf8: &str) -> Result<(), String> {
        image::text(image, utf8)
    }
    fn close_image(&self, image: Handle) -> Result<(), String> {
        image::close(image);
        Ok(())
    }

    fn begin_layout(
        &self,
        window: Handle,
        ticket: u64,
        ready: Box<dyn Fn(bool)>,
    ) -> Result<(), String> {
        layout::begin(window, ticket, ready);
        Ok(())
    }
    fn commit_layout(&self, window: Handle, ticket: u64) -> Result<bool, String> {
        Ok(layout::commit(window, ticket))
    }
    fn cancel_layout(&self, window: Handle) -> Result<(), String> {
        layout::cancel(window);
        Ok(())
    }
    fn cancel_layout_ticket(&self, window: Handle, ticket: u64) -> Result<(), String> {
        layout::cancel_ticket(window, ticket);
        Ok(())
    }
    fn join_view(
        &self,
        window: Handle,
        ticket: u64,
        view: Handle,
        presented: Box<dyn FnOnce() + Send>,
        ended: Box<dyn FnOnce(&str) + Send>,
    ) -> Result<Option<crate::platform::ViewAbandon>, String> {
        layout::join_view(window, ticket, view, presented, ended)
    }
    fn watch_layout_ends(&self, ended: Box<dyn Fn(Handle) + Send + Sync>) -> Result<(), String> {
        layout::watch_ends(ended);
        Ok(())
    }
    fn start_page_titlebar(
        &self,
        window: Handle,
        ticket: u64,
        height: f64,
        ready: Box<dyn Fn(Result<(), String>)>,
    ) -> Result<(), String> {
        layout::start_page(window, ticket, height, ready);
        Ok(())
    }
    fn main_presentation(&self, view: &PlatformWebview) -> Result<Handle, String> {
        Ok(layout::main_presentation(view))
    }
    fn after_settled(
        &self,
        window: Handle,
        present: Handle,
        done: Box<dyn Fn(Result<f64, String>)>,
    ) -> Result<(), String> {
        layout::after_settled(window, present, done);
        Ok(())
    }
    fn inject_settled_failure(&self) -> Result<(), String> {
        layout::inject_settled_failure();
        Ok(())
    }
    fn after_presentation(
        &self,
        view: &PlatformWebview,
        done: Box<dyn Fn()>,
    ) -> Result<(), String> {
        layout::after_presentation(view, done);
        Ok(())
    }

    fn create_shape(&self, window: Handle, frame: Frame) -> Result<Handle, String> {
        Ok(shapes::create(window, frame))
    }
    fn place_shape(&self, shape: Handle, frame: Frame) -> Result<(), String> {
        shapes::place(shape, frame);
        Ok(())
    }
    fn style_shape(
        &self,
        shape: Handle,
        radius: f64,
        line_width: f64,
        fill: [f64; 4],
        line: [f64; 4],
    ) -> Result<(), String> {
        shapes::style(shape, radius, line_width, fill, line);
        Ok(())
    }
    fn destroy_shape(&self, shape: Handle) -> Result<(), String> {
        shapes::destroy(shape);
        Ok(())
    }

    fn register_input(&self, view: &PlatformWebview) -> Result<bool, String> {
        Ok(input::register(view))
    }
    fn unregister_input(&self, view: &PlatformWebview) -> Result<(), String> {
        input::unregister(view);
        Ok(())
    }
    fn ignore_page_focus(&self, view: &PlatformWebview) -> Result<bool, String> {
        Ok(input::ignore_page_focus(view))
    }
    fn watch_input(
        &self,
        window: Handle,
        pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
        pointed: Box<dyn Fn(u8, f64, f64)>,
    ) -> Result<Handle, String> {
        Ok(input::watch(window, pressed, pointed))
    }
    fn unwatch_input(&self, monitor: Handle) -> Result<(), String> {
        input::unwatch(monitor);
        Ok(())
    }
    fn input_pointer(
        &self,
        window: Handle,
        pointer: Pointer,
        done: Box<dyn FnOnce(Delivery) + Send>,
    ) -> Result<(), String> {
        input::pointer(window, pointer, done);
        Ok(())
    }
    fn input_activate(
        &self,
        window: Handle,
        x: f64,
        y: f64,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String> {
        input::activate(window, x, y, done);
        Ok(())
    }
    fn input_key(&self, window: Handle, key: &Key) -> Result<Delivery, String> {
        input::key(window, key)
    }
    fn input_text(&self, window: Handle, text: &TextInput) -> Result<Delivery, String> {
        input::text(window, text)
    }

    #[cfg(feature = "diagnostics")]
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String> {
        capture::open(window_number, display)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_start(
        &self,
        directory: &str,
        gap: f64,
        seconds: f64,
        frames: i32,
        token: u64,
    ) -> Result<(), String> {
        capture::start(directory, gap, seconds, frames, token)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_stop(&self, after: f64, token: u64) -> Result<i32, String> {
        capture::stop(after, token)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_end_wait(&self, token: u64, reason: &str) {
        capture::end_wait(token, reason);
    }
    #[cfg(feature = "diagnostics")]
    fn capture_hold_new_window(&self) -> Result<(), String> {
        capture::hold_new_window()
    }
    #[cfg(feature = "diagnostics")]
    fn capture_wait_new_window(&self, token: u64) -> Result<isize, String> {
        capture::wait_new_window(token)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_release_new_window(&self) {
        capture::release_new_window();
    }
    #[cfg(feature = "diagnostics")]
    fn capture_missed(&self) -> Result<i32, String> {
        Ok(capture::missed())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_late(&self) -> Result<i32, String> {
        Ok(capture::late())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_longest_gap(&self) -> Result<f64, String> {
        Ok(capture::longest_gap())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_clock(&self) -> Result<f64, String> {
        Ok(capture::clock())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_still(&self, window_number: isize, path: &str) -> Result<(), String> {
        capture::still(window_number, path)
    }
    #[cfg(feature = "diagnostics")]
    fn delivered_notifications(&self, done: Box<dyn FnOnce(String) + Send>) -> Result<(), String> {
        capture::delivered_notifications(done);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn window_objects_when(
        &self,
        expected: Option<super::WindowObjects>,
        done: Box<dyn FnOnce(super::WindowObjects, bool) + Send>,
    ) -> Result<super::WaitEnd, String> {
        Ok(window_objects::when(expected, done))
    }

    #[cfg(feature = "diagnostics")]
    fn count_page_objects(
        &self,
        view: Handle,
        document: bool,
        done: crate::object_counts::PageCountDone,
    ) -> Result<(), String> {
        page_objects::count(view, document, done);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn when_process_exited(
        &self,
        pid: i32,
        done: Box<dyn FnOnce(bool) + Send>,
    ) -> Result<super::WaitEnd, String> {
        Ok(process_exit::when_exited(pid, done))
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_start(&self) -> Result<(), String> {
        capture::layout_trace_start();
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_stop(&self) -> Result<Vec<crate::platform::LayoutRecord>, String> {
        capture::layout_trace_stop()
    }
    #[cfg(feature = "diagnostics")]
    fn input_reference(
        &self,
        window: Handle,
        action: &str,
        document: Option<&str>,
        done: Box<dyn Fn(Result<Value, String>)>,
    ) {
        input_reference::call(window, action, document, done);
    }
    #[cfg(feature = "diagnostics")]
    fn end_input_reference_wait(&self, window: Handle, reason: &str) {
        input_reference::end(window, reason);
    }
    #[cfg(feature = "diagnostics")]
    fn input_source(&self) -> Result<(Option<String>, String), String> {
        input_source::current()
    }
    #[cfg(feature = "diagnostics")]
    fn select_input_source(
        &self,
        role: &str,
        adopted: Box<dyn Fn(Result<(), String>)>,
    ) -> super::InputSourceEnd {
        input_source::select(role, adopted)
    }
    #[cfg(feature = "diagnostics")]
    fn restore_input_source(
        &self,
        source: &str,
        adopted: Box<dyn Fn(Result<(), String>)>,
    ) -> super::InputSourceEnd {
        input_source::restore(source, adopted)
    }

    fn on_termination(&self, quit: Box<dyn Fn(i32, i32) + Send>) -> Result<(), String> {
        termination::on_termination(quit)
    }
    fn on_quit_request(&self, quit: Box<dyn Fn(i32, String)>) -> Result<(), String> {
        termination::on_quit_request(quit)
    }
    fn quit_event_type(&self) -> i32 {
        termination::quit_event_type()
    }
    fn answer_quit_requests(&self) {
        termination::answer_quit_requests()
    }
    fn cancel_quit_requests(&self) {
        termination::cancel_quit_requests()
    }
    fn on_memory_pressure(&self, report: crate::memory_pressure::Report) -> Result<(), String> {
        memory_pressure::start(report)
    }
    fn inject_memory_pressure(&self, level: &str) -> Result<(), String> {
        memory_pressure::inject(level)
    }
    fn instant_window_resize(&self) -> Result<(), String> {
        window::instant_resize();
        Ok(())
    }
    fn pull_native_events(&self, buffer: &mut [u8]) -> Result<usize, String> {
        events::pull(buffer)
    }
    fn native_event_wake(&self) -> Result<NativeEventWait, String> {
        events::wake()
    }
    fn take_native_event_loss(&self, channel: u8) -> Result<(u64, u64), String> {
        events::take_loss(channel)
    }
    fn set_native_event_policy(&self, levels: [i8; 5]) -> Result<(), String> {
        events::set_policy(levels)
    }
    fn watch_file(
        &self,
        path: &std::path::Path,
        changed: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        file_watch::watch_file(path, changed)
    }
    fn monotonic_ns(&self) -> Result<u64, String> {
        events::monotonic_ns()
    }
    fn set_event_boot(&self, boot: &str) -> Result<(), String> {
        events::set_boot(boot)
    }
    fn flush_native_observers(&self) -> Result<(), String> {
        events::flush_native_observers()
    }
    fn observe_activity(&self) -> Result<(), String> {
        events::observe_activity()
    }
    fn replace_standard_error(&self, file: &std::fs::File) -> Result<(), String> {
        standard_error::replace(file)
    }
    fn install_fatal_handlers(&self) -> Result<(), String> {
        standard_error::install_fatal_handlers();
        Ok(())
    }
    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String> {
        dock::install(new_window)
    }
    fn dock_items(&self) -> Result<Value, String> {
        dock::items()
    }
    fn preferred_language(&self) -> Result<String, String> {
        dock::preferred_language()
    }
    fn os_version(&self) -> Result<String, String> {
        system::os_version()
    }
    fn application_active(&self) -> Result<bool, String> {
        system::application_active()
    }

    fn menu_items(&self) -> Result<Value, String> {
        dock::menu()
    }
    fn menu_select(&self, window: Handle, menu: &str, title: &str) -> Result<(), String> {
        dock::menu_select(window, menu, title)
    }
    fn main_window(&self) -> Result<Handle, String> {
        Ok(dock::main_window())
    }
    fn dock_select(&self, title: &str) -> Result<(), String> {
        dock::select(title)
    }

    fn clipboard_read(&self, kind: &str) -> Result<super::ClipboardValue, String> {
        clipboard::read(kind)
    }
    fn clipboard_write_text(&self, text: &str) -> Result<(), String> {
        clipboard::write_text(text)
    }
    fn open_link(&self, url: &str) -> Result<(), String> {
        link::open(url)
    }
    fn diagnostic_reports_directory(&self) -> Result<std::path::PathBuf, String> {
        diagnostic_reports::directory()
    }
    fn watch_buttons(&self, changed: Box<dyn Fn(u64) + Send + Sync>) -> Result<(), String> {
        mouse_buttons::watch(changed)
    }
    fn start_notifications(
        &self,
        receive: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<(), String> {
        notifications::start(receive)
    }
    fn post_notification(&self, identifier: &str, title: &str, body: &str) -> Result<(), String> {
        notifications::post(identifier, title, body)
    }
    fn remove_notification(&self, identifier: &str) -> Result<(), String> {
        notifications::remove(identifier)
    }

    fn create_private_directories(&self, path: &Path) -> Result<(), String> {
        private_files::create_private_directories(path)
    }
    fn append_private_file(&self, path: &Path) -> Result<std::fs::File, String> {
        private_files::append_private_file(path)
    }
    fn create_private_file(&self, path: &Path) -> std::io::Result<std::fs::File> {
        private_files::create_private_file(path)
    }
    fn open_private_file(&self, path: &Path) -> std::io::Result<std::fs::File> {
        private_files::open_private_file(path)
    }
    fn is_named_file(&self, file: &std::fs::File, path: &Path) -> Result<bool, String> {
        private_files::is_named_file(file, path)
    }
    fn write_private_file(&self, path: &Path, data: &[u8]) -> Result<(), String> {
        private_files::write_private_file(path, data)
    }
    fn private_file_options(&self) -> std::fs::OpenOptions {
        private_files::private_file_options()
    }
    fn directory_identity(&self, _path: &Path, metadata: &Metadata) -> Result<String, String> {
        Ok(identity::identity(metadata))
    }
    #[cfg(feature = "diagnostics")]
    fn private_directory(&self, path: &Path) -> Result<(), String> {
        endpoint::private_directory(path)
    }

    fn endpoint_listen(&self, directory: &Path, name: &str) -> Result<Box<dyn Listener>, String> {
        endpoint::listen(directory, name)
    }
    fn connect_service(&self, address: &str) -> Result<Box<dyn PersistentStream>, String> {
        connect_service(address)
    }
    fn secure_service_directory(&self, path: &Path) -> Result<(), String> {
        private_files::secure_service_directory(path)
    }
    fn service_process_exists(&self, pid: u32) -> Result<bool, String> {
        endpoint::service_process_exists(pid)
    }
    fn wait_service_process_end(&self, pid: u32, stop: &super::StopSignal) -> Result<bool, String> {
        endpoint::wait_service_process_end(pid, stop)
    }
    fn new_session(&self, command: &mut std::process::Command) -> Result<(), String> {
        endpoint::new_session(command);
        Ok(())
    }
    fn exit_status(&self, status: std::process::ExitStatus) -> Result<String, String> {
        endpoint::exit_status(status)
    }
    fn new_process_group(&self, command: &mut std::process::Command) -> Result<(), String> {
        child_process::new_process_group(command);
        Ok(())
    }
    fn end_process_group(&self, pid: u32) -> Result<(), String> {
        child_process::end_process_group(pid)
    }
    fn terminate_process_group(&self, pid: u32) -> Result<(), String> {
        child_process::terminate_process_group(pid)
    }
    fn exited_by_termination(&self, status: std::process::ExitStatus) -> bool {
        child_process::exited_by_termination(status)
    }
    fn wait_process_exit(&self, pid: u32) -> Result<(), String> {
        child_process::wait_process_exit(pid)
    }
    fn exit_output(&self, output: OutputPipe) -> Result<(Box<dyn Read + Send>, OutputEnd), String> {
        let descriptor = match output {
            OutputPipe::Stdout(pipe) => std::os::fd::OwnedFd::from(pipe),
            OutputPipe::Stderr(pipe) => std::os::fd::OwnedFd::from(pipe),
        };
        let (reads, end) = child_process::exit_output(descriptor)?;
        Ok((Box::new(reads), Box::new(move || end.end())))
    }
}

struct PersistentUnixStream(UnixStream);

impl Read for PersistentUnixStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for PersistentUnixStream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl PersistentStream for PersistentUnixStream {
    fn try_clone(&self) -> Result<Box<dyn PersistentStream>, String> {
        self.0
            .try_clone()
            .map(|stream| Box::new(Self(stream)) as Box<dyn PersistentStream>)
            .map_err(|error| error.to_string())
    }

    fn shutdown(&self) -> std::io::Result<()> {
        self.0.shutdown(std::net::Shutdown::Both)
    }
}

fn connect_service(address: &str) -> Result<Box<dyn PersistentStream>, String> {
    UnixStream::connect(address)
        .map(|stream| Box::new(PersistentUnixStream(stream)) as Box<dyn PersistentStream>)
        .map_err(|error| error.to_string())
}
