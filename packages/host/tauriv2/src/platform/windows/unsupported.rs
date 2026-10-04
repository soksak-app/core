//! Windows 에서 구현하지 않은 플랫폼 기능. 모든 함수가 "not implemented on windows" 오류를 반환한다.

use std::path::Path;

use serde_json::Value;
use tauri::webview::PlatformWebview;
use tauri::Window;

use super::super::{
    ClipboardValue, Connection, DOMOverlay, Delivery, Frame, Handle, Hit, Insets, Key, Listener,
    PersistentStream, Pointer, Raster, WindowBuilder, WindowOverlay,
};

/// operation 을 이름에 포함한 오류를 반환한다.
fn missing<T>(operation: &str) -> Result<T, String> {
    Err(format!("{operation} is not implemented on windows"))
}

pub fn prepare_window<'a>(_builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String> {
    missing("window preparation")
}

pub fn window_handle(_window: &Window) -> Result<Handle, String> {
    missing("native window handle")
}
pub fn reveal_after_load(_window: Handle) -> Result<(), String> {
    missing("window reveal")
}
pub fn set_main_webview(_window: Handle, _main: Handle) -> Result<(), String> {
    missing("main webview identity")
}
pub fn set_main_appearance(_view: &PlatformWebview, _dark: bool) -> Result<(), String> {
    missing("main webview appearance")
}

pub fn fullscreen(_window: Handle, _on: bool, _done: Box<dyn Fn()>) -> Result<(), String> {
    missing("full screen")
}

pub fn observe_occlusion(_window: Handle, _changed: Box<dyn Fn()>) -> Result<(), String> {
    missing("window occlusion")
}

pub fn titlebar_height(_window: Handle) -> Result<f64, String> {
    missing("window title bar")
}

pub fn set_titlebar_height(_window: Handle, _height: f64) -> Result<(), String> {
    missing("window title bar")
}

pub fn window_controls(_window: Handle) -> Result<Frame, String> {
    missing("window controls")
}

pub fn clipboard_read(_kind: &str) -> Result<ClipboardValue, String> {
    missing("clipboard read")
}
pub fn clipboard_write_text(_text: &str) -> Result<(), String> {
    missing("clipboard text write")
}
pub fn clipboard_write_png(_bytes: &[u8]) -> Result<(), String> {
    missing("clipboard PNG write")
}
pub fn open_link(_url: &str) -> Result<(), String> {
    missing("link open")
}
pub fn watch_buttons(_changed: Box<dyn Fn(u64) + Send + Sync>) -> Result<(), String> {
    missing("mouse button state")
}
pub fn start_notifications(_receive: Box<dyn Fn(String) + Send + Sync>) -> Result<(), String> {
    missing("system notifications")
}
pub fn post_notification(_identifier: &str, _title: &str, _body: &str) -> Result<(), String> {
    missing("system notifications")
}
pub fn remove_notification(_identifier: &str) -> Result<(), String> {
    missing("system notifications")
}

#[cfg(feature = "diagnostics")]
pub fn window_numbers(_window: &Window) -> Result<Vec<isize>, String> {
    missing("window numbers")
}

pub fn hit(_window: Handle, _x: f64, _y: f64) -> Result<Hit, String> {
    missing("window hit testing")
}

