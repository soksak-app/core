//! Windows 구현.
//!
//! 디렉터리 식별을 구현한다. 로컬 엔드포인트(named pipe)를 포함한 나머지 기능은 unsupported 에서 "not implemented on windows"
//! 오류를 반환한다.

use std::fs::Metadata;
use std::path::Path;

use tauri::webview::PlatformWebview;
use serde_json::Value;
use tauri::Window;

use std::time::Duration;

use super::{Connection, Delivery, Frame, Handle, Hit, Key, Listener, Platform, Pointer, WindowBuilder};

#[path = "identity.rs"]
mod identity;
#[path = "unsupported.rs"]
mod unsupported;

/// Windows 플랫폼 구현.
pub struct Windows;

impl Platform for Windows {
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String> {
        unsupported::prepare_window(builder)
    }
    fn window_handle(&self, window: &Window) -> Result<Handle, String> {
        unsupported::window_handle(window)
    }
    fn place_window_controls(&self, window: Handle, x: f64, centre_y: f64) -> Result<(), String> {
        unsupported::place_window_controls(window, x, centre_y)
    }
    fn window_controls(&self, window: Handle) -> Result<Frame, String> {
        unsupported::window_controls(window)
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

    fn place_webview(&self, view: &PlatformWebview, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        unsupported::place_webview(view, x, y, w, h)
    }
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String> {
        unsupported::webview_frame(view)
    }
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String> {
        unsupported::attach_surface(view, main)
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
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String> {
        unsupported::view_id(view)
    }

    fn begin_layout(&self, window: Handle, ticket: u64, ready: Box<dyn Fn(bool)>) -> Result<(), String> {
        unsupported::begin_layout(window, ticket, ready)
    }
    fn commit_layout(&self, window: Handle, ticket: u64) -> Result<bool, String> {
        unsupported::commit_layout(window, ticket)
    }
    fn cancel_layout(&self, window: Handle) -> Result<(), String> {
        unsupported::cancel_layout(window)
    }
    fn after_presentation(&self, view: &PlatformWebview, done: Box<dyn Fn()>) -> Result<(), String> {
        unsupported::after_presentation(view, done)
    }

    fn create_shape(&self, window: Handle, frame: Frame) -> Result<Handle, String> {
        unsupported::create_shape(window, frame)
    }
    fn place_shape(&self, shape: Handle, frame: Frame) -> Result<(), String> {
        unsupported::place_shape(shape, frame)
    }
    fn style_shape(&self, shape: Handle, radius: f64, line_width: f64, fill: [f64; 4], line: [f64; 4]) -> Result<(), String> {
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
    fn input_pointer(&self, window: Handle, pointer: Pointer) -> Result<Delivery, String> {
        unsupported::input_pointer(window, pointer)
    }
    fn input_activate(&self, window: Handle, timeout: Duration, done: Box<dyn FnOnce(bool) + Send>) -> Result<(), String> {
        unsupported::input_activate(window, timeout, done)
    }
    fn input_key(&self, window: Handle, key: &Key) -> Result<bool, String> {
        unsupported::input_key(window, key)
    }

    #[cfg(feature = "diagnostics")]
    fn capture_open(&self, window_number: isize) -> Result<(), String> {
        unsupported::capture_open(window_number)
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
    fn capture_stop(&self) -> Result<i32, String> {
        unsupported::capture_stop()
    }

    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String> {
        unsupported::install_dock_menu(new_window)
    }
    fn dock_items(&self) -> Result<Value, String> {
        unsupported::dock_items()
    }
    fn dock_select(&self, title: &str) -> Result<(), String> {
        unsupported::dock_select(title)
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
}
