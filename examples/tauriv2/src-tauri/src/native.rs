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

/// Places a surface's view at an exact rect in the page's coordinates.
///
/// `set_position` and `set_size` take logical points and round them to whole
/// points before they reach the view, which undoes the alignment to the display's
/// pixels that `aligned` computed and can move an edge outward. The frame is set
/// on the view itself instead, in its parent's coordinates, which are unflipped:
/// y counts up from the parent's bottom.
///
/// Only macOS is written. On Windows and Linux a surface is a child window and a
/// different call places it.
#[allow(unused_variables)]
pub fn place_surface(webview: &PlatformWebview, x: f64, y: f64, w: f64, h: f64) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let parent: *mut AnyObject = msg_send![view, superview];
        if parent.is_null() {
            return;
        }
        let bounds: NSRect = msg_send![parent, bounds];
        let frame = NSRect::from((x, bounds.size.y - y - h, w, h));
        let _: () = msg_send![view, setFrame: frame];
    }
}

/// Tells the view a run of resizes has begun, and that it has ended.
///
/// A webview paints what it covers; area it does not cover yet is its own white
/// until the page draws there, which is a frame or more behind a resize. Between
/// these two calls WebKit holds what it has drawn instead of showing that white.
#[allow(unused_variables)]
pub fn resizing(webview: &PlatformWebview, live: bool) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        if live {
            let _: () = msg_send![view, viewWillStartLiveResize];
        } else {
            let _: () = msg_send![view, viewDidEndLiveResize];
        }
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

/// Moves a shape's view and raises it above its siblings.
///
/// A view added later is above the ones added earlier, so a shape drawn before a
/// surface webview ends up beneath it. The frame is aligned to the display's
/// pixels for the same reason a surface's is: a fractional edge draws blurred.
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
        let _: () = msg_send![view, setFrame: aligned_in_window(view, rect)];
        raise(view);
    }
}

/// Aligns a frame to the display's pixels, in the window the view is in.
#[cfg(target_os = "macos")]
unsafe fn aligned_in_window(view: *mut objc2::runtime::AnyObject, rect: (f64, f64, f64, f64)) -> NSRect {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let window: *mut AnyObject = msg_send![view, window];
    if window.is_null() {
        return NSRect::from(rect);
    }
    // NSAlignAllEdgesInward is MinX|MinY|MaxX|MaxY, the low four option bits.
    msg_send![window, backingAlignedRect: NSRect::from(rect), options: 15usize]
}

/// Puts the view above every sibling already in the content view.
#[cfg(target_os = "macos")]
unsafe fn raise(view: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let parent: *mut AnyObject = msg_send![view, superview];
    if parent.is_null() {
        return;
    }
    // NSWindowAbove is 1.
    let _: () = msg_send![parent, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
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
        // The reference alloc returned. The superview held one of its own until
        // the line above.
        let _: () = msg_send![view, release];
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
    }
    #[cfg(target_os = "macos")]
    make_main(parent);
}

/// The area the window's own buttons occupy, in the content view's coordinates
/// measured from its top left, as (x, y, w, h). An empty rect means the window
/// draws none.
///
/// The three buttons are laid out by the platform and the window is drawn with
/// its title bar transparent and its content behind it, so they sit over the
/// page. Only macOS is written; on Windows and Linux the buttons are drawn in a
/// frame outside the content and take none of it.
#[allow(unused_variables)]
pub fn window_controls(ns_window: *mut std::ffi::c_void) -> (f64, f64, f64, f64) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let window = ns_window as *mut AnyObject;
        if window.is_null() {
            return (0.0, 0.0, 0.0, 0.0);
        }
        let content: *mut AnyObject = msg_send![window, contentView];
        if content.is_null() {
            return (0.0, 0.0, 0.0, 0.0);
        }
        let height: NSRect = msg_send![content, bounds];
        let mut left = f64::MAX;
        let mut right = f64::MIN;
        let mut top = f64::MAX;
        let mut bottom = f64::MIN;
        // NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton.
        for kind in 0isize..3 {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: kind];
            if button.is_null() {
                continue;
            }
            let hidden: bool = msg_send![button, isHidden];
            if hidden {
                continue;
            }
            let bounds: NSRect = msg_send![button, bounds];
            let at: NSRect = msg_send![content, convertRect: bounds, fromView: button];
            left = left.min(at.origin.x);
            right = right.max(at.origin.x + at.size.x);
            top = top.min(at.origin.y);
            bottom = bottom.max(at.origin.y + at.size.y);
        }
        if right <= left {
            return (0.0, 0.0, 0.0, 0.0);
        }
        return (left, height.size.y - bottom, right - left, bottom - top);
    }
    #[cfg(not(target_os = "macos"))]
    {
        (0.0, 0.0, 0.0, 0.0)
    }
}

