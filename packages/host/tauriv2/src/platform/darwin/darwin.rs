//! macOS 구현.
//!
//! 창, 웹뷰, 표면 배치, 입력, 캡처, Dock 기능은 native/darwin 라이브러리와 AppKit 공개
//! 인터페이스를 호출한다. 로컬 엔드포인트는 Unix 도메인 소켓이다. 포인터 라우팅은 native/darwin 에서 WebKit 비공개 입력 API 하나를
//! 사용한다.

use std::fs::Metadata;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
#[path = "ui_queue.rs"]
mod ui_queue;
use std::path::Path;

use serde_json::Value;
use tauri::webview::PlatformWebview;
use tauri::Window;

use std::time::Duration;

use super::{
    Connection, DOMOverlay, Delivery, Frame, Handle, Hit, Insets, Key, Listener, PersistentStream,
    Platform, Pointer, Raster, WindowBuilder, WindowOverlay,
};

#[cfg(feature = "diagnostics")]
#[path = "capture.rs"]
mod capture;
#[path = "clipboard.rs"]
mod clipboard;
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
#[path = "input_source.rs"]
mod input_source;
#[path = "layout.rs"]
mod layout;
#[path = "link.rs"]
mod link;

#[path = "mouse_buttons.rs"]
mod mouse_buttons;
mod notifications;
#[path = "private_files.rs"]
mod private_files;
#[cfg(feature = "diagnostics")]
#[path = "process_exit.rs"]
mod process_exit;
#[path = "shapes.rs"]
mod shapes;
#[path = "standard_error.rs"]
mod standard_error;
#[path = "termination.rs"]
mod termination;
#[path = "webview.rs"]
mod webview;
#[path = "window.rs"]
mod window;
#[cfg(feature = "diagnostics")]
#[path = "window_objects.rs"]
mod window_objects;

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

/// macOS 플랫폼 구현.
pub struct Darwin;

