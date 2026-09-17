//! 창 설정, 창 버튼, 창 번호.

use std::ffi::c_void;

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::Window;

use super::super::{Frame, Handle, WindowBuilder};
use super::NSRect;

/// 프로젝트 창의 제목 표시줄을 페이지 위에 겹치고 제목을 숨긴다. 비활성 창의 클릭도
/// 웹뷰에 전달한다.
pub fn prepare(builder: WindowBuilder<'_>) -> WindowBuilder<'_> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .accept_first_mouse(true)
}

/// 창의 NSWindow 주소를 반환한다.
pub fn handle(window: &Window) -> Result<Handle, String> {
    window.ns_window().map(|h| h as Handle).map_err(|e| e.to_string())
}

/// 창 버튼의 현재 영역을 배치를 바꾸지 않고 읽는다.
pub fn controls(window: Handle) -> Frame {
    let mut rect = [0.0; 4];
    unsafe {
        extern "C" {
            fn windowControls(window: *mut c_void, out: *mut f64);
        }
        windowControls(window as *mut c_void, rect.as_mut_ptr());
    }
    (rect[0], rect[1], rect[2], rect[3])
}

/// 창 버튼을 두 macOS 호스트가 공유하는 컨테이너에 배치한다.
pub fn place_controls(window: Handle, x: f64, y: f64) {
    unsafe {
        extern "C" {
            fn windowPlaceControls(window: *mut c_void, x: f64, y: f64);
        }
        windowPlaceControls(window as *mut c_void, x, y);
    }
}

#[cfg(feature = "diagnostics")]
/// 창 서버가 이 창과 이 창에 붙은 창에 부여한 번호를 반환한다.
///
/// 캡처 도구는 창 번호로 창 서버의 합성 결과(페이지, 표면, 모달)를 읽는다. 창을 앞으로
/// 가져오지 않고 다른 창의 포커스도 가져오지 않는다. 화면 영역 캡처는 앞에 있는 창을
/// 기록하고, 창을 앞으로 가져오면 측정 대상 상태가 바뀐다.
pub fn numbers(window: Handle) -> Vec<isize> {
    unsafe {
        let window = window as *mut AnyObject;
        if window.is_null() {
            return Vec::new();
        }
        let mut out = vec![msg_send![window, windowNumber]];
        let children: *mut AnyObject = msg_send![window, childWindows];
        if !children.is_null() {
            let count: usize = msg_send![children, count];
            for i in 0..count {
                let child: *mut AnyObject = msg_send![children, objectAtIndex: i];
                out.push(msg_send![child, windowNumber]);
            }
        }
        out
    }
}

/// 창 버튼(닫기, 최소화, 확대)의 그려진 영역과 숨김 여부를 콘텐츠 영역 왼쪽 위 기준으로 반환한다.
pub fn buttons(window: Handle) -> Vec<(Frame, bool)> {
    let mut out = Vec::new();
    unsafe {
        let window = window as *mut AnyObject;
        if window.is_null() {
            return out;
        }
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return out;
        }
        let bounds: NSRect = msg_send![content, bounds];
        // NSWindowCloseButton 0, NSWindowMiniaturizeButton 1, NSWindowZoomButton 2.
        for kind in 0usize..=2 {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: kind];
            if button.is_null() {
                continue;
            }
            let own: NSRect = msg_send![button, bounds];
            let drawn: NSRect = msg_send![button, alignmentRectForFrame: own];
            let rect: NSRect = msg_send![content, convertRect: drawn, fromView: button];
            let hidden: bool = msg_send![button, isHiddenOrHasHiddenAncestor];
            let top = bounds.size.y - (rect.origin.y + rect.size.y);
            out.push(((rect.origin.x, top, rect.size.x, rect.size.y), hidden));
        }
    }
    out
}
