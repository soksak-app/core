//! The external document webview inside a surface document. The implementation is document_view.m of native/darwin.

use std::ffi::{CStr, CString, c_char, c_void};

use super::super::{Handle, Insets};

type Changed = extern "C" fn(*mut c_void, *const c_char);
type Event = extern "C" fn(*mut c_void, *const c_char);

unsafe extern "C" {
    fn sp_document_create(
        surface: *mut c_void,
        store: *const c_char,
        folder: *const c_char,
        plugin: *const c_char,
        changed: Changed,
        context: *mut c_void,
    ) -> *mut c_void;
    fn sp_document_set_event(document: *mut c_void, event: Event, context: *mut c_void);
    fn sp_document_set_message(document: *mut c_void, message: Event, context: *mut c_void);
    fn sp_document_set_stream(document: *mut c_void, stream: Event, context: *mut c_void);
    fn sp_document_stream_on(document: *mut c_void, stream: *const c_char, on: bool) -> bool;
    fn sp_document_stream_ack(document: *mut c_void, seq: u64) -> bool;
    fn sp_document_post(document: *mut c_void, json: *const c_char) -> bool;
    fn sp_document_load(document: *mut c_void, url: *const c_char) -> bool;
    fn sp_document_zoom(document: *mut c_void, zoom: f64) -> bool;
    fn sp_document_go(document: *mut c_void, action: i32, offset: i32) -> bool;
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

/// The state receiver of each document handle. It is used only on the main thread.
struct Receiver(Box<dyn Fn(String)>);
struct EventReceiver(Box<dyn Fn(String) + Send>);

thread_local! {
    static RECEIVERS: std::cell::RefCell<std::collections::HashMap<Handle, *mut Receiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static EVENTS: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static MESSAGES: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static STREAMS: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
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

/// Creates a hidden document webview inside the surface webview. Call it on the main thread.
pub fn create(
    surface: Handle,
    store: &str,
    folder: &str,
    plugin: &str,
    receive: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    let store = CString::new(store).map_err(|e| e.to_string())?;
    let folder = CString::new(folder).map_err(|e| e.to_string())?;
    let plugin = CString::new(plugin).map_err(|e| e.to_string())?;
    let receiver = Box::into_raw(Box::new(Receiver(receive)));
    let document = unsafe {
        sp_document_create(
            surface as *mut c_void,
            store.as_ptr(),
            folder.as_ptr(),
            plugin.as_ptr(),
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

/// Opens an http, https, file or sok address; returns false for another address.
pub fn load(document: Handle, url: &str) -> Result<bool, String> {
    let url = CString::new(url).map_err(|e| e.to_string())?;
    Ok(unsafe { sp_document_load(document as *mut c_void, url.as_ptr()) })
}

/// Sets the page zoom of the document. It is false when the value is not a finite positive number.
pub fn zoom(document: Handle, zoom: f64) -> bool {
    unsafe { sp_document_zoom(document as *mut c_void, zoom) }
}

pub fn set_event(document: Handle, receive: Box<dyn Fn(String) + Send>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EventReceiver(receive)));
    unsafe { sp_document_set_event(document as *mut c_void, event, receiver as *mut c_void) };
    EVENTS.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

/// Receives the messages of plugin documents as {"message": value} or {"error": reason}.
pub fn set_message(document: Handle, receive: Box<dyn Fn(String) + Send>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EventReceiver(receive)));
    unsafe { sp_document_set_message(document as *mut c_void, event, receiver as *mut c_void) };
    MESSAGES.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

/// Receives the stream messages of the document as {"stream", "message"}.
pub fn set_stream(document: Handle, receive: Box<dyn Fn(String) + Send>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EventReceiver(receive)));
    unsafe { sp_document_set_stream(document as *mut c_void, event, receiver as *mut c_void) };
    STREAMS.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

/// Turns the stream elements or requests on or off. It is false for another stream or a closed document.
pub fn set_stream_on(document: Handle, stream: &str, on: bool) -> Result<bool, String> {
    let stream = CString::new(stream).map_err(|e| e.to_string())?;
    Ok(unsafe { sp_document_stream_on(document as *mut c_void, stream.as_ptr(), on) })
}

/// Acknowledges the element snapshot seq. It is false for a seq that native has not sent.
pub fn ack_stream(document: Handle, seq: u64) -> bool {
    unsafe { sp_document_stream_ack(document as *mut c_void, seq) }
}

/// Posts the JSON value json to the current plugin document; false when there is none.
pub fn post(document: Handle, json: &str) -> Result<bool, String> {
    let json = CString::new(json).map_err(|e| e.to_string())?;
    Ok(unsafe { sp_document_post(document as *mut c_void, json.as_ptr()) })
}

/// Runs back 0, forward 1, reload 2 and stop 3, and returns whether it ran.
pub fn go(document: Handle, action: i32, offset: i32) -> bool {
    unsafe { sp_document_go(document as *mut c_void, action, offset) }
}

/// Sets the document region with the CSS pixel insets of the surface viewport.
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

/// Dims the document while a dialog is open.
pub fn background(document: Handle, enabled: bool) {
    unsafe { sp_document_background(document as *mut c_void, enabled) }
}

pub fn appearance(document: Handle, dark: bool) {
    unsafe { sp_document_appearance(document as *mut c_void, dark) }
}

/// Removes the document webview and releases the state receiver.
pub fn close(document: Handle) {
    unsafe { sp_document_close(document as *mut c_void) };
    if let Some(receiver) = RECEIVERS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = EVENTS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = MESSAGES.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = STREAMS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
}
