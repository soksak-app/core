//! Windows 구현.
//!
//! 디렉터리 식별을 구현한다. 로컬 엔드포인트(named pipe)를 포함한 나머지 기능은 unsupported 에서 "not implemented on windows"
//! 오류를 반환한다.

use std::fs::Metadata;
use std::path::Path;

use serde_json::Value;
use tauri::webview::PlatformWebview;
use tauri::Window;

use std::time::Duration;

use super::{
    Connection, DOMOverlay, Delivery, Frame, Handle, Hit, Insets, Key, Listener, Platform, Pointer,
    Raster, WindowBuilder, WindowOverlay,
};

#[path = "identity.rs"]
mod identity;
#[path = "unsupported.rs"]
mod unsupported;

/// Windows 플랫폼 구현.
pub struct Windows;

impl Platform for Windows {
    fn enqueue_ui(&self, work: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        unsupported::enqueue_ui(work)
    }
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String> {
        unsupported::prepare_window(builder)
    }
    fn window_handle(&self, window: &Window) -> Result<Handle, String> {
        unsupported::window_handle(window)
    }
    fn set_main_webview(&self, window: Handle, main: Handle) -> Result<(), String> {
        unsupported::set_main_webview(window, main)
    }
    fn set_main_appearance(&self, view: &PlatformWebview, dark: bool) -> Result<(), String> {
        unsupported::set_main_appearance(view, dark)
    }
    fn fullscreen(&self, window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String> {
        unsupported::fullscreen(window, on, done)
    }
    fn unified_titlebar(&self, window: Handle) -> Result<f64, String> {
        unsupported::unified_titlebar(window)
    }
    fn window_controls(&self, window: Handle) -> Result<Frame, String> {
        unsupported::window_controls(window)
    }
    fn double_click_interval(&self) -> Result<f64, String> {
        unsupported::double_click_interval()
    }
    #[cfg(feature = "diagnostics")]
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String> {
        unsupported::window_numbers(window)
    }
    fn hit(&self, window: Handle, x: f64, y: f64) -> Result<Hit, String> {
        unsupported::hit(window, x, y)
    }
    fn window_facts(&self, window: Handle) -> Result<Value, String> {
        unsupported::window_facts(window)
    }
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String> {
        unsupported::move_window(window, x, y)
    }
    fn screens(&self) -> Result<Value, String> {
        unsupported::screens()
    }
    /// Windows 애플리케이션은 마지막 창이 닫히면 종료한다.
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
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String> {
        unsupported::webview_frame(view)
    }
    fn create_surface(&self, main: Handle) -> Result<Handle, String> {
        unsupported::create_surface(main)
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
    fn set_surface_alpha_handle(&self, surface: Handle, alpha: f64) -> Result<(), String> {
        unsupported::set_surface_alpha_handle(surface, alpha)
    }
    fn set_window_overlays(&self, main: Handle, overlays: &[WindowOverlay]) -> Result<(), String> {
        unsupported::set_window_overlays(main, overlays)
    }
    fn file_drop(&self, main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String> {
        unsupported::file_drop(main, receive)
    }
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String> {
        unsupported::attach_surface(view, main)
    }
    fn detach_surface(&self, view: &PlatformWebview) -> Result<(), String> {
        unsupported::detach_surface(view)
    }
    fn set_surface_hidden(&self, view: &PlatformWebview, hidden: bool) -> Result<(), String> {
        unsupported::set_surface_hidden(view, hidden)
    }
    fn set_surface_overlays(&self, surface: Handle, overlays: &[DOMOverlay]) -> Result<(), String> {
        unsupported::set_surface_overlays(surface, overlays)
    }
    fn set_alpha(&self, view: &PlatformWebview, alpha: f64) -> Result<(), String> {
        unsupported::set_alpha(view, alpha)
    }

    fn set_live_resize(&self, view: &PlatformWebview, live: bool) -> Result<(), String> {
        unsupported::set_live_resize(view, live)
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
        store: &str,
        changed: Box<dyn Fn(String)>,
    ) -> Result<Handle, String> {
        unsupported::create_document(surface, store, changed)
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
    fn place_document(
        &self,
        document: Handle,
        insets: Insets,
        visible: bool,
    ) -> Result<(), String> {
        unsupported::place_document(document, insets, visible)
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
    ) -> Result<Handle, String> {
        unsupported::create_image(surface, name, event)
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
    fn image_facts(&self, image: Handle) -> Result<String, String> {
        unsupported::image_facts(image)
    }
    fn present_image(
        &self,
        image: Handle,
        token_id: u32,
        nonce: [u8; 16],
        width: f64,
        height: f64,
        scale: f64,
    ) -> Result<bool, String> {
        unsupported::present_image(image, token_id, nonce, width, height, scale)
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
    fn after_settled(
        &self,
        view: &PlatformWebview,
        done: Box<dyn Fn(Result<f64, String>)>,
    ) -> Result<(), String> {
        unsupported::after_settled(view, done)
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
        unsupported::register_input(view)
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
        unsupported::watch_input(window, pressed, pointed)
    }
    fn unwatch_input(&self, monitor: Handle) -> Result<(), String> {
        unsupported::unwatch_input(monitor)
    }
    fn input_pointer(
        &self,
        window: Handle,
        pointer: Pointer,
        receive: Duration,
        done: Box<dyn FnOnce(Delivery) + Send>,
    ) -> Result<(), String> {
        unsupported::input_pointer(window, pointer, receive, done)
    }
    fn input_activate(
        &self,
        window: Handle,
        x: f64,
        y: f64,
        timeout: Duration,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String> {
        unsupported::input_activate(window, x, y, timeout, done)
    }
    fn input_key(&self, window: Handle, key: &Key) -> Result<Delivery, String> {
        unsupported::input_key(window, key)
    }

    #[cfg(feature = "diagnostics")]
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String> {
        unsupported::capture_open(window_number, display)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_start(&self, directory: &str) -> Result<(), String> {
        unsupported::capture_start(directory)
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
    fn capture_still(&self, window_number: isize, path: &str) -> Result<(), String> {
        unsupported::capture_still(window_number, path)
    }
    #[cfg(feature = "diagnostics")]
    fn delivered_notifications(&self, done: Box<dyn FnOnce(String) + Send>) -> Result<(), String> {
        unsupported::delivered_notifications(done)
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_start(&self) -> Result<(), String> {
        unsupported::layout_trace_start()
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_stop(&self) -> Result<Vec<[f64; 4]>, String> {
        unsupported::layout_trace_stop()
    }
    #[cfg(feature = "diagnostics")]
    fn input_source(&self) -> Result<String, String> {
        unsupported::input_source()
    }
    #[cfg(feature = "diagnostics")]
    fn select_input_source(&self, identifier: &str) -> Result<(), String> {
        unsupported::select_input_source(identifier)
    }

    fn on_termination(&self, quit: Box<dyn Fn() + Send>) -> Result<(), String> {
        unsupported::on_termination(quit)
    }
    fn instant_window_resize(&self) -> Result<(), String> {
        unsupported::instant_window_resize()
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
    fn menu_select(&self, menu: &str, title: &str) -> Result<(), String> {
        unsupported::menu_select(menu, title)
    }
    fn main_window(&self) -> Result<Handle, String> {
        unsupported::main_window()
    }
    fn dock_select(&self, title: &str) -> Result<(), String> {
        unsupported::dock_select(title)
    }

    fn clipboard_read(&self, kind: &str) -> Result<super::ClipboardValue, String> {
        unsupported::clipboard_read(kind)
    }
    fn clipboard_write_text(&self, text: &str) -> Result<(), String> {
        unsupported::clipboard_write_text(text)
    }
    fn clipboard_write_png(&self, bytes: &[u8]) -> Result<(), String> {
        unsupported::clipboard_write_png(bytes)
    }
    fn open_link(&self, url: &str) -> Result<(), String> {
        unsupported::open_link(url)
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
    fn endpoint_connect(&self, address: &str) -> Result<Box<dyn Connection>, String> {
        unsupported::endpoint_connect(address)
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
}
