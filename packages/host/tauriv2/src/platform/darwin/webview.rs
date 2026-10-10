//! Placement, opacity, resize notification, order and corners of native webviews.
//!
//! A modal is drawn by a separate webview, and a webview is a rectangle. To round the corners, the corner radius is set
//! on the CALayer of the NSView so that the view is clipped. The content behind the modal is visible at the clipped
//! corners. No transparency or private interface is used.

use std::ffi::{c_char, c_void, CStr};

use objc2::msg_send;
use objc2::runtime::AnyObject;
use tauri::webview::PlatformWebview;

use super::super::{visible_window_overlay_rects, DOMOverlay, Handle, WindowOverlay};

type FileDropEvent = extern "C" fn(*mut c_void, *const c_char);
type FileDropRelease = extern "C" fn(*mut c_void);

extern "C" {
    fn sp_window_file_drop(
        main_webview: *mut c_void,
        event: FileDropEvent,
        release: FileDropRelease,
        context: *mut c_void,
    ) -> bool;
    fn sp_webview_set_appearance(view: *mut c_void, dark: bool) -> bool;
    fn sp_webview_kill_content_process(view: *mut c_void) -> bool;
    fn sp_webview_collect_garbage(view: *mut c_void) -> bool;
    fn sp_surface_create(main_webview: *mut c_void) -> *mut c_void;
    fn sp_surface_close(surface: *mut c_void);
    fn webviewSetFrame(view: *mut c_void, x: f64, y: f64, width: f64, height: f64);
    fn sp_surface_set_window_overlays(main: *mut c_void, rects: *const f64, count: usize);
}

pub fn create_surface(main: Handle) -> Result<Handle, String> {
    let surface = unsafe { sp_surface_create(main as *mut c_void) } as Handle;
    if surface == 0 {
        Err("cannot create SurfaceHost".into())
    } else {
        Ok(surface)
    }
}

pub fn close_surface(surface: Handle) {
    unsafe { sp_surface_close(surface as *mut c_void) }
}

pub fn place_surface(surface: Handle, x: f64, y: f64, w: f64, h: f64) {
    unsafe { webviewSetFrame(surface as *mut c_void, x, y, w, h) }
}

pub fn surface_frame(surface: Handle) -> [f64; 4] {
    extern "C" {
        fn webviewGetFrame(view: *mut c_void, rect: *mut f64);
    }
    let mut rect = [0.0; 4];
    unsafe { webviewGetFrame(surface as *mut c_void, rect.as_mut_ptr()) };
    rect
}

pub fn set_surface_hidden_handle(surface: Handle, hidden: bool) {
    extern "C" {
        fn webviewSetSurfaceHidden(view: *mut c_void, hidden: bool);
    }
    unsafe { webviewSetSurfaceHidden(surface as *mut c_void, hidden) }
}

pub fn set_surface_alpha_handle(surface: Handle, alpha: f64) {
    extern "C" {
        fn webviewSetSurfaceAlpha(view: *mut c_void, alpha: f64);
    }
    unsafe { webviewSetSurfaceAlpha(surface as *mut c_void, alpha) }
}

pub fn set_main_appearance(view: &PlatformWebview, dark: bool) -> Result<(), String> {
    let view = view.inner();
    if !unsafe { sp_webview_set_appearance(view, dark) } {
        return Err("requested app appearance is unavailable".into());
    }
    Ok(())
}

pub fn kill_content_process(view: &PlatformWebview) -> Result<(), String> {
    if unsafe { sp_webview_kill_content_process(view.inner()) } {
        Ok(())
    } else {
        Err("the WebContent process cannot be terminated".into())
    }
}

pub fn collect_garbage(view: &PlatformWebview) -> Result<(), String> {
    if unsafe { sp_webview_collect_garbage(view.inner()) } {
        Ok(())
    } else {
        Err("the JavaScript garbage collection request is unavailable".into())
    }
}

/// The function that receives the files dropped on the file drop view of the window. It stays alive while the native
/// view uses it, and it is released when the view returns it with file_drop_release.
struct FileDropReceiver(Box<dyn Fn(String)>);

extern "C" fn file_drop_release(context: *mut c_void) {
    drop(unsafe { Box::from_raw(context as *mut FileDropReceiver) });
}

extern "C" fn file_drop_callback(context: *mut c_void, json: *const c_char) {
    let receiver = unsafe { &*(context as *const FileDropReceiver) };
    let json = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    (receiver.0)(json);
}