impl Platform for Darwin {
    fn enqueue_ui(&self, work: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        ui_queue::enqueue(work);
        Ok(())
    }
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String> {
        Ok(window::prepare(builder))
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
    fn set_main_appearance(&self, view: &PlatformWebview, dark: bool) -> Result<(), String> {
        webview::set_main_appearance(view, dark)
    }
    fn observe_occlusion(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<(), String> {
        window::observe_occlusion(window, changed)
    }

    fn fullscreen(&self, window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String> {
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
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String> {
        window::move_to(window, x, y)
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
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String> {
        Ok(webview::frame(view))
    }
    fn create_surface(&self, main: Handle) -> Result<Handle, String> {
        webview::create_surface(main)
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
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String> {
        webview::attach_surface(view, main);
        Ok(())
    }
    fn detach_surface(&self, view: &PlatformWebview) -> Result<(), String> {
        webview::detach_surface(view);
        Ok(())
    }
    fn set_surface_hidden(&self, view: &PlatformWebview, hidden: bool) -> Result<(), String> {
        webview::hidden(view, hidden);
        Ok(())
    }
    fn set_surface_overlays(&self, surface: Handle, overlays: &[DOMOverlay]) -> Result<(), String> {
        webview::overlays(surface, overlays);
        Ok(())
    }
    fn set_alpha(&self, view: &PlatformWebview, alpha: f64) -> Result<(), String> {
        webview::alpha(view, alpha);
        Ok(())
    }

    fn kill_web_content_process(&self, view: &PlatformWebview) -> Result<(), String> {
        webview::kill_content_process(view)
    }

    fn collect_garbage(&self, view: &PlatformWebview) -> Result<(), String> {
        webview::collect_garbage(view)
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
    fn create_document(
        &self,
        surface: Handle,
        store: &str,
        changed: Box<dyn Fn(String)>,
    ) -> Result<Handle, String> {
        document::create(surface, store, changed)
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
    fn place_document(
        &self,
        document: Handle,
        insets: Insets,
        visible: bool,
    ) -> Result<(), String> {
        document::place(document, insets, visible);
        Ok(())
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
    ) -> Result<Handle, String> {
        image::create(surface, name, event)
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
    fn image_facts(&self, image: Handle) -> Result<String, String> {
        image::facts(image)
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
        image::present(image, token_id, &nonce, width, height, scale)
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
    fn after_settled(
        &self,
        view: &PlatformWebview,
        done: Box<dyn Fn(Result<f64, String>)>,
    ) -> Result<(), String> {
        layout::after_settled(view, done);
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
        receive: Duration,
        done: Box<dyn FnOnce(Delivery) + Send>,
    ) -> Result<(), String> {
        input::pointer(window, pointer, receive, done);
        Ok(())
    }
    fn input_activate(
        &self,
        window: Handle,
        x: f64,
        y: f64,
        timeout: Duration,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String> {
        input::activate(window, x, y, timeout, done);
        Ok(())
    }
    fn input_key(&self, window: Handle, key: &Key) -> Result<Delivery, String> {
        input::key(window, key)
    }

    #[cfg(feature = "diagnostics")]
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String> {
        capture::open(window_number, display)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_start(&self, directory: &str) -> Result<(), String> {
        capture::start(directory)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_wait(&self) -> Result<bool, String> {
        capture::wait()
    }
    #[cfg(feature = "diagnostics")]
    fn capture_stop(&self, after: f64) -> Result<i32, String> {
        capture::stop(after)
    }
    #[cfg(feature = "diagnostics")]
    fn capture_limited(&self) -> Result<bool, String> {
        Ok(capture::limited())
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
        seconds: f64,
        done: Box<dyn FnOnce(super::WindowObjects, bool) + Send>,
    ) -> Result<(), String> {
        window_objects::when(expected, seconds, done);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn when_process_exited(
        &self,
        pid: i32,
        seconds: f64,
        done: Box<dyn FnOnce(bool) + Send>,
    ) -> Result<(), String> {
        process_exit::when_exited(pid, seconds, done);
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_start(&self) -> Result<(), String> {
        capture::layout_trace_start();
        Ok(())
    }
    #[cfg(feature = "diagnostics")]
    fn layout_trace_stop(&self) -> Result<Vec<[f64; 4]>, String> {
        capture::layout_trace_stop()
    }
    #[cfg(feature = "diagnostics")]
    fn input_source(&self) -> Result<String, String> {
        input_source::current()
    }
    #[cfg(feature = "diagnostics")]
    fn select_input_source(&self, identifier: &str) -> Result<(), String> {
        input_source::select(identifier)
    }

    fn on_termination(&self, quit: Box<dyn Fn() + Send>) -> Result<(), String> {
        termination::on_termination(quit)
    }
    fn on_quit_request(&self, quit: Box<dyn Fn()>) -> Result<(), String> {
        termination::on_quit_request(quit)
    }
    fn answer_quit_requests(&self) {
        termination::answer_quit_requests()
    }
    fn instant_window_resize(&self) -> Result<(), String> {
        window::instant_resize();
        Ok(())
    }
    fn replace_standard_error(&self, file: &std::fs::File) -> Result<(), String> {
        standard_error::replace(file)
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

    fn menu_items(&self) -> Result<Value, String> {
        dock::menu()
    }
    fn menu_select(&self, menu: &str, title: &str) -> Result<(), String> {
        dock::menu_select(menu, title)
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
    fn clipboard_write_png(&self, bytes: &[u8]) -> Result<(), String> {
        clipboard::write_png(bytes)
    }
    fn open_link(&self, url: &str) -> Result<(), String> {
        link::open(url)
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
    fn write_private_file(&self, path: &Path, data: &[u8]) -> Result<(), String> {
        private_files::write_private_file(path, data)
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
    fn connect_service(&self, address: &str) -> Result<Box<dyn PersistentStream>, String> {
        connect_service(address)
    }
    fn secure_service_directory(&self, path: &Path) -> Result<(), String> {
        private_files::secure_service_directory(path)
    }
    fn service_process_exists(&self, pid: u32) -> Result<bool, String> {
        endpoint::service_process_exists(pid)
    }
    fn new_session(&self, command: &mut std::process::Command) -> Result<(), String> {
        endpoint::new_session(command);
        Ok(())
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

    fn set_read_deadline(&self, timeout: Option<std::time::Duration>) -> Result<(), String> {
        self.0.set_read_timeout(timeout).map_err(|e| e.to_string())
    }
}

fn connect_service(address: &str) -> Result<Box<dyn PersistentStream>, String> {
    UnixStream::connect(address)
        .map(|stream| Box::new(PersistentUnixStream(stream)) as Box<dyn PersistentStream>)
        .map_err(|error| error.to_string())
}
