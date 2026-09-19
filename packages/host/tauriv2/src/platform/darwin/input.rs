//! 창 입력 감시, 웹뷰 포인터 라우팅 등록, 네이티브 입력 전달, 위치 판정.
//!
//! 표면은 네이티브 뷰이므로 표면에 대한 입력은 페이지에 전달되지 않고 창만 받는다.
//! 포인터 라우팅은 native/darwin 에서 WebKit 비공개 입력 API 하나를 사용한다.

use std::cell::Cell;
use std::ffi::{c_char, c_void, CString};

use block2::RcBlock;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use tauri::webview::PlatformWebview;

use std::time::Duration;

use super::super::{Delivery, Handle, Hit, Key, Pointer};
use super::{NSPoint, NSRect};

extern "C" {
    fn sp_input_pointer_then(
        window: *mut c_void,
        x: f64,
        y: f64,
        phase: i32,
        button: i32,
        delta_x: f64,
        delta_y: f64,
        receive: f64,
        done: extern "C" fn(*mut c_void, i32),
        context: *mut c_void,
    );
    fn sp_input_activate(
        window: *mut c_void,
        timeout: f64,
        done: extern "C" fn(*mut c_void, i32, *const c_char),
        context: *mut c_void,
    );
    fn sp_input_key(
        window: *mut c_void,
        key: *const c_char,
        text: *const c_char,
        modifiers: u32,
        down: bool,
    ) -> bool;
}

/// sp_input_pointer 의 결과 값.
const SP_INPUT_DELIVERED: i32 = 0;
const SP_INPUT_INACTIVE: i32 = 2;
const SP_INPUT_UNRECEIVED: i32 = 3;

type Delivered = Box<dyn FnOnce(Delivery) + Send>;

extern "C" fn delivered(context: *mut c_void, result: i32) {
    // context 는 pointer 가 Box::into_raw 로 넘긴 값이고 라이브러리는 done 을 한 번 호출한다.
    let done = unsafe { Box::from_raw(context as *mut Delivered) };
    done(match result {
        SP_INPUT_DELIVERED => Delivery::Delivered,
        SP_INPUT_INACTIVE => Delivery::Inactive,
        SP_INPUT_UNRECEIVED => Delivery::Unreceived,
        _ => Delivery::Rejected,
    });
}

/// 창에 포인터 입력을 전달하고 결과를 done 으로 알린다. 누름과 뗌은 문서가 받은 뒤 알린다.
/// 메인 스레드에서 호출한다.
pub fn pointer(window: Handle, pointer: Pointer, receive: Duration, done: Delivered) {
    let context = Box::into_raw(Box::new(done)) as *mut c_void;
    unsafe {
        sp_input_pointer_then(
            window as *mut c_void,
            pointer.x,
            pointer.y,
            pointer.phase,
            pointer.button,
            pointer.delta_x,
            pointer.delta_y,
            receive.as_secs_f64(),
            delivered,
            context,
        )
    }
}

type Activated = Box<dyn FnOnce(Result<(), String>) + Send>;

/// sp_input_activate 의 결과 값.
const SP_ACTIVATE_DONE: i32 = 0;
const SP_ACTIVATE_REFUSED: i32 = 2;
const SP_ACTIVATE_NOT_KEY: i32 = 3;
const SP_ACTIVATE_PENDING: i32 = 4;
const SP_ACTIVATE_LOST: i32 = 5;

struct Activation {
    timeout: Duration,
    done: Activated,
}

extern "C" fn activated(context: *mut c_void, result: i32, frontmost: *const c_char) {
    // context 는 activate 가 Box::into_raw 로 넘긴 값이고 라이브러리는 done 을 한 번 호출한다.
    let activation = unsafe { Box::from_raw(context as *mut Activation) };
    let frontmost = if frontmost.is_null() {
        "unknown".to_string()
    } else {
        unsafe { std::ffi::CStr::from_ptr(frontmost) }
            .to_string_lossy()
            .into_owned()
    };
    (activation.done)(activation_result(
        result,
        activation.timeout.as_secs_f64(),
        &frontmost,
    ));
}

