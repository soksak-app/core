//! Window input watching, webview pointer routing registration, native input delivery and position decision.
//!
//! A surface is a native view, so input on a surface is not delivered to the page and only the window receives it.
//! Pointer routing uses one private WebKit input API in native/darwin.

use std::cell::Cell;
use std::ffi::{c_char, c_void, CString};

use block2::RcBlock;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use tauri::webview::PlatformWebview;

use std::time::Duration;

use super::super::{ButtonHeld, Delivery, Frame, FrontmostApplication, Handle, Hit, Key, Pointer};
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
        done: extern "C" fn(*mut c_void, i32, *const SpInputHeld),
        context: *mut c_void,
    );
    fn sp_input_activate_at(
        window: *mut c_void,
        x: f64,
        y: f64,
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
    ) -> i32;
}

/// The result value of sp_input_pointer.
const SP_INPUT_DELIVERED: i32 = 0;
const SP_INPUT_INACTIVE: i32 = 2;
const SP_INPUT_UNRECEIVED: i32 = 3;
const SP_INPUT_BUTTON_HELD: i32 = 4;
const SP_INPUT_PRESS_OPEN: i32 = 5;

/// sp_input_held of native/darwin. The state of the attempt that was rejected with SP_INPUT_BUTTON_HELD.
#[repr(C)]
struct SpInputHeld {
    mask: u64,
    /// The pid of the frontmost application. It is -1 when there is no frontmost application.
    pid: i32,
    /// The bundle identifier. It is NULL when there is none.
    bundle_identifier: *const c_char,
}

type Delivered = Box<dyn FnOnce(Delivery) + Send>;

extern "C" fn delivered(context: *mut c_void, result: i32, held: *const SpInputHeld) {
    // context is the value that pointer passed with Box::into_raw, and the library calls done once.
    let done = unsafe { Box::from_raw(context as *mut Delivered) };
    done(match result {
        SP_INPUT_DELIVERED => Delivery::Delivered,
        SP_INPUT_INACTIVE => Delivery::Inactive,
        SP_INPUT_UNRECEIVED => Delivery::Unreceived,
        // The library passes held only for SP_INPUT_BUTTON_HELD and keeps it valid until done returns.
        SP_INPUT_BUTTON_HELD => Delivery::ButtonHeld(button_held(
            unsafe { held.as_ref() }
                .expect("sp_input_pointer_then reported SP_INPUT_BUTTON_HELD without its state"),
        )),
        SP_INPUT_PRESS_OPEN => Delivery::PressOpen,
        _ => Delivery::Rejected,
    });
}

/// Reads sp_input_held. When pid is -1, there is no frontmost application.
fn button_held(held: &SpInputHeld) -> ButtonHeld {
    let frontmost = (held.pid >= 0).then(|| FrontmostApplication {
        bundle_identifier: (!held.bundle_identifier.is_null()).then(|| {
            unsafe { std::ffi::CStr::from_ptr(held.bundle_identifier) }
                .to_string_lossy()
                .into_owned()
        }),
        pid: held.pid,
    });
    ButtonHeld {
        mask: held.mask,
        frontmost,
    }
}

/// Delivers pointer input to the window and reports the result with done. A press and a release are reported after the
/// document received them. Call it on the main thread.
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

/// The result value of sp_input_activate.
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
    // context is the value that activate passed with Box::into_raw, and the library calls done once.
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

/// Converts the activation result into an error that states the stopped stage and the frontmost application.
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

/// Activates the application, makes the window the key window and then calls done. Call it on the main thread.
pub fn activate(window: Handle, x: f64, y: f64, timeout: Duration, done: Activated) {
    let context = Box::into_raw(Box::new(Activation { timeout, done })) as *mut c_void;
    unsafe {
        sp_input_activate_at(
            window as *mut c_void,
            x,
            y,
            timeout.as_secs_f64(),
            activated,
            context,
        )
    }
}

