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
//! It also holds the two other things a surface needs from its platform: how
//! solid it is drawn, and where a press landed. A surface is a native view, so
//! a press on it never reaches the page, and the window is the only place that
//! sees it.
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
