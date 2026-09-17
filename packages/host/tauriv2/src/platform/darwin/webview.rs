//! 네이티브 웹뷰의 배치, 불투명도, 크기 변경 알림, 순서, 모서리.
//!
//! 모달은 별도 웹뷰가 그리고 웹뷰는 사각형이다. 모서리를 둥글게 하려면 NSView 의 CALayer 에
//! 모서리 반경을 설정해 뷰를 자른다. 잘린 모서리에는 모달 뒤의 내용이 보인다. 투명도나
//! 비공개 인터페이스를 사용하지 않는다.

use std::ffi::c_void;

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::webview::PlatformWebview;

use super::super::Handle;

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
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setAlphaValue: alpha];
    }
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

/// 웹뷰가 그리는 뷰의 주소를 반환한다. 입력 체인의 뷰 주소와 비교해 웹뷰를 식별한다.
pub fn id(webview: &PlatformWebview) -> Handle {
    webview.inner() as Handle
}

