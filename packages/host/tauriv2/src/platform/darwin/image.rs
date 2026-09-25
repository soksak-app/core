//! 표면 그림 영역. 구현은 native/darwin 의 image_region.m 이다.

use std::ffi::{c_char, c_void, CStr, CString};

use super::super::{Handle, Raster};

type ImageEvent = extern "C" fn(*mut c_void, *const c_char);

extern "C" {
    fn sp_region_create(
        surface: *mut c_void,
        name: *const c_char,
        event: ImageEvent,
        context: *mut c_void,
    ) -> *mut c_void;
    fn sp_region_place(
        region: *mut c_void,
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
        visible: bool,
    );
    fn sp_region_raster(region: *mut c_void, out: *mut f64) -> bool;
    fn sp_region_surface_placed(region: *mut c_void) -> bool;
    fn sp_region_facts(region: *mut c_void) -> *mut c_char;
    fn free(pointer: *mut c_void);
    fn sp_region_present(
        region: *mut c_void,
        token_id: u32,
        nonce: *const u8,
        width: f64,
        height: f64,
        scale: f64,
    ) -> bool;
    fn sp_region_last_error(region: *mut c_void) -> *mut c_char;
    fn sp_region_focus(region: *mut c_void);
    fn sp_region_caret(region: *mut c_void, x: f64, y: f64, w: f64, h: f64);
    fn sp_region_text(region: *mut c_void, utf8: *const c_char);
    fn sp_region_close(region: *mut c_void);
}

/// 그림 영역 핸들별 이벤트 수신 함수. 메인 스레드에서만 쓴다.
struct Receiver(Box<dyn Fn(String)>);

thread_local! {
    static RECEIVERS: std::cell::RefCell<std::collections::HashMap<Handle, *mut Receiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

extern "C" fn event_callback(context: *mut c_void, json: *const c_char) {
    let receiver = unsafe { &*(context as *const Receiver) };
    let json = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(json);
}

/// 표면 웹뷰 위에 그림 영역을 만든다. 메인 스레드에서 호출한다.
pub fn create(surface: Handle, name: &str, receive: Box<dyn Fn(String)>) -> Result<Handle, String> {
    let name = CString::new(name).map_err(|e| e.to_string())?;
    let receiver = Box::into_raw(Box::new(Receiver(receive)));
    let image = unsafe {
        sp_region_create(
            surface as *mut c_void,
            name.as_ptr(),
            event_callback,
            receiver as *mut c_void,
        )
    };
    if image.is_null() {
        drop(unsafe { Box::from_raw(receiver) });
        return Err("cannot create an image region in this surface".into());
    }
    let handle = image as Handle;
    RECEIVERS.with(|all| all.borrow_mut().insert(handle, receiver));
    Ok(handle)
}

/// 표면 뷰포트의 CSS 픽셀 여백으로 영역을 정한다.
pub fn place(image: Handle, left: f64, top: f64, right: f64, bottom: f64, visible: bool) {
    unsafe { sp_region_place(image as *mut c_void, left, top, right, bottom, visible) }
}

/// 영역의 표면이 네이티브 크기를 가졌는지. 아직 배치되지 않은 표면의 영역은 래스터 크기를 갖지 않는다.
pub fn surface_placed(image: Handle) -> bool {
    unsafe { sp_region_surface_placed(image as *mut c_void) }
}

pub fn raster(image: Handle) -> Option<Raster> {
    let mut out = [0.0; 3];
    if !unsafe { sp_region_raster(image as *mut c_void, out.as_mut_ptr()) } {
        return None;
    }
    Some(Raster {
        width: out[0] as u32,
        height: out[1] as u32,
        scale: out[2],
    })
}

pub fn facts(image: Handle) -> Result<String, String> {
    let pointer = unsafe { sp_region_facts(image as *mut c_void) };
    if pointer.is_null() {
        return Err("image facts are unavailable".into());
    }
    let result = unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .map_err(|error| error.to_string())
        .map(str::to_owned);
    unsafe { free(pointer as *mut c_void) };
    result
}

/// 외부 IOSurface 를 표시한다. 성공하면 true, 찾지 못했거나 크기가 맞지 않으면 false 를 반환한다.
pub fn present(
    image: Handle,
    token_id: u32,
    nonce: &[u8; 16],
    width: f64,
    height: f64,
    scale: f64,
) -> Result<bool, String> {
    let accepted = unsafe {
        sp_region_present(
            image as *mut c_void,
            token_id,
            nonce.as_ptr(),
            width,
            height,
            scale,
        )
    };
    if accepted {
        return Ok(true);
    }
    let pointer = unsafe { sp_region_last_error(image as *mut c_void) };
    if pointer.is_null() {
        return Err("image presentation rejected without a native reason".into());
    }
    let reason = unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .map_err(|error| error.to_string())
        .map(str::to_owned);
    unsafe { free(pointer as *mut c_void) };
    match reason {
        Ok(value) => Err(value),
        Err(error) => Err(error),
    }
}

/// 첫 응답자로 만들고 포커스 이벤트를 보낸다.
pub fn focus(image: Handle) {
    unsafe { sp_region_focus(image as *mut c_void) }
}

/// 캐럿(입력 커서) 위치를 받아 둔다.
pub fn caret(image: Handle, x: f64, y: f64, w: f64, h: f64) {
    unsafe { sp_region_caret(image as *mut c_void, x, y, w, h) }
}

/// 접근성 값으로 보일 문자열을 받아 둔다.
pub fn text(image: Handle, utf8: &str) -> Result<(), String> {
    let utf8 = CString::new(utf8).map_err(|e| e.to_string())?;
    unsafe { sp_region_text(image as *mut c_void, utf8.as_ptr()) }
    Ok(())
}

/// 영역을 제거하고 해제한다.
pub fn close(image: Handle) {
    unsafe { sp_region_close(image as *mut c_void) };
    if let Some(receiver) = RECEIVERS.with(|all| all.borrow_mut().remove(&image)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
}
