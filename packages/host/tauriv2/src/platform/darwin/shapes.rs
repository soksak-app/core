//! 표면 위에 그리는 도형 뷰.
//!
//! 도형은 웹뷰가 아닌 레이어 기반 NSView 이다. 채움 색과 선 색의 알파가 표면 내용 위에
//! 합성된다. 웹뷰는 WebKit 이 불투명한 배경을 그리고, 이를 끄는 키는 비공개이다.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};

use super::super::{Frame, Handle};
use super::NSRect;

/// 창 콘텐츠 뷰에 레이어 기반 뷰를 추가하고 주소를 반환한다. 만들지 못하면 0 을 반환한다.
pub fn create(window: Handle, rect: Frame) -> Handle {
    unsafe {
        let window = window as *mut AnyObject;
        if window.is_null() {
            return 0;
        }
        let Some(class) = AnyClass::get(c"NSView") else {
            return 0;
        };
        let view: *mut AnyObject = msg_send![class, alloc];
        let view: *mut AnyObject = msg_send![view, initWithFrame: NSRect::from(rect)];
        if view.is_null() {
            return 0;
        }
        let _: () = msg_send![view, setWantsLayer: true];
        let content: *mut AnyObject = msg_send![window, contentView];
        // NSWindowAbove 는 1 이다. 뷰를 기존 형제 뷰 위에 추가한다.
        let _: () = msg_send![content, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
        view as Handle
    }
}

/// 도형 뷰를 배치하고 형제 뷰 위로 올린다.
///
/// 나중에 추가한 뷰가 먼저 추가한 뷰 위에 있으므로, 표면 웹뷰보다 먼저 그린 도형은 표면 아래에
/// 놓인다. 소수 좌표의 가장자리는 흐리게 그려지므로 표면과 같이 디스플레이 픽셀에 맞춘다.
pub fn place(view: Handle, rect: Frame) {
    unsafe {
        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setFrame: aligned_in_window(view, rect)];
        raise(view);
    }
}

/// 뷰가 속한 창의 디스플레이 픽셀에 사각형을 맞춘다.
unsafe fn aligned_in_window(view: *mut AnyObject, rect: Frame) -> NSRect {
    let window: *mut AnyObject = msg_send![view, window];
    if window.is_null() {
        return NSRect::from(rect);
    }
    // NSAlignAllEdgesInward 는 MinX|MinY|MaxX|MaxY 로 하위 네 옵션 비트이다.
    msg_send![window, backingAlignedRect: NSRect::from(rect), options: 15usize]
}

/// 뷰를 콘텐츠 뷰의 모든 형제 뷰 위로 올린다.
unsafe fn raise(view: *mut AnyObject) {
    let parent: *mut AnyObject = msg_send![view, superview];
    if parent.is_null() {
        return;
    }
    // NSWindowAbove 는 1 이다.
    let _: () = msg_send![parent, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
}

/// 도형의 모서리 반경, 선 두께, 채움 색, 선 색을 설정한다.
pub fn style(view: Handle, radius: f64, line_width: f64, fill: [f64; 4], line: [f64; 4]) {
    unsafe {
        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let Some(colour) = AnyClass::get(c"NSColor") else {
            return;
        };
        let fill_ns: *mut AnyObject = msg_send![colour, colorWithSRGBRed: fill[0], green: fill[1], blue: fill[2], alpha: fill[3]];
        let line_ns: *mut AnyObject = msg_send![colour, colorWithSRGBRed: line[0], green: line[1], blue: line[2], alpha: line[3]];
        let fill_cg: *mut AnyObject = msg_send![fill_ns, CGColor];
        let line_cg: *mut AnyObject = msg_send![line_ns, CGColor];
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setBorderWidth: line_width];
        let _: () = msg_send![layer, setBackgroundColor: fill_cg];
        let _: () = msg_send![layer, setBorderColor: line_cg];
    }
}

/// 도형 뷰를 제거한다.
pub fn destroy(view: Handle) {
    unsafe {
        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, removeFromSuperview];
        // alloc 이 반환한 참조를 해제한다. 상위 뷰의 참조는 위 줄에서 해제되었다.
        let _: () = msg_send![view, release];
    }
}
