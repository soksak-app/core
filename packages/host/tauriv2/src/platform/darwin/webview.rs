//! 네이티브 웹뷰의 배치, 불투명도, 크기 변경 알림, 순서, 모서리.
//!
//! 모달은 별도 웹뷰가 그리고 웹뷰는 사각형이다. 모서리를 둥글게 하려면 NSView 의 CALayer 에
//! 모서리 반경을 설정해 뷰를 자른다. 잘린 모서리에는 모달 뒤의 내용이 보인다. 투명도나
//! 비공개 인터페이스를 사용하지 않는다.

use std::ffi::{c_char, c_void, CStr};

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::webview::PlatformWebview;

use super::super::{visible_window_overlay_rects, DOMOverlay, Handle, WindowOverlay};

type FileDropEvent = extern "C" fn(*mut c_void, *const c_char);

extern "C" {
    fn sp_window_file_drop(
        main_webview: *mut c_void,
        event: FileDropEvent,
        context: *mut c_void,
    ) -> bool;
    fn sp_webview_set_appearance(view: *mut c_void, dark: bool) -> bool;
    fn sp_surface_create(main_webview: *mut c_void) -> *mut c_void;
    fn sp_surface_close(surface: *mut c_void);
    fn webviewSetFrame(view: *mut c_void, x: f64, y: f64, width: f64, height: f64);
    fn sp_surface_set_window_overlays(main: *mut c_void, rects: *const f64, count: usize);
}

pub fn create_surface(main: Handle) -> Result<Handle, String> {
    let surface = unsafe { sp_surface_create(main as *mut c_void) } as Handle;
    if surface == 0 {
        Err("cannot create SurfaceHost".into())
    } else {
        Ok(surface)
    }
}

pub fn close_surface(surface: Handle) {
    unsafe { sp_surface_close(surface as *mut c_void) }
}

pub fn place_surface(surface: Handle, x: f64, y: f64, w: f64, h: f64) {
    unsafe { webviewSetFrame(surface as *mut c_void, x, y, w, h) }
}

pub fn surface_frame(surface: Handle) -> [f64; 4] {
    extern "C" {
        fn webviewGetFrame(view: *mut c_void, rect: *mut f64);
    }
    let mut rect = [0.0; 4];
    unsafe { webviewGetFrame(surface as *mut c_void, rect.as_mut_ptr()) };
    rect
}

pub fn set_surface_hidden_handle(surface: Handle, hidden: bool) {
    extern "C" {
        fn webviewSetSurfaceHidden(view: *mut c_void, hidden: bool);
    }
    unsafe { webviewSetSurfaceHidden(surface as *mut c_void, hidden) }
}

pub fn set_surface_alpha_handle(surface: Handle, alpha: f64) {
    extern "C" {
        fn webviewSetSurfaceAlpha(view: *mut c_void, alpha: f64);
    }
    unsafe { webviewSetSurfaceAlpha(surface as *mut c_void, alpha) }
}

pub fn set_main_appearance(view: &PlatformWebview, dark: bool) -> Result<(), String> {
    let view = view.inner() as *mut c_void;
    if !unsafe { sp_webview_set_appearance(view, dark) } {
        return Err("requested app appearance is unavailable".into());
    }
    Ok(())
}

/// 창의 파일 놓기 뷰에 놓인 파일을 받는 함수. 창이 살아 있는 동안 네이티브 뷰가 가리킨다.
struct FileDropReceiver(Box<dyn Fn(String)>);

extern "C" fn file_drop_callback(context: *mut c_void, json: *const c_char) {
    let receiver = unsafe { &*(context as *const FileDropReceiver) };
    let json = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(json);
}

/// main 웹뷰의 창에 놓인 파일을 receive 로 받는다. 메인 스레드에서 호출한다.
pub fn file_drop(main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(FileDropReceiver(receive)));
    if unsafe {
        sp_window_file_drop(
            main as *mut c_void,
            file_drop_callback,
            receiver as *mut c_void,
        )
    } {
        Ok(())
    } else {
        drop(unsafe { Box::from_raw(receiver) });
        Err("the main webview has no window composition for file drops".into())
    }
}

pub fn set_window_overlays(main: Handle, overlays: &[WindowOverlay]) {
    let values = visible_window_overlay_rects(overlays);
    unsafe {
        sp_surface_set_window_overlays(main as *mut c_void, values.as_ptr(), values.len() / 4)
    }
}