/// Delivers key input to the window and returns whether it was delivered. Call it on the main thread. A key name or a
/// string that contains a NUL character returns an error.
pub fn key(window: Handle, key: &Key) -> Result<Delivery, String> {
    let name = CString::new(key.key.as_str()).map_err(|e| e.to_string())?;
    let text = key
        .text
        .as_deref()
        .map(CString::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let text = text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr());
    let result = unsafe {
        sp_input_key(
            window as *mut c_void,
            name.as_ptr(),
            text,
            key.modifiers,
            key.down,
        )
    };
    Ok(match result {
        SP_INPUT_DELIVERED => Delivery::Delivered,
        SP_INPUT_INACTIVE => Delivery::Inactive,
        _ => Delivery::Rejected,
    })
}

/// Returns the view at the point x, y relative to the upper left of the content area and the list of its ancestor
/// views. Call it on the main thread.
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
        let content_bounds: NSRect = msg_send![content, bounds];
        // hitTest: uses the parent coordinates of the receiving view.
        let local = NSPoint {
            x,
            y: content_bounds.size.y - y,
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
        let mut view_class = None;
        let mut view_frame: Option<Frame> = None;
        let mut view = found;
        if !view.is_null() {
            let class: &AnyClass = msg_send![view, class];
            view_class = Some(class.name().to_string_lossy().into_owned());
            let view_bounds: NSRect = msg_send![view, bounds];
            let rect: NSRect = msg_send![view, convertRect: view_bounds, toView: content];
            view_frame = Some((
                rect.origin.x,
                content_bounds.size.y - rect.origin.y - rect.size.y,
                rect.size.x,
                rect.size.y,
            ));
        }
        while !view.is_null() {
            chain.push(view as Handle);
            if view == content {
                break;
            }
            view = msg_send![view, superview];
        }
        Ok(Hit {
            chain,
            identifier,
            view_class,
            view_frame,
        })
    }
}

/// Registers an application webview in the common native pointer routing and returns whether it was registered.
pub fn register(view: &PlatformWebview) -> bool {
    extern "C" {
        fn webviewInputRegister(view: *const c_void) -> Bool;
    }
    unsafe { webviewInputRegister(view.inner().cast()).as_bool() }
}

/// Makes the page of a webview not move the keyboard focus of the window when it focuses an element, and returns
/// whether it succeeded.
pub fn ignore_page_focus(view: &PlatformWebview) -> bool {
    extern "C" {
        fn webviewIgnorePageFocus(view: *const c_void) -> Bool;
    }
    unsafe { webviewIgnorePageFocus(view.inner().cast()).as_bool() }
}

/// Passes the target view and the position of the input that the window receives.
///
/// pressed receives the list of view addresses from the view that received the input to the window content view. The
/// target view that AppKit decided is compared with the views that this application created, so coordinates are not
/// converted. Key input targets the first responder of the window. A page that takes the focus by itself (for example a
/// page that focuses a search field) also updates the selected surface of the page model through this path.
///
/// pointed receives each step of a left-button drag as (phase, x, y). The phase is 0 press, 1 move, 2 release, and y is
/// relative to the top of the content view. The grab area of a boundary is wider than the gap between cards, so when
/// the gap is one line the whole grab area lies over a surface and the page does not receive the press. This path
/// therefore converts and passes the coordinates, and the caller converts them to page coordinates.
///
/// The monitor returns the event unchanged, so the original target view also receives the event.
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
    // Records whether the button was pressed in a view of this application. A drag that started in the page is handled
    // by the page. Delivering that drag would add a message to the thread that redraws the screen for every pointer
    // move.
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
            // A move and a release do not decide the view again. The press decided whether the drag is one that this
            // application delivers.
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

/// Removes an input monitor. 0 is ignored.
pub fn unwatch(monitor: Handle) {
    if monitor == 0 {
        return;
    }
    unsafe {
        let class = AnyClass::get(c"NSEvent").expect("NSEvent");
        let _: () = msg_send![class, removeMonitor: monitor as *mut AnyObject];
    }
}
