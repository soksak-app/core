//! The shape views drawn over a surface.
//!
//! A shape is a layer-backed NSView and not a webview. The alpha of the fill color and the line color is composed over
//! the surface content. A webview draws an opaque background in WebKit, and the key that turns it off is private.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};

use super::super::{Frame, Handle};
use super::NSRect;

/// Adds a layer-backed view to the window content view and returns the address. It returns 0 when it could not create
/// it.
pub fn create(window: Handle, rect: Frame) -> Handle {
    unsafe {
        let window = window as *mut AnyObject;
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
        // NSWindowAbove is 1. It adds the view above the existing sibling views.
        let _: () = msg_send![content, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
        view as Handle
    }
}

/// Places the shape view and raises it above its sibling views.
///
/// A view added later is above a view added earlier, so a shape that was drawn before the surface webview lies below
/// the surface. The edges of fractional coordinates are drawn blurred, so they are fitted to display pixels like the
/// surface.
pub fn place(view: Handle, rect: Frame) {
    unsafe {
        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, setFrame: aligned_in_window(view, rect)];
        raise(view);
    }
}

/// Fits the rectangle to the display pixels of the window that holds the view.
unsafe fn aligned_in_window(view: *mut AnyObject, rect: Frame) -> NSRect {
    let window: *mut AnyObject = msg_send![view, window];
    if window.is_null() {
        return NSRect::from(rect);
    }
    // NSAlignAllEdgesInward is MinX|MinY|MaxX|MaxY, the four lower option bits.
    msg_send![window, backingAlignedRect: NSRect::from(rect), options: 15usize]
}

/// Raises the view above all sibling views of the content view.
unsafe fn raise(view: *mut AnyObject) {
    let parent: *mut AnyObject = msg_send![view, superview];
    if parent.is_null() {
        return;
    }
    // NSWindowAbove is 1.
    let _: () = msg_send![parent, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
}

/// Sets the corner radius, line width, fill color and line color of the shape.
pub fn style(view: Handle, radius: f64, line_width: f64, fill: [f64; 4], line: [f64; 4]) {
    unsafe {
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

/// Removes the shape view.
pub fn destroy(view: Handle) {
    unsafe {
        let view = view as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let _: () = msg_send![view, removeFromSuperview];
        // Releases the reference that alloc returned. The reference of the parent view was released in the line above.
        let _: () = msg_send![view, release];
    }
}
