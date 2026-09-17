//! macOS 구현.
//!
//! 창, 웹뷰, 표면 배치, 입력, 캡처, Dock 기능은 native/darwin 라이브러리와 AppKit 공개
//! 인터페이스를 호출한다. 로컬 엔드포인트는 Unix 도메인 소켓이다. 포인터 라우팅은 native/darwin 에서 WebKit 비공개 입력 API 하나를
//! 사용한다.

use std::fs::Metadata;
use std::path::Path;

use tauri::webview::PlatformWebview;
use serde_json::Value;
use tauri::Window;

use std::time::Duration;

use super::{Connection, Delivery, Frame, Handle, Hit, Insets, Key, Listener, Platform, Pointer, WindowBuilder};

#[cfg(feature = "diagnostics")]
#[path = "capture.rs"]
mod capture;
#[path = "dock.rs"]
mod dock;
#[path = "document.rs"]
mod document;
#[path = "endpoint.rs"]
mod endpoint;
#[path = "identity.rs"]
mod identity;
#[path = "input.rs"]
mod input;
#[path = "layout.rs"]
mod layout;
#[path = "shapes.rs"]
mod shapes;
#[path = "webview.rs"]
mod webview;
#[path = "window.rs"]
mod window;

/// AppKit 이 이벤트 위치로 반환하는 점. objc2 가 메시지 반환값의 배치를 알아야 하므로 선언한다.
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

/// AppKit 좌표의 사각형. NSPoint 와 같은 이유로 선언한다.
#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSPoint,
}

impl From<Frame> for NSRect {
    fn from((x, y, w, h): Frame) -> Self {
        NSRect { origin: NSPoint { x, y }, size: NSPoint { x: w, y: h } }
    }
}

unsafe impl objc2::Encode for NSRect {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSPoint::ENCODING]);
}

/// macOS 플랫폼 구현.
pub struct Darwin;

impl Platform for Darwin {
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String> {
        Ok(window::prepare(builder))
    }
    fn window_handle(&self, window: &Window) -> Result<Handle, String> {
        window::handle(window)
    }
    fn place_window_controls(&self, window: Handle, x: f64, centre_y: f64) -> Result<(), String> {
        window::place_controls(window, x, centre_y)
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
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String> {
        window::move_to(window, x, y)
    }
    fn screens(&self) -> Result<Value, String> {
        window::screens()
    }
    fn stays_open_without_windows(&self) -> bool {
        true
    }

    fn place_webview(&self, view: &PlatformWebview, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        webview::place(view, x, y, w, h);
        Ok(())
    }
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String> {
        Ok(webview::frame(view))
    }
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String> {
        webview::attach_surface(view, main);
        Ok(())
    }
    fn set_alpha(&self, view: &PlatformWebview, alpha: f64) -> Result<(), String> {
        webview::alpha(view, alpha);
        Ok(())
    }
    fn set_live_resize(&self, view: &PlatformWebview, live: bool) -> Result<(), String> {
        webview::live_resize(view, live);
        Ok(())
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
    fn create_document(&self, surface: Handle, store: &str, changed: Box<dyn Fn(String)>) -> Result<Handle, String> {
        document::create(surface, store, changed)
    }
    fn load_document(&self, document: Handle, url: &str) -> Result<bool, String> {
        document::load(document, url)
    }
    fn go_document(&self, document: Handle, action: i32) -> Result<bool, String> {
        Ok(document::go(document, action))
    }
    fn place_document(&self, document: Handle, insets: Insets, visible: bool) -> Result<(), String> {
        document::place(document, insets, visible);
        Ok(())
    }
    fn set_document_background(&self, document: Handle, enabled: bool) -> Result<(), String> {
        document::background(document, enabled);
        Ok(())
    }
    fn close_document(&self, document: Handle) -> Result<(), String> {
        document::close(document);
        Ok(())
    }
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String> {
        Ok(webview::id(view))
    }

    fn begin_layout(&self, window: Handle, ticket: u64, ready: Box<dyn Fn(bool)>) -> Result<(), String> {
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
    fn after_presentation(&self, view: &PlatformWebview, done: Box<dyn Fn()>) -> Result<(), String> {
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
    fn style_shape(&self, shape: Handle, radius: f64, line_width: f64, fill: [f64; 4], line: [f64; 4]) -> Result<(), String> {
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
    fn input_pointer(&self, window: Handle, pointer: Pointer, receive: Duration, done: Box<dyn FnOnce(Delivery) + Send>) -> Result<(), String> {
        input::pointer(window, pointer, receive, done);
        Ok(())
    }
    fn input_activate(&self, window: Handle, timeout: Duration, done: Box<dyn FnOnce(Result<(), String>) + Send>) -> Result<(), String> {
        input::activate(window, timeout, done);
        Ok(())
    }
    fn input_key(&self, window: Handle, key: &Key) -> Result<bool, String> {
        input::key(window, key)
    }

    #[cfg(feature = "diagnostics")]
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String> {
        capture::open(window_number, display);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_start(&self, directory: &str) -> Result<(), String> {
        capture::start(directory);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_wait(&self) -> Result<bool, String> {
        Ok(capture::wait())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_stop(&self) -> Result<i32, String> {
        Ok(capture::stop())
    }
    #[cfg(feature = "diagnostics")]
    fn capture_longest_gap(&self) -> Result<f64, String> {
        Ok(capture::longest_gap())
    }

    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String> {
        dock::install(new_window)
    }
    fn dock_items(&self) -> Result<Value, String> {
        dock::items()
    }
    fn dock_select(&self, title: &str) -> Result<(), String> {
        dock::select(title)
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
    fn endpoint_connect(&self, address: &str) -> Result<Box<dyn Connection>, String> {
        endpoint::connect(address)
    }
}
