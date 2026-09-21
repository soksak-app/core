//! 표면 문서 안의 외부 문서 웹뷰. 구현은 native/darwin 의 document_view.m 이다.

use std::ffi::{c_char, c_void, CStr, CString};

use super::super::{Handle, Insets};

type Changed = extern "C" fn(*mut c_void, *const c_char);
type Event = extern "C" fn(*mut c_void, *const c_char);

extern "C" {
    fn sp_document_create(
        surface: *mut c_void,
        store: *const c_char,
        changed: Changed,
        context: *mut c_void,
    ) -> *mut c_void;
    fn sp_document_set_event(document: *mut c_void, event: Event, context: *mut c_void);
    fn sp_document_load(document: *mut c_void, url: *const c_char) -> bool;
    fn sp_document_go(document: *mut c_void, action: i32) -> bool;
    fn sp_document_place(
        document: *mut c_void,
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
        visible: bool,
    );
    fn sp_document_background(document: *mut c_void, enabled: bool);
    fn sp_document_appearance(document: *mut c_void, dark: bool);
    fn sp_document_close(document: *mut c_void);
}

/// 문서 핸들별 상태 수신 함수. 메인 스레드에서만 쓴다.
struct Receiver(Box<dyn Fn(String)>);
struct EventReceiver(Box<dyn Fn(String) + Send>);

thread_local! {
    static RECEIVERS: std::cell::RefCell<std::collections::HashMap<Handle, *mut Receiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static EVENTS: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

extern "C" fn changed(context: *mut c_void, state: *const c_char) {
    let receiver = unsafe { &*(context as *const Receiver) };
    let state = unsafe { CStr::from_ptr(state) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(state);
}

extern "C" fn event(context: *mut c_void, value: *const c_char) {
    let receiver = unsafe { &*(context as *const EventReceiver) };
    let value = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(value);
}

/// 표면 웹뷰 안에 문서 웹뷰를 숨긴 상태로 만든다. 메인 스레드에서 호출한다.
pub fn create(
    surface: Handle,
    store: &str,
    receive: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    let store = CString::new(store).map_err(|e| e.to_string())?;
    let receiver = Box::into_raw(Box::new(Receiver(receive)));
    let document = unsafe {
        sp_document_create(
            surface as *mut c_void,
            store.as_ptr(),
            changed,
            receiver as *mut c_void,
        )
    };
    if document.is_null() {
        drop(unsafe { Box::from_raw(receiver) });
        return Err("cannot create a document view in this surface".into());
    }
    let handle = document as Handle;
    RECEIVERS.with(|all| all.borrow_mut().insert(handle, receiver));
    Ok(handle)
}

/// http 또는 https 주소를 연다. 그 밖의 주소이면 false 를 반환한다.
pub fn load(document: Handle, url: &str) -> Result<bool, String> {
    let url = CString::new(url).map_err(|e| e.to_string())?;
    Ok(unsafe { sp_document_load(document as *mut c_void, url.as_ptr()) })
}

pub fn set_event(document: Handle, receive: Box<dyn Fn(String) + Send>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EventReceiver(receive)));
    unsafe { sp_document_set_event(document as *mut c_void, event, receiver as *mut c_void) };
    EVENTS.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

/// 뒤로 0, 앞으로 1, 다시 읽기 2, 멈춤 3 을 실행하고 실행했는지 반환한다.
pub fn go(document: Handle, action: i32) -> bool {
    unsafe { sp_document_go(document as *mut c_void, action) }
}

/// 표면 뷰포트의 CSS 픽셀 여백으로 문서 영역을 정한다.
pub fn place(document: Handle, insets: Insets, visible: bool) {
    unsafe {
        sp_document_place(
            document as *mut c_void,
            insets.left,
            insets.top,
            insets.right,
            insets.bottom,
            visible,
        )
    }
}

/// 대화 상자가 열린 동안 문서를 흐리게 표시한다.
pub fn background(document: Handle, enabled: bool) {
    unsafe { sp_document_background(document as *mut c_void, enabled) }
}

pub fn appearance(document: Handle, dark: bool) {
    unsafe { sp_document_appearance(document as *mut c_void, dark) }
}

/// 문서 웹뷰를 제거하고 상태 수신 함수를 해제한다.
pub fn close(document: Handle) {
    unsafe { sp_document_close(document as *mut c_void) };
    if let Some(receiver) = RECEIVERS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = EVENTS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
}