/// Receives the files dropped on the window of the main webview with receive. Call it on the main thread.
pub fn file_drop(main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String> {
    let receiver = Box::into_raw(Box::new(FileDropReceiver(receive)));
    if unsafe {
        sp_window_file_drop(
            main as *mut c_void,
            file_drop_callback,
            file_drop_release,
            receiver as *mut c_void,
        )
    } {
        Ok(())
    } else {
        drop(unsafe { Box::from_raw(receiver) });
        Err("the main webview has no window composition for file drops".into())
    }
}

pub fn set_window_overlays(main: Handle, overlays: &[WindowOverlay]) {
    let values = visible_window_overlay_rects(overlays);
    unsafe {
        sp_surface_set_window_overlays(main as *mut c_void, values.as_ptr(), values.len() / 4)
    }
}

/// Applies a corner radius of radius logical pixels.
pub fn corners(webview: &PlatformWebview, radius: f64) {
    unsafe {
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
}

/// Sets the opacity of the view. A surface that lost the focus can be drawn dimmed.
pub fn alpha(webview: &PlatformWebview, alpha: f64) {
    extern "C" {
        fn webviewSetSurfaceAlpha(view: *mut c_void, alpha: f64);
    }
    unsafe { webviewSetSurfaceAlpha(webview.inner().cast(), alpha) }
}

/// Converts window coordinates into the parent coordinates of the native view and places it.
pub fn place(webview: &PlatformWebview, x: f64, y: f64, w: f64, h: f64) {
    extern "C" {
        fn webviewSetFrame(view: *mut c_void, x: f64, y: f64, w: f64, h: f64);
    }
    unsafe { webviewSetFrame(webview.inner().cast(), x, y, w, h) }
}

/// Registers a content webview in the common container with device pixel coordinates.
pub fn attach_surface(webview: &PlatformWebview, main: Handle) {
    extern "C" {
        fn webviewAttachSurface(view: *mut c_void, main: *mut c_void);
    }
    unsafe { webviewAttachSurface(webview.inner().cast(), main as *mut c_void) }
}

pub fn detach_surface(webview: &PlatformWebview) {
    extern "C" {
        fn webviewDetachSurface(view: *mut c_void);
    }
    unsafe { webviewDetachSurface(webview.inner().cast()) }
}

pub fn hidden(webview: &PlatformWebview, hidden: bool) {
    extern "C" {
        fn webviewSetSurfaceHidden(view: *mut c_void, hidden: bool);
    }
    unsafe { webviewSetSurfaceHidden(webview.inner().cast(), hidden) }
}

pub fn overlays(surface: Handle, overlays: &[DOMOverlay]) {
    extern "C" {
        fn webviewSetSurfaceOverlays(view: *mut c_void, values: *const f64, count: usize);
    }
    let mut values = Vec::with_capacity(overlays.len() * 5);
    for overlay in overlays {
        values.extend_from_slice(&[
            overlay.insets.left,
            overlay.insets.top,
            overlay.insets.right,
            overlay.insets.bottom,
            if overlay.visible { 1.0 } else { 0.0 },
        ]);
    }
    unsafe { webviewSetSurfaceOverlays(surface as *mut c_void, values.as_ptr(), overlays.len()) }
}

/// Returns the current position and size of the webview in page coordinates.
pub fn frame(webview: &PlatformWebview) -> [f64; 4] {
    extern "C" {
        fn webviewGetFrame(view: *mut c_void, rect: *mut f64);
    }
    let mut rect = [0.0; 4];
    unsafe { webviewGetFrame(webview.inner().cast(), rect.as_mut_ptr()) }
    rect
}

/// Passes the start and the end of a continuous surface resize to the webview.
pub fn live_resize(webview: &PlatformWebview, live: bool) {
    unsafe {
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

/// Raises the webview above another view of the same parent.
pub fn raise(webview: &PlatformWebview) {
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        let parent: *mut AnyObject = msg_send![view, superview];
        // NSWindowAbove is 1.
        let _: () = msg_send![parent, addSubview: view, positioned: 1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
    }
}

/// Makes the webview the first responder of the window. Call it on the main thread.
pub fn focus(webview: &PlatformWebview) -> Result<(), String> {
    unsafe {
        let view = webview.inner() as *mut AnyObject;
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() {
            return Err("the webview is not in a window".into());
        }
        let taken: bool = msg_send![window, makeFirstResponder: view];
        if taken {
            Ok(())
        } else {
            Err("the window did not give the webview keyboard focus".into())
        }
    }
}

/// Returns the address of the view that the webview draws. It is compared with the view addresses of the input chain to
/// identify the webview.
pub fn id(webview: &PlatformWebview) -> Handle {
    webview.inner() as Handle
}
