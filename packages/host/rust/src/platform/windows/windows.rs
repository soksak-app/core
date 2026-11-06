//! The Windows implementation.
//!
//! It implements directory identification, the pointer and key input of a WebView2 and, with the diagnostics feature, its still capture, and the watches of the mouse buttons and of window input. The other functions, including the local endpoint (named pipe), return a
//! "not implemented on windows" error from unsupported.

use std::fs::Metadata;
use std::path::Path;

use crate::framework::PlatformWebview;
use crate::framework::Window;
use serde_json::Value;

use std::time::Duration;

#[cfg(feature = "diagnostics")]
use super::DocumentViewportMarker;
use super::{
    ClipboardValue, CoreRootHost, CoreRootResolver, DOMOverlay, Delivery, DocumentOptions, Frame,
    Handle, Hit, ImagePresentation, ImageReleased, Insets, Key, Listener, NativeEventWait,
    PersistentStream, Platform, Pointer, ProcessFootprint, Raster, WindowOverlay,
};

#[cfg(feature = "diagnostics")]
#[path = "capture.rs"]
mod capture;
#[path = "identity.rs"]
mod identity;
#[path = "input.rs"]
mod input;
#[path = "mouse_watch_windows.rs"]
mod mouse_watch_windows;
#[path = "show_windows.rs"]
mod show_windows;
#[path = "ui_thread.rs"]
mod ui_thread;
#[path = "unsupported.rs"]
mod unsupported;
#[path = "webview.rs"]
mod webview;

pub use show_windows::keep_front_on_show;

/// The Windows platform implementation.
pub struct Windows;

impl CoreRootHost for Windows {
    fn set_core_root(&self, resolve: CoreRootResolver) -> Result<(), String> {
        unsupported::set_core_root(resolve)
    }

    fn set_view_import_map(&self, map: &str) -> Result<(), String> {
        unsupported::set_view_import_map(map)
    }
}

