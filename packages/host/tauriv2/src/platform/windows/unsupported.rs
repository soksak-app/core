//! Windows 에서 구현하지 않은 플랫폼 기능. 모든 함수가 "not implemented on windows" 오류를 반환한다.

use std::path::Path;

use tauri::webview::PlatformWebview;
use serde_json::Value;
use tauri::Window;

use super::super::{Connection, Delivery, Frame, Handle, Hit, Key, Listener, Pointer, WindowBuilder};

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

pub fn place_window_controls(_window: Handle, _x: f64, _centre_y: f64) -> Result<(), String> {
    missing("window button placement")
}

pub fn window_controls(_window: Handle) -> Result<Frame, String> {
    missing("window button area")
}

#[cfg(feature = "diagnostics")]
pub fn window_numbers(_window: &Window) -> Result<Vec<isize>, String> {
    missing("window numbers")
}

pub fn hit(_window: Handle, _x: f64, _y: f64) -> Result<Hit, String> {
    missing("hit testing")
}

pub fn place_webview(_view: &PlatformWebview, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<(), String> {
    missing("webview placement")
}

pub fn webview_frame(_view: &PlatformWebview) -> Result<[f64; 4], String> {
    missing("webview frame")
}

pub fn attach_surface(_view: &PlatformWebview, _main: Handle) -> Result<(), String> {
    missing("surface attachment")
}

pub fn set_alpha(_view: &PlatformWebview, _alpha: f64) -> Result<(), String> {
    missing("webview alpha")
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

pub fn view_id(_view: &PlatformWebview) -> Result<Handle, String> {
    missing("webview identity")
}

pub fn begin_layout(_window: Handle, _ticket: u64, _ready: Box<dyn Fn(bool)>) -> Result<(), String> {
    missing("surface layout")
}

pub fn commit_layout(_window: Handle, _ticket: u64) -> Result<bool, String> {
    missing("surface layout")
}

pub fn cancel_layout(_window: Handle) -> Result<(), String> {
    missing("surface layout")
}

pub fn after_presentation(_view: &PlatformWebview, _done: Box<dyn Fn()>) -> Result<(), String> {
    missing("presentation tracking")
}

pub fn create_shape(_window: Handle, _frame: Frame) -> Result<Handle, String> {
    missing("shapes")
}

pub fn place_shape(_shape: Handle, _frame: Frame) -> Result<(), String> {
    missing("shapes")
}

pub fn style_shape(_shape: Handle, _radius: f64, _line_width: f64, _fill: [f64; 4], _line: [f64; 4]) -> Result<(), String> {
    missing("shapes")
}

pub fn destroy_shape(_shape: Handle) -> Result<(), String> {
    missing("shapes")
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
    missing("input monitoring")
}

pub fn unwatch_input(_monitor: Handle) -> Result<(), String> {
    missing("input monitoring")
}

pub fn input_pointer(_window: Handle, _pointer: Pointer) -> Result<Delivery, String> {
    missing("native input")
}

pub fn input_activate(
    _window: Handle,
    _timeout: std::time::Duration,
    _done: Box<dyn FnOnce(bool) + Send>,
) -> Result<(), String> {
    missing("native input")
}

pub fn input_key(_window: Handle, _key: &Key) -> Result<bool, String> {
    missing("native input")
}

#[cfg(feature = "diagnostics")]
pub fn capture_open(_window_number: isize) -> Result<(), String> {
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
pub fn capture_stop() -> Result<i32, String> {
    missing("window capture")
}

pub fn install_dock_menu(_new_window: Box<dyn Fn()>) -> Result<(), String> {
    missing("Dock menu")
}

pub fn dock_items() -> Result<Value, String> {
    missing("Dock menu")
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
