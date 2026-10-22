//! The external document webview inside a surface document. The implementation is document_view.m of native/darwin.

use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};

use super::super::{CoreRootResolver, Handle, Insets};
use crate::application_log::log_error;

type Changed = extern "C" fn(*mut c_void, *const c_char);
type Event = extern "C" fn(*mut c_void, *const c_char);
type Ended = extern "C" fn(*mut c_void);
type Responsiveness = extern "C" fn(*mut c_void, bool);
type CoreRoot = extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *mut *mut c_void,
    *mut usize,
    *mut *mut c_char,
) -> bool;

unsafe extern "C" {
    fn sp_document_create(
        surface: *mut c_void,
        store: *const c_char,
        folder: *const c_char,
        plugin: *const c_char,
        channel: *const c_char,
        changed: Changed,
        context: *mut c_void,
    ) -> *mut c_void;
    fn sp_document_last_error() -> *const c_char;
    fn sp_core_root_set_resolver(resolver: CoreRoot, context: *mut c_void);
    fn malloc(size: usize) -> *mut c_void;
    fn strdup(text: *const c_char) -> *mut c_char;
    fn sp_document_set_event(document: *mut c_void, event: Event, context: *mut c_void);
    fn sp_document_set_message(document: *mut c_void, message: Event, context: *mut c_void);
    fn sp_document_set_view_message(document: *mut c_void, message: Event, context: *mut c_void);
    fn sp_document_set_view_ended(document: *mut c_void, ended: Ended, context: *mut c_void);
    fn sp_document_set_view_responsiveness(
        document: *mut c_void,
        responsiveness: Responsiveness,
        context: *mut c_void,
    );
    fn sp_document_add_user_script(document: *mut c_void, source: *const c_char);
    fn sp_document_binary_take(
        document: *mut c_void,
        id: *const c_char,
        bytes: *mut *mut c_void,
        length: *mut usize,
    ) -> *const c_char;
    fn sp_document_set_stream(document: *mut c_void, stream: Event, context: *mut c_void);
    fn sp_document_stream_on(document: *mut c_void, stream: *const c_char, on: bool) -> bool;
    fn sp_document_stream_ack(document: *mut c_void, seq: u64) -> bool;
    fn sp_document_post(document: *mut c_void, json: *const c_char) -> bool;
    fn sp_document_load(document: *mut c_void, url: *const c_char) -> bool;
    fn sp_plugin_host_create(
        window: *mut c_void,
        store: *const c_char,
        folder: *const c_char,
        plugin: *const c_char,
        channel: *const c_char,
        changed: Changed,
        context: *mut c_void,
    ) -> *mut c_void;
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
    fn sp_document_query(document: *mut c_void, reply: Event, context: *mut c_void);
    fn sp_document_interaction_state(document: *mut c_void) -> *mut c_char;
    fn sp_document_restore(document: *mut c_void, state: *const c_char) -> *const c_char;
    fn free(pointer: *mut c_void);
}

/// The state receiver of each document handle. It is used only on the main thread.
struct Receiver(Box<dyn Fn(String)>);
struct EventReceiver(Box<dyn Fn(String) + Send>);
struct EndedReceiver(Box<dyn Fn() + Send>);

struct ResponsivenessReceiver(Box<dyn Fn(bool) + Send>);