/// Where a window's own buttons were moved to, and where they came from.
///
/// The example moves the buttons of one window, so one of these is kept.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct Placed {
    window: usize,
    own: usize,
    home: usize,
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
thread_local! {
    static PLACED: std::cell::Cell<Option<Placed>> = const { std::cell::Cell::new(None) };
    /// A placement changes frames, and a frame change asks for a placement.
    static PLACING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Moves the window's own buttons so the leftmost one's top left corner sits
/// x, y points from the window's top left.
///
/// The buttons AppKit hands out are laid out for a standard title bar, and it
/// puts them back there whenever the window is laid out again: moving a button,
/// or the view that holds it, is undone within the same call. They are moved
/// into a view of this app's own instead, which AppKit does not lay out. AppKit
/// still gives each button its standard inset inside that view, so the view is
/// placed by reading that inset rather than by a number written here.
///
/// Only macOS has these buttons; elsewhere the window's controls are drawn in a
/// frame outside the content and this does nothing.
#[allow(unused_variables)]
pub fn place_window_controls(ns_window: *mut std::ffi::c_void, x: f64, y: f64) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        let window = ns_window as *mut AnyObject;
        if window.is_null() {
            return;
        }
        let content: *mut AnyObject = msg_send![window, contentView];
        let close: *mut AnyObject = msg_send![window, standardWindowButton: 0isize];
        if content.is_null() || close.is_null() {
            return;
        }
        if let Some(mut placed) = PLACED.get() {
            placed.x = x;
            placed.y = y;
            PLACED.set(Some(placed));
            place();
            return;
        }

        let Some(view) = AnyClass::get(c"NSView") else {
            return;
        };
        let own: *mut AnyObject = msg_send![view, alloc];
        let own: *mut AnyObject = msg_send![own, initWithFrame: NSRect::from((0.0, 0.0, 0.0, 0.0))];
        // Above the webview, which fills the window because the title bar is
        // drawn transparent. A button under it would take no press.
        let _: () = msg_send![content, addSubview: own, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
        let home: *mut AnyObject = msg_send![close, superview];
        PLACED.set(Some(Placed {
            window: window as usize,
            own: own as usize,
            home: home as usize,
            x,
            y,
        }));
        place();

        // The content view is resized whenever the window is, and the placement
        // is measured from its height.
        let _: () = msg_send![content, setPostsFrameChangedNotifications: true];
        let centre = notification_centre();
        watch(centre, c"NSViewFrameDidChangeNotification", content, || place());
        // A window in full screen has no title bar of its own and AppKit draws
        // the buttons in the menu bar. It reads them from where it left them, so
        // they are given back before the transition and taken again after it.
        watch(centre, c"NSWindowWillEnterFullScreenNotification", window, || lend_back());
        watch(centre, c"NSWindowDidExitFullScreenNotification", window, || place());
    }
}

/// The notification centre every observer here registers with.
#[cfg(target_os = "macos")]
unsafe fn notification_centre() -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let Some(class) = AnyClass::get(c"NSNotificationCenter") else {
        return std::ptr::null_mut();
    };
    let centre: *mut AnyObject = msg_send![class, defaultCenter];
    centre
}

