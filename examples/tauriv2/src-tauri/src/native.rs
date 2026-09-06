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

/// Reports two things about the input the window receives: which views it landed
/// on, and where it was.
///
/// Input on a surface is delivered to that surface's own view and never to the
/// page, so the app watches the window instead. `pressed` receives the chain of
/// view pointers, deepest first, up to the window's content view. AppKit reports
/// which view a press is for, and the answer is matched against the views this
/// app made: no coordinate is converted, so none can disagree.
///
/// A key goes to the window's first responder, which is what a page that
/// focuses itself becomes: google.com focuses its search field on load, and
/// without this the page's model still names the surface that was pressed last.
///
/// `pointed` receives every step of a left-button drag as `(phase, x, y)`, with
/// phase 0 for a press, 1 for a move and 2 for a release, and y measured from
/// the content view's top. This one does convert a coordinate, and it has to: a
/// divider's grab area is wider than the passage between two cards, so when the
/// passage is one line wide the whole area lies over the surfaces and no press
/// in it reaches the page. The caller turns this into the page's coordinates.
///
/// The monitor returns the event unchanged, and the view it was going to reach
/// still receives it.
#[allow(unused_variables)]
pub fn watch_mouse(
    ns_window: *mut std::ffi::c_void,
    pressed: impl Fn(Vec<usize>) -> bool + 'static,
    pointed: impl Fn(u8, f64, f64) + 'static,
) {
    #[cfg(target_os = "macos")]
    unsafe {
        use block2::RcBlock;
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        const NS_EVENT_MASK_LEFT_MOUSE_DOWN: u64 = 1 << 1;
        const NS_EVENT_MASK_LEFT_MOUSE_UP: u64 = 1 << 2;
        const NS_EVENT_MASK_LEFT_MOUSE_DRAGGED: u64 = 1 << 6;
        const NS_EVENT_MASK_KEY_DOWN: u64 = 1 << 10;
        const NS_EVENT_TYPE_LEFT_MOUSE_DOWN: u64 = 1;
        const NS_EVENT_TYPE_LEFT_MOUSE_UP: u64 = 2;
        const NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED: u64 = 6;

        let window = ns_window as *mut AnyObject;
        // Whether the button went down on one of this app's views. A drag that
        // began on the page is the page's own and needs nothing from here;
        // forwarding it would put one message per pointer move on the same thread
        // that has to redraw the plane.
        let dragging = std::cell::Cell::new(false);
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
            let kind: u64 = msg_send![event, type];
            let point: NSPoint = msg_send![event, locationInWindow];
            let bounds: NSRect = msg_send![content, bounds];
            // A move and a release do not name a view again. The press decided it,
            // and it decided whether this drag is one this app has to carry.
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
                chain.push(view as usize);
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
        });
        let class = AnyClass::get(c"NSEvent").expect("NSEvent");
        let _: *mut AnyObject = msg_send![
            class,
            addLocalMonitorForEventsMatchingMask: NS_EVENT_MASK_LEFT_MOUSE_DOWN
                | NS_EVENT_MASK_LEFT_MOUSE_DRAGGED
                | NS_EVENT_MASK_LEFT_MOUSE_UP
                | NS_EVENT_MASK_KEY_DOWN,
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

/// Makes a window the modal's: not opaque, with a shadow, kept out of the window
/// list, and leaves the app's window as the main one.
///
/// Not opaque so the clipped corners show what is behind them rather than black.
/// The main window is set back because a modal takes the keyboard - a webview
/// sets the cursor only while its window holds it - and a window that takes the
/// keyboard would otherwise also take the active title bar from the app's own.
///
/// Only macOS is written. On Windows the equivalent is a layered child window and
/// on Linux a GTK popup; neither is written here.
#[allow(unused_variables)]
pub fn panelise(ns_window: *mut std::ffi::c_void, parent: *mut std::ffi::c_void) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        let window = ns_window as *mut AnyObject;
        let parent = parent as *mut AnyObject;
        if window.is_null() || parent.is_null() {
            return;
        }
        let Some(colour) = AnyClass::get(c"NSColor") else {
            return;
        };
        let clear: *mut AnyObject = msg_send![colour, clearColor];
        let _: () = msg_send![window, setOpaque: false];
        let _: () = msg_send![window, setBackgroundColor: clear];
        let _: () = msg_send![window, setHasShadow: true];
        // Auxiliary to the app's window, not another document of its own, so it
        // does not belong in the list of windows the app offers to switch between.
        let _: () = msg_send![window, setExcludedFromWindowsMenu: true];
        let _: () = msg_send![parent, makeMainWindow];
    }
}

/// The window server's numbers for this window and the windows attached to it.
///
/// A capture tool addresses a window by its number, so it reads the composite the
/// window server draws - the page, the surfaces and the modal - without raising
/// the window and without taking the focus from whatever holds it. A region of the
/// screen catches whatever is in front instead, and raising the window first
/// changes the state being measured.
///
/// Only macOS is written. On Windows this is the HWND and on Linux the X window
/// id; neither is written here.
#[allow(unused_variables)]
pub fn window_numbers(ns_window: *mut std::ffi::c_void) -> Vec<isize> {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let window = ns_window as *mut AnyObject;
        if window.is_null() {
            return Vec::new();
        }
        let mut out = vec![msg_send![window, windowNumber]];
        let children: *mut AnyObject = msg_send![window, childWindows];
        if !children.is_null() {
            let count: usize = msg_send![children, count];
            for i in 0..count {
                let child: *mut AnyObject = msg_send![children, objectAtIndex: i];
                out.push(msg_send![child, windowNumber]);
            }
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}
