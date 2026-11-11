//! The external document webview inside a surface document. The implementation is document_view.m of native/darwin.

use std::ffi::{CStr, CString, c_char, c_void};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::super::{CoreRootResolver, DocumentOptions, Handle, Insets};
use crate::application_log::log_error;

#[cfg(feature = "diagnostics")]
use super::super::DocumentViewportMarker;

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
    #[cfg(feature = "diagnostics")]
    fn sp_document_draw_covered(window: *mut c_void, draw: bool) -> bool;
    #[cfg(feature = "diagnostics")]
    fn sp_document_viewport_marker(
        document: *mut c_void,
        enabled: bool,
        rgb3: *mut u8,
        border_width_pt: *mut f64,
        error: *mut *mut c_char,
    ) -> bool;
    fn sp_document_create(
        surface: *mut c_void,
        store: *const c_char,
        folder: *const c_char,
        plugin: *const c_char,
        label: *const c_char,
        channel: *const c_char,
        changed: Changed,
        context: *mut c_void,
    ) -> *mut c_void;
    fn sp_document_last_error() -> *const c_char;
    fn sp_core_root_set_resolver(resolver: CoreRoot, context: *mut c_void);
    fn sp_view_import_map_set(map: *const c_char);
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
    fn sp_document_binary_put(
        document: *mut c_void,
        bytes: *const c_void,
        length: usize,
        content_type: *const c_char,
        id: *mut c_char,
    ) -> *mut c_char;
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
    fn sp_document_query(document: *mut c_void, reply: Event, context: *mut c_void);
    fn sp_document_scroll_to(
        document: *mut c_void,
        x: f64,
        y: f64,
        reply: Event,
        context: *mut c_void,
    );
    fn sp_document_interaction_state(document: *mut c_void) -> *mut c_char;
    fn sp_document_restore(document: *mut c_void, state: *const c_char) -> *const c_char;
    fn free(pointer: *mut c_void);
}

/// Makes the document regions of the window show their documents while the window is occluded, or ends that
/// (docs/spec/native-surfaces.md#document-regions). Call it on the main thread.
#[cfg(feature = "diagnostics")]
pub fn draw_covered(window: Handle, draw: bool) -> Result<(), String> {
    if unsafe { sp_document_draw_covered(window as *mut c_void, draw) } {
        Ok(())
    } else {
        Err("a document region of the window cannot change its drawing while the window is occluded".into())
    }
}

/// Sets or removes the viewport marker on the native document view. Call it on the main thread.
#[cfg(feature = "diagnostics")]
pub fn viewport_marker(
    document: Option<Handle>,
    enabled: bool,
) -> Result<DocumentViewportMarker, String> {
    let document = document.map_or(std::ptr::null_mut(), |handle| handle as *mut c_void);
    let mut color = [0_u8; 3];
    let mut border_width_pt = 0.0;
    let mut error = std::ptr::null_mut();
    let succeeded = unsafe {
        sp_document_viewport_marker(
            document,
            enabled,
            color.as_mut_ptr(),
            &mut border_width_pt,
            &mut error,
        )
    };
    if !error.is_null() {
        let message = unsafe { CStr::from_ptr(error) }.to_bytes().to_vec();
        unsafe { free(error.cast()) };
        let message = String::from_utf8(message)
            .map_err(|invalid| format!("document viewport marker error is not UTF-8: {invalid}"))?;
        return Err(format!("document viewport marker failed: {message}"));
    }
    if !succeeded {
        return Err("document viewport marker failed without a native error".into());
    }
    if !border_width_pt.is_finite() || border_width_pt <= 0.0 {
        return Err(format!(
            "document viewport marker returned an invalid border width: {border_width_pt}"
        ));
    }
    Ok(DocumentViewportMarker {
        enabled,
        color,
        border_width_pt,
    })
}

/// The state receiver of each document handle. It is used only on the main thread.
/// Each invocation retains its callback so document close cannot release an executing closure.
struct Receiver(Rc<dyn Fn(String)>);
struct EventReceiver(Rc<dyn Fn(String) + Send>);
struct EndedReceiver(Rc<dyn Fn() + Send>);