thread_local! {
    static RECEIVERS: std::cell::RefCell<std::collections::HashMap<Handle, *mut Receiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static EVENTS: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static MESSAGES: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static VIEW_MESSAGES: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static STREAMS: std::cell::RefCell<std::collections::HashMap<Handle, *mut EventReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static VIEW_ENDS: std::cell::RefCell<std::collections::HashMap<Handle, *mut EndedReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static VIEW_RESPONSIVENESS: std::cell::RefCell<std::collections::HashMap<Handle, *mut ResponsivenessReceiver>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

extern "C" fn ended(context: *mut c_void) {
    let receiver = unsafe { &*(context as *const EndedReceiver) };
    (receiver.0)();
}

extern "C" fn responsiveness(context: *mut c_void, responsive: bool) {
    let receiver = unsafe { &*(context as *const ResponsivenessReceiver) };
    (receiver.0)(responsive);
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
    channel: Option<&str>,
    receive: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    let store = CString::new(store).map_err(|e| e.to_string())?;
    let folder = CString::new(folder).map_err(|e| e.to_string())?;
    let plugin = CString::new(plugin).map_err(|e| e.to_string())?;
    let channel = channel
        .map(CString::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let receiver = Box::into_raw(Box::new(Receiver(receive)));
    let document = unsafe {
        sp_document_create(
            surface as *mut c_void,
            store.as_ptr(),
            folder.as_ptr(),
            plugin.as_ptr(),
            channel
                .as_ref()
                .map_or(std::ptr::null(), |text| text.as_ptr()),
            changed,
            receiver as *mut c_void,
        )
    };
    if document.is_null() {
        drop(unsafe { Box::from_raw(receiver) });
        return Err(creation_error(
            "cannot create a document view in this surface",
        ));
    }
    let handle = document as Handle;
    RECEIVERS.with(|all| all.borrow_mut().insert(handle, receiver));
    Ok(handle)
}

/// The message of a native creation that returned no handle. It states the native cause when the native layer gives one.
fn creation_error(message: &str) -> String {
    let cause = unsafe { CStr::from_ptr(sp_document_last_error()) }.to_string_lossy();
    if cause.is_empty() {
        message.into()
    } else {
        format!("{message}: {cause}")
    }
}

/// Creates the plugin host webview of a plugin hidden in the window itself with the view configuration
/// (docs/spec/plugin-host.md). The state receiver is kept until close, as the receiver of a document region is.
pub fn create_plugin_host(
    window: Handle,
    store: &str,
    folder: &str,
    plugin: &str,
    channel: &str,
    receive: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    let store = CString::new(store).map_err(|e| e.to_string())?;
    let folder = CString::new(folder).map_err(|e| e.to_string())?;
    let plugin = CString::new(plugin).map_err(|e| e.to_string())?;
    let channel = CString::new(channel).map_err(|e| e.to_string())?;
    let receiver = Box::into_raw(Box::new(Receiver(receive)));
    let host = unsafe {
        sp_plugin_host_create(
            window as *mut c_void,
            store.as_ptr(),
            folder.as_ptr(),
            plugin.as_ptr(),
            channel.as_ptr(),
            changed,
            receiver as *mut c_void,
        )
    };
    if host.is_null() {
        drop(unsafe { Box::from_raw(receiver) });
        return Err(creation_error(
            "cannot create a plugin host webview in this window",
        ));
    }
    let handle = host as Handle;
    RECEIVERS.with(|all| all.borrow_mut().insert(handle, receiver));
    Ok(handle)
}

/// The receiver of one query reply. Native calls it once.
struct QueryReceiver(Box<dyn FnOnce(String) + Send>);

extern "C" fn queried(context: *mut c_void, value: *const c_char) {
    let receiver = unsafe { Box::from_raw(context as *mut QueryReceiver) };
    let value = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(value);
}

/// Asks the region for its media, capture and form state; reply receives the JSON reply of native once.
pub fn query(document: Handle, reply: Box<dyn FnOnce(String) + Send>) {
    let receiver = Box::into_raw(Box::new(QueryReceiver(reply)));
    unsafe { sp_document_query(document as *mut c_void, queried, receiver as *mut c_void) };
}

/// The interactionState of the region as base64, empty when the web view yields none, or None for a closed region.
pub fn interaction_state(document: Handle) -> Option<String> {
    let state = unsafe { sp_document_interaction_state(document as *mut c_void) };
    if state.is_null() {
        return None;
    }
    let text = unsafe { CStr::from_ptr(state) }
        .to_string_lossy()
        .into_owned();
    unsafe { free(state as *mut c_void) };
    Some(text)
}

/// Restores the base64 interactionState into a region that has loaded nothing; the error is the refusal of native.
pub fn restore(document: Handle, state: &str) -> Result<(), String> {
    let state = CString::new(state).map_err(|e| e.to_string())?;
    let refusal = unsafe { sp_document_restore(document as *mut c_void, state.as_ptr()) };
    if refusal.is_null() {
        return Ok(());
    }
    Err(unsafe { CStr::from_ptr(refusal) }
        .to_string_lossy()
        .into_owned())
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
/// Set once, so that a second registration cannot leak the resolver of the first one.
static CORE_ROOT_SET: AtomicBool = AtomicBool::new(false);

/// Registers the core root resolver of the application. The resolver is kept for the process; the application registers it once
/// at its start, so the second registration is refused.
pub fn set_core_root(resolve: CoreRootResolver) -> Result<(), String> {
    if CORE_ROOT_SET.swap(true, Ordering::SeqCst) {
        return Err("the core root resolver is already set".into());
    }
    let context = Box::into_raw(Box::new(resolve)) as *mut c_void;
    unsafe { sp_core_root_set_resolver(core_root, context) };
    Ok(())
}

/// Answers one request of the core root of a view. It copies the file into memory that the native scheme releases with free.
/// It returns false for a path that the resolver does not serve.
extern "C" fn core_root(
    context: *mut c_void,
    plugin: *const c_char,
    path: *const c_char,
    bytes: *mut *mut c_void,
    length: *mut usize,
    content_type: *mut *mut c_char,
) -> bool {
    let resolver = unsafe { &*(context as *const CoreRootResolver) };
    let (Ok(plugin), Ok(path)) = (
        unsafe { CStr::from_ptr(plugin) }.to_str(),
        unsafe { CStr::from_ptr(path) }.to_str(),
    ) else {
        log_error("core root", "the request of a view is not UTF-8");
        return false;
    };
    let Some(file) = resolver(plugin, path) else {
        return false;
    };
    let Ok(kind) = CString::new(file.content_type) else {
        log_error("core root", format!("{path}: the content type is not text"));
        return false;
    };
    let data = unsafe { malloc(file.data.len().max(1)) } as *mut u8;
    let kind_copy = unsafe { strdup(kind.as_ptr()) };
    if data.is_null() || kind_copy.is_null() {
        log_error("core root", format!("{path}: the file cannot be copied"));
        unsafe {
            free(data as *mut c_void);
            free(kind_copy as *mut c_void);
        }
        return false;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(file.data.as_ptr(), data, file.data.len());
        *bytes = data as *mut c_void;
        *length = file.data.len();
        *content_type = kind_copy;
    }
    true
}

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
    if let Some(receiver) = VIEW_MESSAGES.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = VIEW_ENDS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = VIEW_RESPONSIVENESS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
    if let Some(receiver) = STREAMS.with(|all| all.borrow_mut().remove(&document)) {
        drop(unsafe { Box::from_raw(receiver) });
    }
}

/// Takes the bytes that the binary store of the document keeps under id, and releases the id. The copy that the native layer makes is
/// released here. The error is the text of the native layer.
pub fn take_document_binary(document: Handle, id: &str) -> Result<Vec<u8>, String> {
    let id =
        CString::new(id).map_err(|error| format!("the binary id contains a NUL byte: {error}"))?;
    let mut bytes: *mut c_void = std::ptr::null_mut();
    let mut length: usize = 0;
    let text = unsafe {
        sp_document_binary_take(
            document as *mut c_void,
            id.as_ptr(),
            &mut bytes,
            &mut length,
        )
    };
    if !text.is_null() {
        return Err(unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned());
    }
    if length == 0 {
        unsafe { free(bytes) };
        return Ok(Vec::new());
    }
    let data = unsafe { std::slice::from_raw_parts(bytes as *const u8, length) }.to_vec();
    unsafe { free(bytes) };
    Ok(data)
}

/// Adds a document-start user script to the document. The source is copied by the native layer. Call it on the main thread before the
/// document loads a page.
pub fn add_document_script(document: Handle, source: &str) -> Result<(), String> {
    let source = CString::new(source)
        .map_err(|error| format!("the document script contains a NUL byte: {error}"))?;
    unsafe { sp_document_add_user_script(document as *mut c_void, source.as_ptr()) };
    Ok(())
}

/// Receives the responsiveness notices of a view. A receiver that is set again replaces the earlier one. Call it on the main thread
/// before the view loads a page.
pub fn set_view_responsiveness(
    document: Handle,
    receive: Box<dyn Fn(bool) + Send>,
) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(ResponsivenessReceiver(receive)));
    unsafe {
        sp_document_set_view_responsiveness(
            document as *mut c_void,
            responsiveness,
            receiver as *mut c_void,
        )
    };
    if let Some(earlier) =
        VIEW_RESPONSIVENESS.with(|all| all.borrow_mut().insert(document, receiver))
    {
        drop(unsafe { Box::from_raw(earlier) });
    }
    Ok(())
}

/// Receives the end of the WebContent process of a view. A receiver that is set again replaces the earlier one, which the native
/// layer no longer calls. Call it on the main thread before the view loads a page.
pub fn set_view_ended(document: Handle, receive: Box<dyn Fn() + Send>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EndedReceiver(receive)));
    unsafe { sp_document_set_view_ended(document as *mut c_void, ended, receiver as *mut c_void) };
    if let Some(earlier) = VIEW_ENDS.with(|all| all.borrow_mut().insert(document, receiver)) {
        drop(unsafe { Box::from_raw(earlier) });
    }
    Ok(())
}

/// Receives the messages of the sok-view handler of a view as {"message": value} or {"error": reason}. Call it on the main thread
/// before the view loads a page.
pub fn set_view_message(
    document: Handle,
    receive: Box<dyn Fn(String) + Send>,
) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EventReceiver(receive)));
    unsafe {
        sp_document_set_view_message(document as *mut c_void, event, receiver as *mut c_void)
    };
    VIEW_MESSAGES.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

#[cfg(test)]
#[path = "document_test.rs"]
mod tests;
