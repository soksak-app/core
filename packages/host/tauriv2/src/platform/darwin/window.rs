//! 창 설정, 창 버튼, 창 번호.

use std::ffi::{c_char, c_void, CStr};

use block2::{Block, RcBlock};

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
    window
        .ns_window()
        .map(|h| h as Handle)
        .map_err(|e| e.to_string())
}

pub fn set_main_webview(window: Handle, main: Handle) -> Result<(), String> {
    extern "C" {
        fn sp_window_set_main_webview(window: *mut c_void, main: *mut c_void) -> bool;
    }
    if unsafe { sp_window_set_main_webview(window as *mut c_void, main as *mut c_void) } {
        Ok(())
    } else {
        Err("the main webview is not in the window hierarchy".into())
    }
}

pub fn reveal_after_load(window: Handle) -> Result<(), String> {
    extern "C" {
        fn sp_window_reveal_after_load(window: *mut c_void, error: *mut *mut c_char) -> bool;
        fn free(pointer: *mut c_void);
    }
    let mut error = std::ptr::null_mut();
    if unsafe { sp_window_reveal_after_load(window as *mut c_void, &mut error) } {
        return Ok(());
    }
    let message = unsafe { CStr::from_ptr(error) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(error as *mut c_void) };
    Err(message)
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

/// 창을 전체 화면으로 바꾸거나 되돌리고 전환이 끝나면 done 을 호출한다.
pub fn fullscreen(window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String> {
    extern "C" {
        fn sp_window_fullscreen(window: *mut c_void, on: bool, done: &Block<dyn Fn()>) -> bool;
    }
    let done = RcBlock::new(done);
    if unsafe { sp_window_fullscreen(window as *mut c_void, on, &done) } {
        Ok(())
    } else {
        Err("the window does not support full screen".into())
    }
}

/// 창의 가림 상태가 바뀔 때마다 changed 를 호출한다(NSWindowDidChangeOcclusionStateNotification).
pub fn observe_occlusion(window: Handle, changed: Box<dyn Fn()>) -> Result<(), String> {
    extern "C" {
        fn sp_window_observe_occlusion(window: *mut c_void, changed: &Block<dyn Fn()>) -> bool;
    }
    let changed = RcBlock::new(changed);
    if unsafe { sp_window_observe_occlusion(window as *mut c_void, &changed) } {
        Ok(())
    } else {
        Err("the window occlusion cannot be observed without a window".into())
    }
}

/// 창의 제목줄을 도구막대 높이로 만들고 그 높이를 반환한다. 만들 수 없으면 오류를 반환한다.
pub fn unified_titlebar(window: Handle) -> Result<f64, String> {
    extern "C" {
        fn windowUnifiedTitlebar(window: *mut c_void) -> f64;
    }
    let row = unsafe { windowUnifiedTitlebar(window as *mut c_void) };
    if row > 0.0 {
        Ok(row)
    } else {
        Err("the window has no standard buttons or content view for a title bar".into())
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
    let parsed = serde_json::from_slice(unsafe { CStr::from_ptr(text) }.to_bytes())
        .map_err(|e| format!("{what}: {e}"));
    unsafe { sp_facts_free(text) };
    parsed
}

/// 창의 프레임, 활성 상태, 창 버튼과 웹뷰.
pub fn facts(window: Handle) -> Result<Value, String> {
    extern "C" {
        fn sp_window_facts(window: *mut c_void) -> *mut c_char;
    }
    facts_value(
        unsafe { sp_window_facts(window as *mut c_void) },
        "window state",
    )
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

/// 창 확대와 애니메이션 크기 변경을 한 화면 갱신 안에 끝나게 한다.
pub fn instant_resize() {
    extern "C" {
        fn windowResizeInstant();
    }
    unsafe { windowResizeInstant() }
}