/// Calls `answer` whenever `sender` posts the notification `name`.
#[cfg(target_os = "macos")]
unsafe fn watch(
    centre: *mut objc2::runtime::AnyObject,
    name: &std::ffi::CStr,
    sender: *mut objc2::runtime::AnyObject,
    answer: impl Fn() + 'static,
) {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    if centre.is_null() {
        return;
    }
    let Some(string) = AnyClass::get(c"NSString") else {
        return;
    };
    let name: *mut AnyObject = msg_send![string, stringWithUTF8String: name.as_ptr()];
    let block = RcBlock::new(move |_note: *mut AnyObject| answer());
    let _: *mut AnyObject = msg_send![
        centre,
        addObserverForName: name,
        object: sender,
        queue: std::ptr::null_mut::<AnyObject>(),
        usingBlock: &*block,
    ];
    // The centre keeps the registration for as long as the window lives, and the
    // block has to outlive it.
    std::mem::forget(block);
}

/// Puts the buttons in this app's own view and places that view.
#[cfg(target_os = "macos")]
fn place() {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Some(placed) = PLACED.get() else {
        return;
    };
    if PLACING.get() {
        return;
    }
    PLACING.set(true);
    unsafe {
        let window = placed.window as *mut AnyObject;
        let own = placed.own as *mut AnyObject;
        let content: *mut AnyObject = msg_send![window, contentView];
        let mut buttons = [std::ptr::null_mut::<AnyObject>(); 3];
        for kind in 0isize..3 {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: kind];
            buttons[kind as usize] = button;
        }
        if content.is_null() || buttons.iter().any(|button| button.is_null()) {
            PLACING.set(false);
            return;
        }
        for button in buttons {
            let holder: *mut AnyObject = msg_send![button, superview];
            if holder == own {
                continue;
            }
            let _: () = msg_send![button, removeFromSuperview];
            let _: () = msg_send![own, addSubview: button];
        }
        // The buttons carry the inset AppKit gave them, so the view is placed to
        // put the leftmost button's top left corner at x, y from the window's top
        // left.
        let first: NSRect = msg_send![buttons[0], frame];
        let last: NSRect = msg_send![buttons[2], frame];
        let bounds: NSRect = msg_send![content, bounds];
        let box_ = NSRect::from((
            placed.x - first.origin.x,
            bounds.size.y - placed.y - (first.origin.y + first.size.y),
            last.origin.x + last.size.x + first.origin.x,
            first.origin.y + first.size.y + first.origin.y,
        ));
        let _: () = msg_send![own, setFrame: box_];
    }
    PLACING.set(false);
}

/// Returns the buttons to where AppKit keeps them.
#[cfg(target_os = "macos")]
fn lend_back() {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Some(placed) = PLACED.get() else {
        return;
    };
    unsafe {
        let window = placed.window as *mut AnyObject;
        let home = placed.home as *mut AnyObject;
        for kind in 0isize..3 {
            let button: *mut AnyObject = msg_send![window, standardWindowButton: kind];
            if button.is_null() {
                continue;
            }
            let _: () = msg_send![button, removeFromSuperview];
            let _: () = msg_send![home, addSubview: button];
        }
    }
}

/// Makes the window a child of the parent, drawn above it and moving with it.
/// Adding it also puts it on screen.
///
/// Only macOS is written. On Windows this would set the parent as the owner
/// window and on Linux call gtk_window_set_transient_for.
#[allow(unused_variables)]
pub fn attach(ns_window: *mut std::ffi::c_void, parent: *mut std::ffi::c_void) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let window = ns_window as *mut AnyObject;
        let parent = parent as *mut AnyObject;
        if window.is_null() || parent.is_null() {
            return;
        }
        // NSWindowAbove is 1.
        let _: () = msg_send![parent, addChildWindow: window, ordered: 1isize];
    }
}

/// Makes this window the main one.
///
/// A modal takes the keyboard so that its webview sets the cursor, and a window
/// that is not key draws its title bar inactive. The app's window is made the
/// main one so it keeps an active title bar while the modal holds the keyboard.
#[allow(unused_variables)]
pub fn make_main(ns_window: *mut std::ffi::c_void) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let window = ns_window as *mut AnyObject;
        if window.is_null() {
            return;
        }
        let _: () = msg_send![window, makeMainWindow];
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