/// 활성화 결과를 멈춘 단계와 최전면 애플리케이션을 적은 오류로 바꾼다.
fn activation_result(result: i32, timeout: f64, frontmost: &str) -> Result<(), String> {
    match result {
        SP_ACTIVATE_DONE => Ok(()),
        SP_ACTIVATE_REFUSED => Err(format!(
            "the system did not activate the application within {timeout}s; the frontmost application is {frontmost}"
        )),
        SP_ACTIVATE_NOT_KEY => Err(format!(
            "the application is active but the window did not become key within {timeout}s; the frontmost application is {frontmost}"
        )),
        SP_ACTIVATE_PENDING => Err(format!("the window's webviews did not apply the active state within {timeout}s")),
        SP_ACTIVATE_LOST => Err(format!(
            "the window lost activation before its webviews applied it; the frontmost application is {frontmost}"
        )),
        _ => Err("the window cannot be activated".to_string()),
    }
}

/// 애플리케이션을 활성화하고 창을 키 창으로 만든 뒤 done 을 호출한다. 메인 스레드에서 호출한다.
pub fn activate(window: Handle, timeout: Duration, done: Activated) {
    let context = Box::into_raw(Box::new(Activation { timeout, done })) as *mut c_void;
    unsafe {
        sp_input_activate(
            window as *mut c_void,
            timeout.as_secs_f64(),
            activated,
            context,
        )
    }
}

/// 창에 키 입력을 전달하고 전달 여부를 반환한다. 메인 스레드에서 호출한다. NUL 문자를 포함한
/// 키 이름과 문자열은 오류를 반환한다.
pub fn key(window: Handle, key: &Key) -> Result<bool, String> {
    let name = CString::new(key.key.as_str()).map_err(|e| e.to_string())?;
    let text = key
        .text
        .as_deref()
        .map(CString::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let text = text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr());
    Ok(unsafe {
        sp_input_key(
            window as *mut c_void,
            name.as_ptr(),
            text,
            key.modifiers,
            key.down,
        )
    })
}

/// 콘텐츠 영역 왼쪽 위 기준 점 x, y 에 있는 뷰와 그 상위 뷰 목록을 반환한다. 메인 스레드에서 호출한다.
pub fn hit(window: Handle, x: f64, y: f64) -> Result<Hit, String> {
    unsafe {
        let window = window as *mut AnyObject;
        if window.is_null() {
            return Err("window is gone".into());
        }
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return Err("window has no content view".into());
        }
        let bounds: NSRect = msg_send![content, bounds];
        // hitTest: 는 받는 뷰의 부모 좌표를 사용한다.
        let local = NSPoint {
            x,
            y: bounds.size.y - y,
        };
        let parent: *mut AnyObject = msg_send![content, superview];
        let point: NSPoint = msg_send![content, convertPoint: local, toView: parent];
        let found: *mut AnyObject = msg_send![content, hitTest: point];
        let mut identifier = String::new();
        if !found.is_null() {
            let name: *mut AnyObject = msg_send![found, identifier];
            if !name.is_null() {
                let text: *const c_char = msg_send![name, UTF8String];
                if !text.is_null() {
                    identifier = std::ffi::CStr::from_ptr(text)
                        .to_string_lossy()
                        .into_owned();
                }
            }
        }
        let mut chain = Vec::new();
        let mut view = found;
        while !view.is_null() {
            chain.push(view as Handle);
            if view == content {
                break;
            }
            view = msg_send![view, superview];
        }
        Ok(Hit { chain, identifier })
    }
}

/// 애플리케이션 웹뷰를 공통 네이티브 포인터 라우팅에 등록하고 등록 여부를 반환한다.
pub fn register(view: &PlatformWebview) -> bool {
    extern "C" {
        fn webviewInputRegister(view: *const c_void) -> Bool;
    }
    unsafe { webviewInputRegister(view.inner().cast()).as_bool() }
}

/// 웹뷰의 페이지가 요소에 초점을 줘도 창의 키보드 초점을 옮기지 않게 하고 성공 여부를 반환한다.
pub fn ignore_page_focus(view: &PlatformWebview) -> bool {
    extern "C" {
        fn webviewIgnorePageFocus(view: *const c_void) -> Bool;
    }
    unsafe { webviewIgnorePageFocus(view.inner().cast()).as_bool() }
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
                    let phase = if kind == NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED {
                        1
                    } else {
                        2
                    };
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
                if is_view {
                    first
                } else {
                    std::ptr::null_mut()
                }
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