impl Platform for Windows {
    fn enqueue_ui(&self, work: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        ui_thread::enqueue_ui(work)
    }
    fn enqueue_ui_after(
        &self,
        delay: std::time::Duration,
        work: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        ui_thread::enqueue_ui_after(delay, work)
    }
    fn window_handle(&self, window: &Window) -> Result<Handle, String> {
        unsupported::window_handle(window)
    }
    #[cfg(feature = "diagnostics")]
    fn window_color_space(&self, window: Handle) -> Result<Value, String> {
        unsupported::window_color_space(window)
    }
    fn set_main_webview(&self, window: Handle, main: Handle) -> Result<(), String> {
        unsupported::set_main_webview(window, main)
    }
    fn reveal_after_load(&self, window: Handle) -> Result<(), String> {
        unsupported::reveal_after_load(window)
    }
    fn show_window(&self, window: Handle) -> Result<(), String> {
        show_windows::show_window(window)
    }
    fn set_main_appearance(&self, view: &PlatformWebview, dark: bool) -> Result<(), String> {
        unsupported::set_main_appearance(view, dark)
    }
    fn observe_occlusion(&self, window: Handle, changed: Box<dyn Fn(bool)>) -> Result<(), String> {
        unsupported::observe_occlusion(window, changed)
    }
    fn observe_responder(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<Handle, String> {
        unsupported::observe_responder(window, changed)
    }
    fn end_responder_observation(&self, observation: Handle) {
        unsupported::end_responder_observation(observation)
    }

    fn fullscreen(&self, window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String> {
        unsupported::fullscreen(window, on, done)
    }
    fn titlebar_height(&self, window: Handle) -> Result<f64, String> {
        unsupported::titlebar_height(window)
    }
    fn set_titlebar_height(&self, window: Handle, height: f64) -> Result<(), String> {
        unsupported::set_titlebar_height(window, height)
    }
    fn window_controls(&self, window: Handle) -> Result<Frame, String> {
        unsupported::window_controls(window)
    }
    #[cfg(feature = "diagnostics")]
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String> {
        capture::window_numbers(window)
    }
    fn hit(&self, window: Handle, x: f64, y: f64) -> Result<Hit, String> {
        unsupported::hit(window, x, y)
    }
    fn window_facts(&self, window: Handle) -> Result<Value, String> {
        unsupported::window_facts(window)
    }
    fn window_on_screen(&self, window: Handle) -> Result<bool, String> {
        unsupported::window_on_screen(window)
    }
    fn process_footprint(&self, pid: u32) -> Result<ProcessFootprint, String> {
        unsupported::process_footprint(pid)
    }
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String> {
        unsupported::move_window(window, x, y)
    }
    fn screens(&self) -> Result<Value, String> {
        unsupported::screens()
    }
    /// A Windows application ends when its last window closes.
    fn stays_open_without_windows(&self) -> bool {
        false
    }

    fn place_webview(
        &self,
        view: &PlatformWebview,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        unsupported::place_webview(view, x, y, w, h)
    }
    fn render_occluded(&self, view: &PlatformWebview, render: bool) -> Result<(), String> {
        unsupported::render_occluded(view, render)
    }
    fn create_surface(&self, window: Handle) -> Result<Handle, String> {
        unsupported::create_surface(window)
    }
    fn close_surface(&self, surface: Handle) -> Result<(), String> {
        unsupported::close_surface(surface)
    }
    fn place_surface(&self, surface: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        unsupported::place_surface(surface, x, y, w, h)
    }
    fn surface_frame(&self, surface: Handle) -> Result<[f64; 4], String> {
        unsupported::surface_frame(surface)
    }
    fn set_surface_hidden_handle(&self, surface: Handle, hidden: bool) -> Result<(), String> {
        unsupported::set_surface_hidden_handle(surface, hidden)
    }
    fn focus_surface(&self, surface: Handle) -> Result<(), String> {
        unsupported::focus_surface(surface)
    }
    fn focus_surface_for_region(&self, surface: Handle) -> Result<(), String> {
        unsupported::focus_surface_for_region(surface)
    }
    fn focus_workbench(&self, window: Handle) -> Result<(), String> {
        unsupported::focus_workbench(window)
    }
    fn keyboard_hold(&self, window: Handle) -> Result<(), String> {
        unsupported::keyboard_hold(window)
    }
    fn keyboard_decided(&self, window: Handle) -> Result<(), String> {
        unsupported::keyboard_decided(window)
    }
    fn set_surface_alpha_handle(&self, surface: Handle, alpha: f64) -> Result<(), String> {
        unsupported::set_surface_alpha_handle(surface, alpha)
    }
    fn set_window_overlays(&self, main: Handle, overlays: &[WindowOverlay]) -> Result<(), String> {
        unsupported::set_window_overlays(main, overlays)
    }
    fn file_drop(&self, main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String> {
        unsupported::file_drop(main, receive)
    }
    fn set_surface_overlays(&self, surface: Handle, overlays: &[DOMOverlay]) -> Result<(), String> {
        unsupported::set_surface_overlays(surface, overlays)
    }
    fn sample_threads(&self, path: &std::path::Path) -> Result<(), String> {
        unsupported::sample_threads(path)
    }

    fn stall_heartbeat(&self) -> Result<(u64, u64), String> {
        unsupported::stall_heartbeat()
    }

    fn stall_await_awake(&self) -> Result<(), String> {
        unsupported::stall_await_awake()
    }
    fn collect_garbage(&self, view: &PlatformWebview) -> Result<(), String> {
        unsupported::collect_garbage(view)
    }

    fn raise_webview(&self, view: &PlatformWebview) -> Result<(), String> {
        unsupported::raise_webview(view)
    }
    fn round_corners(&self, view: &PlatformWebview, radius: f64) -> Result<(), String> {
        unsupported::round_corners(view, radius)
    }
    fn focus_webview(&self, view: &PlatformWebview) -> Result<(), String> {
        unsupported::focus_webview(view)
    }
    fn create_document(
        &self,
        surface: Handle,
        options: DocumentOptions<'_>,
        changed: Box<dyn Fn(String)>,
    ) -> Result<Handle, String> {
        unsupported::create_document(surface, options, changed)
    }
    fn set_view_message(
        &self,
        document: Handle,
        message: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        unsupported::set_view_message(document, message)
    }
    fn set_view_ended(&self, document: Handle, ended: Box<dyn Fn() + Send>) -> Result<(), String> {
        unsupported::set_view_ended(document, ended)
    }
    fn set_view_responsiveness(
        &self,
        document: Handle,
        responsiveness: Box<dyn Fn(bool) + Send>,
    ) -> Result<(), String> {
        unsupported::set_view_responsiveness(document, responsiveness)
    }
    fn take_document_binary(&self, document: Handle, id: &str) -> Result<Vec<u8>, String> {
        unsupported::take_document_binary(document, id)
    }
    fn put_document_binary(
        &self,
        document: Handle,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<String, String> {
        unsupported::put_document_binary(document, bytes, content_type)
    }
    fn add_document_script(&self, document: Handle, source: &str) -> Result<(), String> {
        unsupported::add_document_script(document, source)
    }
    fn set_document_message(
        &self,
        document: Handle,
        message: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        unsupported::set_document_message(document, message)
    }
    fn set_document_stream(
        &self,
        document: Handle,
        stream: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        unsupported::set_document_stream(document, stream)
    }
    fn set_document_stream_on(
        &self,
        document: Handle,
        stream: &str,
        on: bool,
    ) -> Result<bool, String> {
        unsupported::set_document_stream_on(document, stream, on)
    }
    fn ack_document_stream(&self, document: Handle, seq: u64) -> Result<bool, String> {
        unsupported::ack_document_stream(document, seq)
    }
    fn post_document(&self, document: Handle, json: &str) -> Result<bool, String> {
        unsupported::post_document(document, json)
    }
    fn set_document_event(
        &self,
        document: Handle,
        event: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String> {
        unsupported::set_document_event(document, event)
    }
    fn load_document(&self, document: Handle, url: &str) -> Result<bool, String> {
        unsupported::load_document(document, url)
    }
    fn zoom_document(&self, document: Handle, zoom: f64) -> Result<bool, String> {
        unsupported::zoom_document(document, zoom)
    }
    fn go_document(&self, document: Handle, action: i32, offset: i32) -> Result<bool, String> {
        unsupported::go_document(document, action, offset)
    }
    fn query_document(
        &self,
        document: Handle,
        reply: Box<dyn FnOnce(String) + Send>,
    ) -> Result<(), String> {
        unsupported::query_document(document, reply)
    }
    fn document_interaction_state(&self, document: Handle) -> Result<Option<String>, String> {
        unsupported::document_interaction_state(document)
    }
    fn restore_document(&self, document: Handle, state: &str) -> Result<(), String> {
        unsupported::restore_document(document, state)
    }
    fn place_document(
        &self,
        document: Handle,
        insets: Insets,
        visible: bool,
    ) -> Result<(), String> {
        unsupported::place_document(document, insets, visible)
    }
    #[cfg(feature = "diagnostics")]
    fn draw_documents_covered(&self, _window: Handle, _draw: bool) -> Result<(), String> {
        Err("not implemented on Windows".into())
    }
    #[cfg(feature = "diagnostics")]
    fn document_viewport_marker(
        &self,
        _document: Option<Handle>,
        _enabled: bool,
    ) -> Result<DocumentViewportMarker, String> {
        Err("not implemented on Windows".into())
    }
    fn set_document_background(&self, document: Handle, enabled: bool) -> Result<(), String> {
        unsupported::set_document_background(document, enabled)
    }
    fn set_document_appearance(&self, document: Handle, dark: bool) -> Result<(), String> {
        unsupported::set_document_appearance(document, dark)
    }
    fn close_document(&self, document: Handle) -> Result<(), String> {
        unsupported::close_document(document)
    }
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String> {
        unsupported::view_id(view)
    }

    fn create_image(
        &self,
        surface: Handle,
        name: &str,
        event: Box<dyn Fn(String)>,
        released: ImageReleased,
    ) -> Result<Handle, String> {
        unsupported::create_image(surface, name, event, released)
    }
    fn place_image(&self, image: Handle, insets: Insets, visible: bool) -> Result<(), String> {
        unsupported::place_image(image, insets, visible)
    }
    fn image_raster(&self, image: Handle) -> Result<Option<Raster>, String> {
        unsupported::image_raster(image)
    }
    fn image_surface_placed(&self, image: Handle) -> Result<bool, String> {
        unsupported::image_surface_placed(image)
    }
    fn set_image_background(&self, image: Handle, enabled: bool) -> Result<(), String> {
        unsupported::set_image_background(image, enabled)
    }
    fn image_facts(&self, image: Handle) -> Result<String, String> {
        unsupported::image_facts(image)
    }
    fn present_image(
        &self,
        image: Handle,
        presentation: ImagePresentation,
    ) -> Result<bool, String> {
        unsupported::present_image(image, presentation)
    }
    fn focus_image(&self, image: Handle) -> Result<(), String> {
        unsupported::focus_image(image)
    }
    fn caret_image(&self, image: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        unsupported::caret_image(image, x, y, w, h)
    }
    fn text_image(&self, image: Handle, utf8: &str) -> Result<(), String> {
        unsupported::text_image(image, utf8)
    }
    fn close_image(&self, image: Handle) -> Result<(), String> {
        unsupported::close_image(image)
    }

    fn begin_layout(
        &self,
        window: Handle,
        ticket: u64,
        ready: Box<dyn Fn(bool)>,
    ) -> Result<(), String> {
        unsupported::begin_layout(window, ticket, ready)
    }
    fn commit_layout(&self, window: Handle, ticket: u64) -> Result<bool, String> {
        unsupported::commit_layout(window, ticket)
    }
    fn cancel_layout(&self, window: Handle) -> Result<(), String> {
        unsupported::cancel_layout(window)
    }
    fn cancel_layout_ticket(&self, window: Handle, ticket: u64) -> Result<(), String> {
        unsupported::cancel_layout_ticket(window, ticket)
    }
    fn join_view(
        &self,
        window: Handle,
        ticket: u64,
        view: Handle,
        presented: Box<dyn FnOnce() + Send>,
    ) -> Result<Option<crate::platform::ViewAbandon>, String> {
        unsupported::join_view(window, ticket, view, presented)
    }
    fn start_page_titlebar(
        &self,
        window: Handle,
        ticket: u64,
        height: f64,
        ready: Box<dyn Fn(Result<(), String>)>,
    ) -> Result<(), String> {
        unsupported::start_page_titlebar(window, ticket, height, ready)
    }
    fn main_presentation(&self, view: &PlatformWebview) -> Result<Handle, String> {
        unsupported::main_presentation(view)
    }
    fn after_settled(
        &self,
        window: Handle,
        present: Handle,
        done: Box<dyn Fn(Result<f64, String>)>,
    ) -> Result<(), String> {
        unsupported::after_settled(window, present, done)
    }
    fn inject_settled_failure(&self) -> Result<(), String> {
        unsupported::inject_settled_failure()
    }
    fn after_presentation(
        &self,
        view: &PlatformWebview,
        done: Box<dyn Fn()>,
    ) -> Result<(), String> {
        unsupported::after_presentation(view, done)
    }

    fn create_shape(&self, window: Handle, frame: Frame) -> Result<Handle, String> {
        unsupported::create_shape(window, frame)
    }
    fn place_shape(&self, shape: Handle, frame: Frame) -> Result<(), String> {
        unsupported::place_shape(shape, frame)
    }
    fn style_shape(
        &self,
        shape: Handle,
        radius: f64,
        line_width: f64,
        fill: [f64; 4],
        line: [f64; 4],
    ) -> Result<(), String> {
        unsupported::style_shape(shape, radius, line_width, fill, line)
    }
    fn destroy_shape(&self, shape: Handle) -> Result<(), String> {
        unsupported::destroy_shape(shape)
    }

    fn register_input(&self, view: &PlatformWebview) -> Result<bool, String> {
        webview::register(view)
    }
    fn ignore_page_focus(&self, view: &PlatformWebview) -> Result<bool, String> {
        unsupported::ignore_page_focus(view)
    }
    fn watch_input(
        &self,
        window: Handle,
        pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
        pointed: Box<dyn Fn(u8, f64, f64)>,
    ) -> Result<Handle, String> {
        mouse_watch_windows::watch_input(window, pressed, pointed)
    }
    fn unwatch_input(&self, monitor: Handle) -> Result<(), String> {
        mouse_watch_windows::unwatch_input(monitor)
    }
    fn input_pointer(
        &self,
        window: Handle,
        pointer: Pointer,
        receive: Duration,
        done: Box<dyn FnOnce(Delivery) + Send>,
    ) -> Result<(), String> {
        input::pointer(window, pointer, receive, done)
    }
    fn input_activate(
        &self,
        window: Handle,
        _x: f64,
        _y: f64,
        timeout: Duration,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String> {
        input::activate(window, timeout, done)
    }
    fn input_key(&self, window: Handle, key: &Key) -> Result<Delivery, String> {
        input::key(window, key)
    }

    #[cfg(feature = "diagnostics")]
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String> {
        unsupported::capture_open(window_number, display)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_start(&self, directory: &str, frame_identity: bool) -> Result<(), String> {
        unsupported::capture_start(directory, frame_identity)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_wait(&self) -> Result<bool, String> {
        unsupported::capture_wait()
    }
    #[cfg(feature = "diagnostics")]
    fn capture_stop(&self, after: f64) -> Result<i32, String> {
        unsupported::capture_stop(after)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_has_stream(&self) -> Result<bool, String> {
        unsupported::capture_has_stream()
    }
    #[cfg(feature = "diagnostics")]
    fn document_frame_identity_start(
        &self,
        _document: Handle,
        _generation: u64,
        _done: Box<dyn FnOnce(Result<String, String>) + Send>,
    ) -> Result<(), String> {
        Err("not implemented on windows".into())
    }
    #[cfg(feature = "diagnostics")]
    fn document_frame_identity_freeze(
        &self,
        _generation: u64,
        _done: Box<dyn FnOnce(Result<String, String>) + Send>,
    ) -> Result<(), String> {
        Err("not implemented on windows".into())
    }
    #[cfg(feature = "diagnostics")]
    fn document_frame_identity_remove(
        &self,
        _generation: u64,
        _done: Box<dyn FnOnce(Result<String, String>) + Send>,
    ) -> Result<(), String> {
        Err("not implemented on windows".into())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_limited(&self) -> Result<bool, String> {
        unsupported::capture_limited()
    }
    #[cfg(feature = "diagnostics")]
    fn capture_longest_gap(&self) -> Result<f64, String> {
        unsupported::capture_longest_gap()
    }
    #[cfg(feature = "diagnostics")]
    fn capture_clock(&self) -> Result<f64, String> {
        unsupported::capture_clock()
    }
    #[cfg(feature = "diagnostics")]
    fn capture_still(&self, window_numbers: &[isize], path: &str) -> Result<(), String> {
        // `window_numbers` holds the window alone here, so its first number is the whole list.
        let window_number = *window_numbers
            .first()
            .ok_or_else(|| "still capture needs the number of a window".to_owned())?;
        capture::capture_still(window_number, path)
    }
    #[cfg(feature = "diagnostics")]
    fn delivered_notifications(&self, done: Box<dyn FnOnce(String) + Send>) -> Result<(), String> {
        unsupported::delivered_notifications(done)
    }
    #[cfg(feature = "diagnostics")]
    fn window_objects_when(
        &self,
        expected: Option<super::WindowObjects>,
        seconds: f64,
        done: Box<dyn FnOnce(super::WindowObjects, bool) + Send>,
    ) -> Result<(), String> {
        unsupported::window_objects_when(expected, seconds, done)
    }

    #[cfg(feature = "diagnostics")]
    fn count_page_objects(
        &self,
        view: Handle,
        document: bool,
        done: crate::object_counts::PageCountDone,
    ) -> Result<(), String> {
        unsupported::count_page_objects(view, document, done)
    }
    #[cfg(feature = "diagnostics")]
    fn when_process_exited(
        &self,
        pid: i32,
        seconds: f64,
        done: Box<dyn FnOnce(bool) + Send>,
    ) -> Result<(), String> {
        unsupported::when_process_exited(pid, seconds, done)
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_start(&self) -> Result<(), String> {
        unsupported::layout_trace_start()
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_stop(&self) -> Result<Vec<[f64; 5]>, String> {
        unsupported::layout_trace_stop()
    }
    #[cfg(feature = "diagnostics")]
    fn input_reference(
        &self,
        _window: Handle,
        _action: &str,
        _document: Option<&str>,
        done: Box<dyn Fn(Result<Value, String>)>,
    ) {
        done(unsupported::input_reference());
    }
    #[cfg(feature = "diagnostics")]
    fn input_source(&self) -> Result<String, String> {
        unsupported::input_source()
    }
    #[cfg(feature = "diagnostics")]
    fn select_input_source(&self, identifier: &str, adopted: Box<dyn Fn(Result<(), String>)>) {
        adopted(unsupported::select_input_source(identifier))
    }

    fn on_termination(&self, quit: Box<dyn Fn() + Send>) -> Result<(), String> {
        unsupported::on_termination(quit)
    }
    fn on_quit_request(&self, quit: Box<dyn Fn()>) -> Result<(), String> {
        unsupported::on_quit_request(quit)
    }
    fn answer_quit_requests(&self) {
        unsupported::answer_quit_requests()
    }
    fn cancel_quit_requests(&self) {
        unsupported::cancel_quit_requests()
    }
    fn on_memory_pressure(&self, report: crate::memory_pressure::Report) -> Result<(), String> {
        unsupported::on_memory_pressure(report)
    }
    fn inject_memory_pressure(&self, level: &str) -> Result<(), String> {
        unsupported::inject_memory_pressure(level)
    }
    fn instant_window_resize(&self) -> Result<(), String> {
        unsupported::instant_window_resize()
    }
    fn pull_native_events(&self, buffer: &mut [u8]) -> Result<usize, String> {
        unsupported::pull_native_events(buffer)
    }
    fn native_event_wake(&self) -> Result<NativeEventWait, String> {
        unsupported::native_event_wake()
    }
    fn set_native_event_policy(&self, levels: [i8; 5]) -> Result<(), String> {
        unsupported::set_native_event_policy(levels)
    }
    fn watch_file(
        &self,
        path: &std::path::Path,
        changed: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        unsupported::watch_file(path, changed)
    }
    fn monotonic_ns(&self) -> Result<u64, String> {
        unsupported::monotonic_ns()
    }
    fn set_event_boot(&self, boot: &str) -> Result<(), String> {
        unsupported::set_event_boot(boot)
    }
    fn take_native_event_loss(&self, channel: u8) -> Result<(u64, u64), String> {
        unsupported::take_native_event_loss(channel)
    }
    fn flush_native_observers(&self) -> Result<(), String> {
        unsupported::flush_native_observers()
    }
    fn observe_activity(&self) -> Result<(), String> {
        unsupported::observe_activity()
    }
    fn replace_standard_error(&self, file: &std::fs::File) -> Result<(), String> {
        unsupported::replace_standard_error(file)
    }
    fn install_fatal_handlers(&self) -> Result<(), String> {
        unsupported::install_fatal_handlers()
    }
    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String> {
        unsupported::install_dock_menu(new_window)
    }
    fn dock_items(&self) -> Result<Value, String> {
        unsupported::dock_items()
    }
    fn menu_items(&self) -> Result<Value, String> {
        unsupported::menu_items()
    }
    fn preferred_language(&self) -> Result<String, String> {
        unsupported::preferred_language()
    }
    fn os_version(&self) -> Result<String, String> {
        unsupported::os_version()
    }
    fn application_active(&self) -> Result<bool, String> {
        unsupported::application_active()
    }
    fn menu_select(&self, menu: &str, title: &str) -> Result<(), String> {
        unsupported::menu_select(menu, title)
    }
    fn main_window(&self) -> Result<Handle, String> {
        unsupported::main_window()
    }
    fn dock_select(&self, title: &str) -> Result<(), String> {
        unsupported::dock_select(title)
    }

    fn clipboard_read(&self, kind: &str) -> Result<ClipboardValue, String> {
        unsupported::clipboard_read(kind)
    }
    fn clipboard_write_text(&self, text: &str) -> Result<(), String> {
        unsupported::clipboard_write_text(text)
    }
    fn open_link(&self, url: &str) -> Result<(), String> {
        unsupported::open_link(url)
    }
    fn diagnostic_reports_directory(&self) -> Result<std::path::PathBuf, String> {
        unsupported::diagnostic_reports_directory()
    }
    fn watch_buttons(&self, changed: Box<dyn Fn(u64) + Send + Sync>) -> Result<(), String> {
        mouse_watch_windows::watch_buttons(changed)
    }
    fn start_notifications(
        &self,
        receive: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<(), String> {
        unsupported::start_notifications(receive)
    }
    fn post_notification(&self, identifier: &str, title: &str, body: &str) -> Result<(), String> {
        unsupported::post_notification(identifier, title, body)
    }
    fn remove_notification(&self, identifier: &str) -> Result<(), String> {
        unsupported::remove_notification(identifier)
    }

    fn create_private_directories(&self, path: &Path) -> Result<(), String> {
        unsupported::create_private_directories(path)
    }
    fn append_private_file(&self, path: &Path) -> Result<std::fs::File, String> {
        unsupported::append_private_file(path)
    }
    fn create_private_file(&self, path: &Path) -> std::io::Result<std::fs::File> {
        unsupported::create_private_file(path)
    }
    fn open_private_file(&self, path: &Path) -> std::io::Result<std::fs::File> {
        unsupported::open_private_file(path)
    }
    fn is_named_file(&self, file: &std::fs::File, path: &Path) -> Result<bool, String> {
        unsupported::is_named_file(file, path)
    }
    fn write_private_file(&self, path: &Path, data: &[u8]) -> Result<(), String> {
        unsupported::write_private_file(path, data)
    }
    fn private_file_options(&self) -> std::fs::OpenOptions {
        // The access of a new file comes from its folder.
        std::fs::OpenOptions::new()
    }
    fn directory_identity(&self, path: &Path, _metadata: &Metadata) -> Result<String, String> {
        identity::identity(path)
    }
    #[cfg(feature = "diagnostics")]
    fn private_directory(&self, path: &Path) -> Result<(), String> {
        unsupported::private_directory(path)
    }

    fn endpoint_listen(&self, directory: &Path, name: &str) -> Result<Box<dyn Listener>, String> {
        unsupported::endpoint_listen(directory, name)
    }
    fn connect_service(&self, address: &str) -> Result<Box<dyn PersistentStream>, String> {
        unsupported::connect_service(address)
    }
    fn secure_service_directory(&self, path: &Path) -> Result<(), String> {
        unsupported::secure_service_directory(path)
    }
    fn service_process_exists(&self, pid: u32) -> Result<bool, String> {
        unsupported::service_process_exists(pid)
    }
    fn wait_service_process_end(
        &self,
        pid: u32,
        timeout: std::time::Duration,
    ) -> Result<bool, String> {
        unsupported::wait_service_process_end(pid, timeout)
    }
    fn new_session(&self, command: &mut std::process::Command) -> Result<(), String> {
        unsupported::new_session(command)
    }
    fn exit_status(&self, status: std::process::ExitStatus) -> Result<String, String> {
        unsupported::exit_status(status)
    }
}