struct ResponsivenessReceiver(Rc<dyn Fn(bool) + Send>);

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
    let callback = receiver.0.clone();
    callback();
}

extern "C" fn responsiveness(context: *mut c_void, responsive: bool) {
    let receiver = unsafe { &*(context as *const ResponsivenessReceiver) };
    let callback = receiver.0.clone();
    callback(responsive);
}

extern "C" fn changed(context: *mut c_void, state: *const c_char) {
    let receiver = unsafe { &*(context as *const Receiver) };
    let state = unsafe { CStr::from_ptr(state) }
        .to_string_lossy()
        .into_owned();
    let callback = receiver.0.clone();
    callback(state);
}

extern "C" fn event(context: *mut c_void, value: *const c_char) {
    let receiver = unsafe { &*(context as *const EventReceiver) };
    let value = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    let callback = receiver.0.clone();
    callback(value);
}

/// Creates a hidden document webview inside the surface webview. Call it on the main thread.
pub fn create(
    surface: Handle,
    options: DocumentOptions<'_>,
    receive: Box<dyn Fn(String)>,
) -> Result<Handle, String> {
    let store = CString::new(options.directory).map_err(|e| e.to_string())?;
    let folder = CString::new(options.folder).map_err(|e| e.to_string())?;
    let plugin = CString::new(options.plugin).map_err(|e| e.to_string())?;
    let label = CString::new(options.label).map_err(|e| e.to_string())?;
    let channel = options
        .channel
        .map(CString::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let receiver = Box::into_raw(Box::new(Receiver(receive.into())));
    let document = unsafe {
        sp_document_create(
            surface as *mut c_void,
            store.as_ptr(),
            folder.as_ptr(),
            plugin.as_ptr(),
            label.as_ptr(),
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

/// The message of a native creation that returned no handle, followed by the native cause. Every failure of the native
/// creation states its cause, so an empty cause is reported as missing rather than left out.
fn creation_error(message: &str) -> String {
    let cause = unsafe { CStr::from_ptr(sp_document_last_error()) }.to_string_lossy();
    if cause.is_empty() {
        format!("{message}: {MISSING_NATIVE_CAUSE}")
    } else {
        format!("{message}: {cause}")
    }
}

/// The cause that an error states when the native layer failed a creation without a cause.
const MISSING_NATIVE_CAUSE: &str = "the native layer stated no cause";

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

/// The receiver of one scroll reply. Native calls it once.
struct ScrollReceiver(Box<dyn FnOnce(String) + Send>);

extern "C" fn scrolled(context: *mut c_void, value: *const c_char) {
    let receiver = unsafe { Box::from_raw(context as *mut ScrollReceiver) };
    let value = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(value);
}

unsafe extern "C" {
    fn sp_document_read(
        document: *mut c_void,
        path: *const c_char,
        ref_: i32,
        granted: bool,
        reply: Event,
        context: *mut c_void,
    );
}

/// The receiver of one read reply. Native calls it once.
struct ReadReceiver(Box<dyn FnOnce(String) + Send>);

extern "C" fn read_replied(context: *mut c_void, value: *const c_char) {
    let receiver = unsafe { Box::from_raw(context as *mut ReadReceiver) };
    let value = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(value);
}

unsafe extern "C" {
    fn sp_document_confirm(
        document: *mut c_void,
        kind: *const c_char,
        origin: *const c_char,
        summary: *const c_char,
        reply: Event,
        context: *mut c_void,
    );
}

/// The receiver of one confirmation answer. Native calls it once.
struct ConfirmReceiver(Box<dyn FnOnce(String) + Send>);

extern "C" fn confirm_replied(context: *mut c_void, value: *const c_char) {
    let receiver = unsafe { Box::from_raw(context as *mut ConfirmReceiver) };
    let value = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(value);
}

/// Shows the confirmation panel of the region; reply receives the answer of the person once.
pub fn confirm(document: Handle, kind: &str, origin: &str, summary: &str, reply: Box<dyn FnOnce(String) + Send>) {
    let receiver = Box::into_raw(Box::new(ConfirmReceiver(reply)));
    let kind = std::ffi::CString::new(kind).unwrap_or_default();
    let origin = std::ffi::CString::new(origin).unwrap_or_default();
    let summary = std::ffi::CString::new(summary).unwrap_or_default();
    unsafe { sp_document_confirm(document as *mut c_void, kind.as_ptr(), origin.as_ptr(), summary.as_ptr(), confirm_replied, receiver as *mut c_void) };
}

/// Reads the value of the operable element ref of the frame at path; without the grant the reply names the origin of
/// the frame alone, with the grant it names the value and the origin.
pub fn read(document: Handle, path: &str, ref_: i32, granted: bool, reply: Box<dyn FnOnce(String) + Send>) {
    let receiver = Box::into_raw(Box::new(ReadReceiver(reply)));
    let path = std::ffi::CString::new(path).unwrap_or_default();
    unsafe { sp_document_read(document as *mut c_void, path.as_ptr(), ref_, granted, read_replied, receiver as *mut c_void) };
}

/// Scrolls the main document of the region to the CSS pixel position; reply receives the settled position once.
pub fn scroll_to(document: Handle, x: f64, y: f64, reply: Box<dyn FnOnce(String) + Send>) {
    let receiver = Box::into_raw(Box::new(ScrollReceiver(reply)));
    unsafe { sp_document_scroll_to(document as *mut c_void, x, y, scrolled, receiver as *mut c_void) };
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
    let receiver = Box::into_raw(Box::new(EventReceiver(receive.into())));
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

/// Sets the view import map of the native view handler, which copies the text.
pub fn set_view_import_map(map: &str) -> Result<(), String> {
    let text = std::ffi::CString::new(map)
        .map_err(|error| format!("the view import map holds a NUL byte: {error}"))?;
    unsafe { sp_view_import_map_set(text.as_ptr()) };
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
    let receiver = Box::into_raw(Box::new(EventReceiver(receive.into())));
    unsafe { sp_document_set_message(document as *mut c_void, event, receiver as *mut c_void) };
    MESSAGES.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

/// Receives the stream messages of the document as {"stream", "message"}.
pub fn set_stream(document: Handle, receive: Box<dyn Fn(String) + Send>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(EventReceiver(receive.into())));
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
    release_receivers(document);
}

fn release_receivers(document: Handle) {
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

/// Stores bytes with their content type in the binary store of the document under an id that the native layer mints, and returns the
/// id. The error is the text of the native layer, whose copy is released here.
pub fn put_document_binary(
    document: Handle,
    bytes: &[u8],
    content_type: &str,
) -> Result<String, String> {
    let content_type = CString::new(content_type)
        .map_err(|error| format!("the content type contains a NUL byte: {error}"))?;
    let mut id = [0 as c_char; 33];
    let text = unsafe {
        sp_document_binary_put(
            document as *mut c_void,
            bytes.as_ptr() as *const c_void,
            bytes.len(),
            content_type.as_ptr(),
            id.as_mut_ptr(),
        )
    };
    if !text.is_null() {
        let error = unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned();
        unsafe { free(text as *mut c_void) };
        return Err(error);
    }
    Ok(unsafe { CStr::from_ptr(id.as_ptr()) }
        .to_string_lossy()
        .into_owned())
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
    let receiver = Box::into_raw(Box::new(ResponsivenessReceiver(receive.into())));
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
    let receiver = Box::into_raw(Box::new(EndedReceiver(receive.into())));
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
    let receiver = Box::into_raw(Box::new(EventReceiver(receive.into())));
    unsafe {
        sp_document_set_view_message(document as *mut c_void, event, receiver as *mut c_void)
    };
    VIEW_MESSAGES.with(|all| all.borrow_mut().insert(document, receiver));
    Ok(())
}

#[cfg(test)]
#[path = "document_test.rs"]
mod tests;
