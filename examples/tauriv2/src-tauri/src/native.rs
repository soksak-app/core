//! Rounds the corners of a webview.
//!
//! The modal is drawn by a webview of its own, and a webview is a rectangle. To
//! round it, the view itself has to be clipped, which every platform can do
//! through public interfaces:
//!
//! - macOS   the view is an `NSView`; its `CALayer` takes a corner radius.
//! - Windows the view is a window; a rounded region is set on it.
//! - Linux   WebKitGTK draws its own content and does not follow a clip set on
//!           the widget, so the corners stay square there.
//!
//! Clipped corners are simply not drawn, so whatever sits behind the modal
//! shows through them. No transparency and no private interface is involved.
//!
//! It also holds the two other platform operations a surface needs: setting its
//! alpha, and identifying the view a press landed on. A surface is a native
//! view, so a press on it never reaches the page and only the window receives it.
//!
//! Both are implemented for macOS here. On Windows a press reaches the parent
//! window as WM_PARENTNOTIFY and a child window cannot be made translucent; on
//! Linux the container's button-press-event carries it. Neither is written
//! here, so a surface on those platforms is always solid and a press on it does
//! not move focus.


use tauri::webview::PlatformWebview;

/// The point AppKit reports an event at. Declared here so a message can return
/// it; objc2 needs its layout to pass one back.
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
unsafe impl objc2::Encode for NSPoint {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("CGPoint", &[<f64 as objc2::Encode>::ENCODING; 2]);
}

/// A frame in AppKit's coordinates. Declared here for the same reason NSPoint is.
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct NSRect {
    origin: NSPoint,
    size: NSPoint,
}

#[cfg(target_os = "macos")]
impl From<(f64, f64, f64, f64)> for NSRect {
    fn from((x, y, w, h): (f64, f64, f64, f64)) -> Self {
        NSRect { origin: NSPoint { x, y }, size: NSPoint { x: w, y: h } }
    }
}

#[cfg(target_os = "macos")]
unsafe impl objc2::Encode for NSRect {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSPoint::ENCODING]);
}

/// Applies `radius` logical pixels of corner radius, given the view's size in
/// logical pixels and the display scale.
#[allow(unused_variables)]
pub fn corners(webview: &PlatformWebview, radius: f64, width: f64, height: f64, scale: f64) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::msg_send;

        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Graphics::Gdi::CreateRoundRectRgn;
        use windows::Win32::UI::WindowsAndMessaging::SetWindowRgn;

        let Ok(controller) = webview.controller() else {
            return;
        };
        let Ok(hwnd) = controller.ParentWindow() else {
            return;
        };
        // The region is in device pixels, and its right and bottom edges are
        // exclusive, so both are one past the view.
        let w = (width * scale).round() as i32 + 1;
        let h = (height * scale).round() as i32 + 1;
        let d = (radius * 2.0 * scale).round() as i32;
        if let Ok(region) = CreateRoundRectRgn(0, 0, w, h, d, d).ok() {
            let _ = SetWindowRgn(hwnd, Some(region), true);
        }
    }
}


/// How solid the view is drawn. A surface that lost focus can be asked to stand
/// back.
#[allow(unused_variables)]
pub fn alpha(webview: &PlatformWebview, alpha: f64) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setAlphaValue: alpha];
    }
}

