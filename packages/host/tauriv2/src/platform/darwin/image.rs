//! The image region of a surface. The implementation is image_region.m of native/darwin.

use std::ffi::{CStr, CString, c_char, c_void};

use super::super::{Handle, Raster};

type ImageEvent = extern "C" fn(*mut c_void, *const c_char);

unsafe extern "C" {
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

/// The event receiver of each image region handle. It is used only on the main thread.
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

/// Creates an image region over the surface webview. Call it on the main thread.
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

/// Sets the region with the CSS pixel insets of the surface viewport.
pub fn place(image: Handle, left: f64, top: f64, right: f64, bottom: f64, visible: bool) {
    unsafe { sp_region_place(image as *mut c_void, left, top, right, bottom, visible) }
}

/// Whether the surface of the region has a native size. The region of a surface that is not placed yet has no raster
/// size.
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

/// Displays an external IOSurface. It returns true on success, and false when it was not found or the size does not
/// match.
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

/// Makes it the first responder and sends the focus event.
pub fn focus(image: Handle) {
    unsafe { sp_region_focus(image as *mut c_void) }
}

/// Stores the caret (text cursor) position.
pub fn caret(image: Handle, x: f64, y: f64, w: f64, h: f64) {
    unsafe { sp_region_caret(image as *mut c_void, x, y, w, h) }
}

/// Stores the string that is shown as the accessibility value.
pub fn text(image: Handle, utf8: &str) -> Result<(), String> {
    let utf8 = CString::new(utf8).map_err(|e| e.to_string())?;
    unsafe { sp_region_text(image as *mut c_void, utf8.as_ptr()) }
    Ok(())
}

/// Removes and releases the region.
pub fn close(image: Handle) {
    unsafe { sp_region_close(image as *mut c_void) };
    if let Some(receiver) = RECEIVERS.with(|all| all.borrow_mut().remove(&image)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
}
