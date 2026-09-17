//! macOS 구현.
//!
//! 창, 웹뷰, 표면 배치, 입력, 캡처, Dock 기능은 native/darwin 라이브러리와 AppKit 공개
//! 인터페이스를 호출한다. 포인터 라우팅은 native/darwin 에서 WebKit 비공개 입력 API 하나를
//! 사용한다.

use std::fs::Metadata;
use std::path::Path;

use tauri::webview::PlatformWebview;
use tauri::Window;

use super::{Frame, Handle, Platform, WindowBuilder};

#[path = "capture.rs"]
mod capture;
#[path = "dock.rs"]
mod dock;
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
    fn place_window_controls(&self, window: Handle, x: f64, y: f64) -> Result<(), String> {
        window::place_controls(window, x, y);
        Ok(())
    }
    fn window_controls(&self, window: Handle) -> Result<Frame, String> {
        Ok(window::controls(window))
    }
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String> {
        Ok(window::numbers(window::handle(window)?))
    }
    fn probe(&self, window: Handle, request: &str, reply: fn(String)) -> Result<(), String> {
        window::probe(window, request, reply);
        Ok(())
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

    fn capture_open(&self, window_number: isize) -> Result<(), String> {
        capture::open(window_number);
        Ok(())
    }
    fn capture_start(&self, directory: &str) -> Result<(), String> {
        capture::start(directory);
        Ok(())
    }
    fn capture_wait(&self) -> Result<bool, String> {
        Ok(capture::wait())
    }
    fn capture_stop(&self) -> Result<i32, String> {
        Ok(capture::stop())
    }

    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String> {
        dock::install(new_window)
    }

    fn directory_identity(&self, _path: &Path, metadata: &Metadata) -> Result<String, String> {
        Ok(identity::identity(metadata))
    }
}
