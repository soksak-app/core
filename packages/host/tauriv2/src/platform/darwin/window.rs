//! 창 설정, 창 버튼, 창 번호.

use std::ffi::{c_char, c_void, CStr};

#[cfg(feature = "diagnostics")]
use objc2::msg_send;
#[cfg(feature = "diagnostics")]
use objc2::runtime::AnyObject;
use serde_json::Value;
use tauri::Window;

use super::super::{Frame, Handle, WindowBuilder};

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

/// 창 버튼을 두 macOS 호스트가 공유하는 컨테이너에 배치한다. 둘 수 없으면 오류를 반환한다.
pub fn place_controls(window: Handle, x: f64, centre_y: f64) -> Result<(), String> {
    extern "C" {
        fn windowPlaceControls(window: *mut c_void, x: f64, centre_y: f64) -> bool;
    }
    if unsafe { windowPlaceControls(window as *mut c_void, x, centre_y) } {
        Ok(())
    } else {
        Err("the window has no standard buttons or content view to place".into())
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

/// native/darwin 이 반환한 JSON 문자열을 읽고 해제한다.
pub(super) fn facts_value(text: *mut c_char, what: &str) -> Result<Value, String> {
    extern "C" {
        fn sp_facts_free(text: *mut c_char);
    }
    if text.is_null() {
        return Err(format!("{what}: the window is gone"));
    }
    let parsed = serde_json::from_slice(unsafe { CStr::from_ptr(text) }.to_bytes()).map_err(|e| format!("{what}: {e}"));
    unsafe { sp_facts_free(text) };
    parsed
}

/// 창의 프레임, 활성 상태, 창 버튼과 웹뷰.
pub fn facts(window: Handle) -> Result<Value, String> {
    extern "C" {
        fn sp_window_facts(window: *mut c_void) -> *mut c_char;
    }
    facts_value(unsafe { sp_window_facts(window as *mut c_void) }, "window state")
}

/// 창 프레임의 왼쪽 위를 화면 좌표로 옮긴다.
pub fn move_to(window: Handle, x: f64, y: f64) -> Result<(), String> {
    extern "C" {
        fn sp_window_move(window: *mut c_void, x: f64, y: f64) -> bool;
    }
    if unsafe { sp_window_move(window as *mut c_void, x, y) } {
        Ok(())
    } else {
        Err("window placement: the window is gone".into())
    }
}

/// 디스플레이 목록.
pub fn screens() -> Result<Value, String> {
    extern "C" {
        fn sp_screens() -> *mut c_char;
    }
    facts_value(unsafe { sp_screens() }, "display list")
}