pub fn place_webview(
    _view: &PlatformWebview,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<(), String> {
    missing("webview placement")
}

pub fn webview_frame(_view: &PlatformWebview) -> Result<[f64; 4], String> {
    missing("webview frame")
}
pub fn create_surface(_main: Handle) -> Result<Handle, String> {
    missing("surface host")
}
pub fn close_surface(_surface: Handle) -> Result<(), String> {
    missing("surface host removal")
}
pub fn place_surface(_surface: Handle, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<(), String> {
    missing("surface host placement")
}
pub fn surface_frame(_surface: Handle) -> Result<[f64; 4], String> {
    missing("surface host frame")
}
pub fn set_surface_hidden_handle(_surface: Handle, _hidden: bool) -> Result<(), String> {
    missing("surface visibility")
}
pub fn set_surface_alpha_handle(_surface: Handle, _alpha: f64) -> Result<(), String> {
    missing("surface opacity")
}
pub fn set_window_overlays(_main: Handle, _overlays: &[WindowOverlay]) -> Result<(), String> {
    missing("window DOM overlays")
}

pub fn file_drop(_main: Handle, _receive: Box<dyn Fn(String)>) -> Result<(), String> {
    missing("file drop")
}

pub fn attach_surface(_view: &PlatformWebview, _main: Handle) -> Result<(), String> {
    missing("surface attachment")
}

pub fn detach_surface(_view: &PlatformWebview) -> Result<(), String> {
    missing("surface detachment")
}

pub fn set_surface_hidden(_view: &PlatformWebview, _hidden: bool) -> Result<(), String> {
    missing("surface visibility")
}

pub fn set_surface_overlays(_surface: Handle, _overlays: &[DOMOverlay]) -> Result<(), String> {
    missing("surface DOM overlays")
}

pub fn set_alpha(_view: &PlatformWebview, _alpha: f64) -> Result<(), String> {
    missing("webview alpha")
}

pub fn kill_web_content_process(_view: &PlatformWebview) -> Result<(), String> {
    missing("WebContent process termination")
}

pub fn collect_garbage(_view: &PlatformWebview) -> Result<(), String> {
    missing("JavaScript garbage collection")
}

pub fn set_live_resize(_view: &PlatformWebview, _live: bool) -> Result<(), String> {
    missing("webview live resize")
}

pub fn raise_webview(_view: &PlatformWebview) -> Result<(), String> {
    missing("webview ordering")
}

pub fn round_corners(_view: &PlatformWebview, _radius: f64) -> Result<(), String> {
    missing("webview corners")
}

pub fn focus_webview(_view: &PlatformWebview) -> Result<(), String> {
    missing("webview focus")
}

pub fn create_document(
    _surface: Handle,
    _store: &str,
    _changed: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    missing("document view")
}

pub fn set_document_event(
    _document: Handle,
    _event: Box<dyn Fn(String) + Send>,
) -> Result<(), String> {
    missing("document events")
}

pub fn load_document(_document: Handle, _url: &str) -> Result<bool, String> {
    missing("document navigation")
}

pub fn zoom_document(_document: Handle, _zoom: f64) -> Result<bool, String> {
    missing("document zoom")
}

pub fn go_document(_document: Handle, _action: i32, _offset: i32) -> Result<bool, String> {
    missing("document history")
}

pub fn place_document(_document: Handle, _insets: Insets, _visible: bool) -> Result<(), String> {
    missing("document placement")
}

pub fn set_document_background(_document: Handle, _enabled: bool) -> Result<(), String> {
    missing("document background")
}

pub fn set_document_appearance(_document: Handle, _dark: bool) -> Result<(), String> {
    missing("document appearance")
}

pub fn close_document(_document: Handle) -> Result<(), String> {
    missing("document removal")
}

pub fn view_id(_view: &PlatformWebview) -> Result<Handle, String> {
    missing("webview identity")
}

pub fn begin_layout(
    _window: Handle,
    _ticket: u64,
    _ready: Box<dyn Fn(bool)>,
) -> Result<(), String> {
    missing("surface layout")
}

pub fn commit_layout(_window: Handle, _ticket: u64) -> Result<bool, String> {
    missing("surface layout commit")
}

pub fn enqueue_ui(_work: Box<dyn FnOnce() + Send>) -> Result<(), String> {
    missing("UI queue")
}

pub fn cancel_layout(_window: Handle) -> Result<(), String> {
    missing("surface layout cancel")
}

pub fn start_page_titlebar(
    _window: Handle,
    _ticket: u64,
    _height: f64,
    _ready: Box<dyn Fn(Result<(), String>)>,
) -> Result<(), String> {
    missing("start title bar")
}

pub fn after_settled(
    _view: &PlatformWebview,
    _done: Box<dyn Fn(Result<f64, String>)>,
) -> Result<(), String> {
    missing("native presentation")
}

pub fn inject_settled_failure() -> Result<(), String> {
    missing("native presentation")
}

pub fn after_presentation(_view: &PlatformWebview, _done: Box<dyn Fn()>) -> Result<(), String> {
    missing("native presentation")
}

pub fn create_shape(_window: Handle, _frame: Frame) -> Result<Handle, String> {
    missing("native shapes")
}

pub fn place_shape(_shape: Handle, _frame: Frame) -> Result<(), String> {
    missing("native shape frame")
}

pub fn style_shape(
    _shape: Handle,
    _radius: f64,
    _line_width: f64,
    _fill: [f64; 4],
    _line: [f64; 4],
) -> Result<(), String> {
    missing("native shape style")
}

pub fn destroy_shape(_shape: Handle) -> Result<(), String> {
    missing("native shape destroy")
}

pub fn register_input(_view: &PlatformWebview) -> Result<bool, String> {
    missing("webview input routing")
}

pub fn ignore_page_focus(_view: &PlatformWebview) -> Result<bool, String> {
    missing("webview focus isolation")
}

pub fn watch_input(
    _window: Handle,
    _pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
    _pointed: Box<dyn Fn(u8, f64, f64)>,
) -> Result<Handle, String> {
    missing("surface input")
}

pub fn unwatch_input(_monitor: Handle) -> Result<(), String> {
    missing("surface input release")
}

pub fn input_pointer(
    _window: Handle,
    _pointer: Pointer,
    _receive: std::time::Duration,
    _done: Box<dyn FnOnce(Delivery) + Send>,
) -> Result<(), String> {
    missing("native pointer input")
}

pub fn input_activate(
    _window: Handle,
    _x: f64,
    _y: f64,
    _timeout: std::time::Duration,
    _done: Box<dyn FnOnce(Result<(), String>) + Send>,
) -> Result<(), String> {
    missing("window activation")
}

pub fn input_key(_window: Handle, _key: &Key) -> Result<Delivery, String> {
    missing("native key input")
}

#[cfg(feature = "diagnostics")]
pub fn capture_open(_window_number: isize, _display: bool) -> Result<(), String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_start(_directory: &str) -> Result<(), String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_wait() -> Result<bool, String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_stop(_after: f64) -> Result<i32, String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_limited() -> Result<bool, String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_longest_gap() -> Result<f64, String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_clock() -> Result<f64, String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn capture_still(_window_number: isize, _path: &str) -> Result<(), String> {
    missing("window capture")
}

#[cfg(feature = "diagnostics")]
pub fn delivered_notifications(_done: Box<dyn FnOnce(String) + Send>) -> Result<(), String> {
    missing("system notifications")
}

#[cfg(feature = "diagnostics")]
pub fn window_objects_when(
    _expected: Option<super::super::WindowObjects>,
    _seconds: f64,
    _done: Box<dyn FnOnce(super::super::WindowObjects, bool) + Send>,
) -> Result<(), String> {
    missing("window object counts")
}

#[cfg(feature = "diagnostics")]
pub fn when_process_exited(
    _pid: i32,
    _seconds: f64,
    _done: Box<dyn FnOnce(bool) + Send>,
) -> Result<(), String> {
    missing("process exit waits")
}

#[cfg(feature = "diagnostics")]
pub fn layout_trace_start() -> Result<(), String> {
    missing("surface layout trace")
}

#[cfg(feature = "diagnostics")]
pub fn layout_trace_stop() -> Result<Vec<[f64; 4]>, String> {
    missing("surface layout trace")
}

#[cfg(feature = "diagnostics")]
pub fn input_source() -> Result<String, String> {
    missing("keyboard input sources")
}

#[cfg(feature = "diagnostics")]
pub fn select_input_source(_identifier: &str) -> Result<(), String> {
    missing("keyboard input sources")
}

pub fn on_termination(_quit: Box<dyn Fn() + Send>) -> Result<(), String> {
    missing("termination requests")
}

pub fn on_quit_request(_quit: Box<dyn Fn()>) -> Result<(), String> {
    missing("quit requests")
}

/// 받은 종료 요청이 없으므로 답할 것이 없다. on_quit_request 가 실패하면 애플리케이션이 시작하지 않는다.
pub fn answer_quit_requests() {}

pub fn instant_window_resize() -> Result<(), String> {
    missing("window resize animation")
}

pub fn replace_standard_error(_file: &std::fs::File) -> Result<(), String> {
    missing("standard error replacement")
}

pub fn install_dock_menu(_new_window: Box<dyn Fn()>) -> Result<(), String> {
    missing("Dock menu")
}

pub fn dock_items() -> Result<Value, String> {
    missing("Dock menu")
}

pub fn menu_items() -> Result<Value, String> {
    missing("application menu")
}

pub fn preferred_language() -> Result<String, String> {
    missing("preferred language")
}

pub fn menu_select(_menu: &str, _title: &str) -> Result<(), String> {
    missing("application menu")
}

pub fn main_window() -> Result<Handle, String> {
    missing("main window")
}

pub fn dock_select(_title: &str) -> Result<(), String> {
    missing("Dock menu")
}

pub fn window_facts(_window: Handle) -> Result<Value, String> {
    missing("window state")
}

pub fn move_window(_window: Handle, _x: f64, _y: f64) -> Result<(), String> {
    missing("window placement")
}

pub fn screens() -> Result<Value, String> {
    missing("display list")
}

#[cfg(feature = "diagnostics")]
pub fn private_directory(_path: &std::path::Path) -> Result<(), String> {
    missing("private directory")
}

pub fn endpoint_listen(_directory: &Path, _name: &str) -> Result<Box<dyn Listener>, String> {
    missing("local endpoint")
}

pub fn endpoint_connect(_address: &str) -> Result<Box<dyn Connection>, String> {
    missing("local endpoint")
}

pub fn connect_service(_address: &str) -> Result<Box<dyn PersistentStream>, String> {
    missing("persistent sidecar transport")
}

pub fn secure_service_directory(_path: &Path) -> Result<(), String> {
    missing("persistent sidecar service directory")
}

pub fn create_image(
    _surface: Handle,
    _name: &str,
    _event: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    missing("image view")
}

pub fn place_image(_image: Handle, _insets: Insets, _visible: bool) -> Result<(), String> {
    missing("image placement")
}

pub fn image_raster(_image: Handle) -> Result<Option<Raster>, String> {
    missing("image raster geometry")
}
pub fn image_surface_placed(_image: Handle) -> Result<bool, String> {
    missing("image surface placement")
}

pub fn image_facts(_image: Handle) -> Result<String, String> {
    missing("image facts")
}

pub fn present_image(
    _image: Handle,
    _token_id: u32,
    _nonce: [u8; 16],
    _width: f64,
    _height: f64,
    _scale: f64,
) -> Result<bool, String> {
    missing("image presentation")
}

pub fn focus_image(_image: Handle) -> Result<(), String> {
    missing("image focus")
}

pub fn caret_image(_image: Handle, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<(), String> {
    missing("image caret")
}

pub fn text_image(_image: Handle, _utf8: &str) -> Result<(), String> {
    missing("image text")
}

pub fn close_image(_image: Handle) -> Result<(), String> {
    missing("image removal")
}

pub fn service_process_exists(_pid: u32) -> Result<bool, String> {
    missing("service process inspection")
}

pub fn create_private_directories(_path: &std::path::Path) -> Result<(), String> {
    missing("private directory creation")
}

pub fn append_private_file(_path: &std::path::Path) -> Result<std::fs::File, String> {
    missing("private file creation")
}