/// radius 논리 픽셀의 모서리 반경을 적용한다.
pub fn corners(webview: &PlatformWebview, radius: f64) {
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
}

/// 뷰의 불투명도를 설정한다. 포커스를 잃은 표면은 흐리게 그릴 수 있다.
pub fn alpha(webview: &PlatformWebview, alpha: f64) {
    extern "C" {
        fn webviewSetSurfaceAlpha(view: *mut c_void, alpha: f64);
    }
    unsafe { webviewSetSurfaceAlpha(webview.inner().cast(), alpha) }
}

/// 창 좌표를 네이티브 뷰의 부모 좌표로 변환해 배치한다.
pub fn place(webview: &PlatformWebview, x: f64, y: f64, w: f64, h: f64) {
    extern "C" {
        fn webviewSetFrame(view: *mut c_void, x: f64, y: f64, w: f64, h: f64);
    }
    unsafe { webviewSetFrame(webview.inner().cast(), x, y, w, h) }
}

/// 콘텐츠 웹뷰를 장치 픽셀 좌표의 공통 컨테이너에 등록한다.
pub fn attach_surface(webview: &PlatformWebview, main: Handle) {
    extern "C" {
        fn webviewAttachSurface(view: *mut c_void, main: *mut c_void);
    }
    unsafe { webviewAttachSurface(webview.inner().cast(), main as *mut c_void) }
}

pub fn detach_surface(webview: &PlatformWebview) {
    extern "C" {
        fn webviewDetachSurface(view: *mut c_void);
    }
    unsafe { webviewDetachSurface(webview.inner().cast()) }
}

pub fn hidden(webview: &PlatformWebview, hidden: bool) {
    extern "C" {
        fn webviewSetSurfaceHidden(view: *mut c_void, hidden: bool);
    }
    unsafe { webviewSetSurfaceHidden(webview.inner().cast(), hidden) }
}

pub fn overlays(surface: Handle, overlays: &[DOMOverlay]) {
    extern "C" {
        fn webviewSetSurfaceOverlays(view: *mut c_void, values: *const f64, count: usize);
    }
    let mut values = Vec::with_capacity(overlays.len() * 5);
    for overlay in overlays {
        values.extend_from_slice(&[
            overlay.insets.left,
            overlay.insets.top,
            overlay.insets.right,
            overlay.insets.bottom,
            if overlay.visible { 1.0 } else { 0.0 },
        ]);
    }
    unsafe { webviewSetSurfaceOverlays(surface as *mut c_void, values.as_ptr(), overlays.len()) }
}

/// 웹뷰의 현재 위치와 크기를 페이지 좌표로 반환한다.
pub fn frame(webview: &PlatformWebview) -> [f64; 4] {
    extern "C" {
        fn webviewGetFrame(view: *mut c_void, rect: *mut f64);
    }
    let mut rect = [0.0; 4];
    unsafe { webviewGetFrame(webview.inner().cast(), rect.as_mut_ptr()) }
    rect
}

/// 연속적인 표면 크기 변경의 시작과 종료를 웹뷰에 전달한다.
pub fn live_resize(webview: &PlatformWebview, live: bool) {
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        if live {
            let _: () = msg_send![view, viewWillStartLiveResize];
        } else {
            let _: () = msg_send![view, viewDidEndLiveResize];
        }
    }
}

/// 웹뷰를 같은 부모의 다른 뷰 위로 올린다.
pub fn raise(webview: &PlatformWebview) {
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        let parent: *mut AnyObject = msg_send![view, superview];
        // NSWindowAbove 는 1 이다.
        let _: () = msg_send![parent, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
    }
}

/// 웹뷰를 창의 첫 응답자로 만든다. 메인 스레드에서 호출한다.
pub fn focus(webview: &PlatformWebview) -> Result<(), String> {
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() {
            return Err("the webview is not in a window".into());
        }
        let taken: bool = msg_send![window, makeFirstResponder: view];
        if taken {
            Ok(())
        } else {
            Err("the window did not give the webview keyboard focus".into())
        }
    }
}

/// 웹뷰가 그리는 뷰의 주소를 반환한다. 입력 체인의 뷰 주소와 비교해 웹뷰를 식별한다.
pub fn id(webview: &PlatformWebview) -> Handle {
    webview.inner() as Handle
}
