//! 창 입력 감시와 웹뷰 포인터 라우팅 등록.
//!
//! 표면은 네이티브 뷰이므로 표면에 대한 입력은 페이지에 전달되지 않고 창만 받는다.
//! 포인터 라우팅은 native/darwin 에서 WebKit 비공개 입력 API 하나를 사용한다.

use std::cell::Cell;
use std::ffi::c_void;

use block2::RcBlock;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use tauri::webview::PlatformWebview;

use super::super::Handle;
use super::{NSPoint, NSRect};

/// 애플리케이션 웹뷰를 공통 네이티브 포인터 라우팅에 등록하고 등록 여부를 반환한다.
pub fn register(view: &PlatformWebview) -> bool {
    extern "C" {
        fn webviewInputRegister(view: *const c_void) -> Bool;
    }
    unsafe { webviewInputRegister(view.inner().cast()).as_bool() }
}

/// 창이 받는 입력의 대상 뷰와 위치를 전달한다.
///
/// pressed 는 입력을 받는 뷰부터 창 콘텐츠 뷰까지의 뷰 주소 목록을 받는다. AppKit 이 정한
/// 대상 뷰를 이 앱이 만든 뷰와 비교하므로 좌표를 변환하지 않는다. 키 입력은 창의 first
/// responder 를 대상으로 한다. 스스로 포커스를 잡는 페이지(예: 검색 필드에 포커스를 두는
/// google.com)도 이 경로로 페이지 모델의 선택 표면을 갱신한다.
///
/// pointed 는 왼쪽 버튼 드래그의 각 단계를 (단계, x, y) 로 받는다. 단계는 0 누름, 1 이동,
/// 2 놓음이고 y 는 콘텐츠 뷰 위쪽 기준이다. 경계선의 잡기 영역은 카드 사이 간격보다 넓어서,
/// 간격이 한 줄이면 잡기 영역 전체가 표면 위에 놓이고 페이지는 누름을 받지 못한다. 그래서
/// 이 경로는 좌표를 변환해 전달하고 호출자가 페이지 좌표로 바꾼다.
///
/// 감시기는 이벤트를 바꾸지 않고 반환하므로 원래 대상 뷰도 이벤트를 받는다.
pub fn watch(
    window: Handle,
    pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
    pointed: Box<dyn Fn(u8, f64, f64)>,
) -> Handle {
    const NS_EVENT_MASK_LEFT_MOUSE_DOWN: u64 = 1 << 1;
    const NS_EVENT_MASK_LEFT_MOUSE_UP: u64 = 1 << 2;
    const NS_EVENT_MASK_LEFT_MOUSE_DRAGGED: u64 = 1 << 6;
    const NS_EVENT_MASK_KEY_DOWN: u64 = 1 << 10;
    const NS_EVENT_TYPE_LEFT_MOUSE_DOWN: u64 = 1;
    const NS_EVENT_TYPE_LEFT_MOUSE_UP: u64 = 2;
    const NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED: u64 = 6;

    let window = window as *mut AnyObject;
    // 버튼을 이 앱의 뷰에서 눌렀는지 기록한다. 페이지에서 시작한 드래그는 페이지가 처리한다.
    // 그 드래그를 전달하면 화면을 다시 그리는 스레드에 포인터 이동마다 메시지가 추가된다.
    let dragging = Cell::new(false);
    let handler = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
        unsafe {
            if event.is_null() {
                return event;
            }
            let from: *mut AnyObject = msg_send![event, window];
            if from != window {
                return event;
            }
            let content: *mut AnyObject = msg_send![window, contentView];
            if content.is_null() {
                return event;
            }
            let kind: u64 = msg_send![event, type];
            let point: NSPoint = msg_send![event, locationInWindow];
            let bounds: NSRect = msg_send![content, bounds];
            // 이동과 놓음은 뷰를 다시 판정하지 않는다. 누름이 이 앱이 전달할 드래그인지 정했다.
            if kind == NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED || kind == NS_EVENT_TYPE_LEFT_MOUSE_UP {
                if dragging.get() {
                    let phase = if kind == NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED { 1 } else { 2 };
                    pointed(phase, point.x, bounds.size.y - point.y);
                    if kind == NS_EVENT_TYPE_LEFT_MOUSE_UP {
                        dragging.set(false);
                    }
                }
                return event;
            }
            let mut view: *mut AnyObject = if kind == NS_EVENT_TYPE_LEFT_MOUSE_DOWN {
                msg_send![content, hitTest: point]
            } else {
                let first: *mut AnyObject = msg_send![window, firstResponder];
                let class = AnyClass::get(c"NSView").expect("NSView");
                let is_view: bool = msg_send![first, isKindOfClass: class];
                if is_view { first } else { std::ptr::null_mut() }
            };
            let mut chain = Vec::new();
            while !view.is_null() {
                chain.push(view as Handle);
                if view == content {
                    break;
                }
                view = msg_send![view, superview];
            }
            let ours = pressed(chain);
            if kind == NS_EVENT_TYPE_LEFT_MOUSE_DOWN {
                dragging.set(ours);
                if ours {
                    pointed(0, point.x, bounds.size.y - point.y);
                }
            }
            event
        }
    });
    unsafe {
        let class = AnyClass::get(c"NSEvent").expect("NSEvent");
        let monitor: *mut AnyObject = msg_send![
            class,
            addLocalMonitorForEventsMatchingMask: NS_EVENT_MASK_LEFT_MOUSE_DOWN
                | NS_EVENT_MASK_LEFT_MOUSE_DRAGGED
                | NS_EVENT_MASK_LEFT_MOUSE_UP
                | NS_EVENT_MASK_KEY_DOWN,
            handler: &*handler,
        ];
        monitor as Handle
    }
}

/// 입력 감시기를 제거한다. 0 은 무시한다.
pub fn unwatch(monitor: Handle) {
    if monitor == 0 {
        return;
    }
    unsafe {
        let class = AnyClass::get(c"NSEvent").expect("NSEvent");
        let _: () = msg_send![class, removeMonitor: monitor as *mut AnyObject];
    }
}