/// Creates a layer-backed view in the window's content view and returns it.
///
/// A shape is a plain view, not a webview: its fill and its line carry an alpha
/// channel and composite over whatever the surfaces are showing. A webview
/// cannot do that, because WebKit paints its own opaque background and the key
/// that turns that off is a private one.
///
/// Only macOS is written. On Windows this would be a layered child window and on
/// Linux a GtkDrawingArea in the container; neither is written here, so no shape
/// is drawn on those platforms.
#[allow(unused_variables)]
pub fn shape_create(ns_window: *mut std::ffi::c_void, rect: (f64, f64, f64, f64)) -> usize {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        let window = ns_window as *mut AnyObject;
        if window.is_null() {
            return 0;
        }
        let Some(class) = AnyClass::get(c"NSView") else {
            return 0;
        };
        let view: *mut AnyObject = msg_send![class, alloc];
        let view: *mut AnyObject = msg_send![view, initWithFrame: NSRect::from(rect)];
        if view.is_null() {
            return 0;
        }
        let _: () = msg_send![view, setWantsLayer: true];
        let content: *mut AnyObject = msg_send![window, contentView];
        // NSWindowAbove is 1: the view goes above every sibling already there.
        let _: () = msg_send![content, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
        view as usize
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Moves a shape's view.
#[allow(unused_variables)]
pub fn shape_frame(view: usize, rect: (f64, f64, f64, f64)) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setFrame: NSRect::from(rect)];
    }
}

/// Sets a shape's corner radius, line width, fill colour and line colour.
#[allow(unused_variables)]
pub fn shape_style(view: usize, radius: f64, line_width: f64, fill: [f64; 4], line: [f64; 4]) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let Some(colour) = AnyClass::get(c"NSColor") else {
            return;
        };
        let fill_ns: *mut AnyObject = msg_send![colour, colorWithSRGBRed: fill[0], green: fill[1], blue: fill[2], alpha: fill[3]];
        let line_ns: *mut AnyObject = msg_send![colour, colorWithSRGBRed: line[0], green: line[1], blue: line[2], alpha: line[3]];
        let fill_cg: *mut AnyObject = msg_send![fill_ns, CGColor];
        let line_cg: *mut AnyObject = msg_send![line_ns, CGColor];
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setBorderWidth: line_width];
        let _: () = msg_send![layer, setBackgroundColor: fill_cg];
        let _: () = msg_send![layer, setBorderColor: line_cg];
    }
}

/// Removes a shape's view.
#[allow(unused_variables)]
pub fn shape_destroy(view: usize) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, removeFromSuperview];
    }
}

/// Reports which views a press landed on, deepest first, as a chain of view
/// pointers up to the window's content view.
///
/// A press on a surface is delivered to that surface's own view and never to
/// the page, so the app watches the window instead. AppKit is asked which view
/// the press is for, and the answer is matched against the views this app made:
/// no coordinates are converted, so none can disagree.
///
/// The monitor returns the event unchanged, and the view it was going to reach
/// still receives it.
#[allow(unused_variables)]
pub fn watch_mouse(ns_window: *mut std::ffi::c_void, pressed: impl Fn(Vec<usize>) + 'static) {
    #[cfg(target_os = "macos")]
    unsafe {
        use block2::RcBlock;
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        const NS_EVENT_MASK_LEFT_MOUSE_DOWN: u64 = 1 << 1;

        let window = ns_window as *mut AnyObject;
        let handler = RcBlock::new(move |event: *mut AnyObject| -> *mut AnyObject {
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
            let point: NSPoint = msg_send![event, locationInWindow];
            let mut view: *mut AnyObject = msg_send![content, hitTest: point];
            let mut chain = Vec::new();
            while !view.is_null() {
                chain.push(view as usize);
                if view == content {
                    break;
                }
                view = msg_send![view, superview];
            }
            pressed(chain);
            event
        });
        let class = AnyClass::get(c"NSEvent").expect("NSEvent");
        let _: *mut AnyObject = msg_send![
            class,
            addLocalMonitorForEventsMatchingMask: NS_EVENT_MASK_LEFT_MOUSE_DOWN,
            handler: &*handler,
        ];
        std::mem::forget(handler);
    }
}

/// The pointer to the view a webview draws in, which names it among the views a
/// press chain passes through.
pub fn view_id(webview: &PlatformWebview) -> usize {
    #[cfg(target_os = "macos")]
    {
        return webview.inner() as usize;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        0
    }
}
