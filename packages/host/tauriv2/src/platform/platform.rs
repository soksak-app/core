//! The interface of the platform functions that the host uses and the selection of the implementation of the current
//! operating system.
//!
//! Operating-system-specific code is placed only in `<os>/` under this directory. Other files call native functions
//! only through the [`Platform`] that [`current`] returns.

use std::fs::Metadata;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use tauri::webview::PlatformWebview;
use tauri::{AppHandle, WebviewWindowBuilder, Window, Wry};

/// An authenticated persistent sidecar stream that the active platform provides.
pub trait PersistentStream: Read + Write + Send {
    fn try_clone(&self) -> Result<Box<dyn PersistentStream>, String>;
    /// Closes both directions of the connection. The io error is returned as it is so that the caller can tell an
    /// unconnected socket (ENOTCONN).
    fn shutdown(&self) -> std::io::Result<()>;
    /// Makes the next read finish within the deadline. None waits indefinitely. It keeps the hello round trip from
    /// stopping forever while it holds the state lock (V5-106). The read thread that follows is set back to wait
    /// indefinitely.
    fn set_read_deadline(&self, timeout: Option<std::time::Duration>) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
mod darwin;

#[cfg(windows)]
#[path = "windows/windows.rs"]
mod windows;

/// The number of live objects, among those that the shared library attached to windows and webviews, whose lifetime
/// shows the release of the window and the webview. When a closed window and its webviews are released, the object
/// count of that window decreases.
#[cfg(feature = "diagnostics")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowObjects {
    /// The number of composite views that hold the main webview in the content view of the window.
    pub window_compositions: i64,
    /// The number of logical surfaces and containers of the webviews attached to the surfaces.
    pub surface_hosts: i64,
    /// The number of registrations of webviews that registered input (main, modal and surface webviews).
    pub input_registrations: i64,
}

#[cfg(feature = "diagnostics")]
impl WindowObjects {
    /// The response of diagnostics.native.objects.
    pub fn payload(&self) -> Value {
        serde_json::json!({
            "windowCompositions": self.window_compositions,
            "surfaceHosts": self.surface_hosts,
            "inputRegistrations": self.input_registrations,
        })
    }

    /// Reads equal of diagnostics.native.objects. A name other than the three names, a missing name, and a value that
    /// is not an integer or is negative are rejected.
    pub fn from_equal(value: &Value) -> Result<Self, String> {
        const INVALID: &str = "equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer";
        let fields = value
            .as_object()
            .filter(|fields| fields.len() == 3)
            .ok_or(INVALID)?;
        let read = |name: &str| {
            fields
                .get(name)
                .and_then(Value::as_i64)
                .filter(|n| *n >= 0)
                .ok_or_else(|| INVALID.to_string())
        };
        Ok(Self {
            window_compositions: read("windowCompositions")?,
            surface_hosts: read("surfaceHosts")?,
            input_registrations: read("inputRegistrations")?,
        })
    }
}

/// Reads the pid of diagnostics.process.exit. It is rejected when it is missing, is not a JSON integer, or is not
/// between 1 and 2147483647.
#[cfg(feature = "diagnostics")]
pub fn parse_process_id(value: Option<&Value>) -> Result<i32, String> {
    value
        .and_then(Value::as_i64)
        .filter(|pid| (1..=i64::from(i32::MAX)).contains(pid))
        .map(|pid| pid as i32)
        .ok_or_else(|| "pid must be a positive integer".to_string())
}

/// The notation of a number used in an error message.
#[cfg(feature = "diagnostics")]
impl std::fmt::Display for WindowObjects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "windowCompositions {}, surfaceHosts {}, inputRegistrations {}",
            self.window_compositions, self.surface_hosts, self.input_registrations
        )
    }
}

/// An address that points to a native window, view or input monitor.
pub type Handle = usize;

/// A rectangle in the order x, y, width, height.
pub type Frame = (f64, f64, f64, f64);

/// The project window builder.
pub type WindowBuilder<'a> = WebviewWindowBuilder<'a, Wry, AppHandle<Wry>>;

/// One connection of the local endpoint.
pub trait Connection: Read + Write + Send {
    /// Returns another value that points to the same connection. It is used when reading and writing run on different
    /// threads.
    fn try_clone(&self) -> Result<Box<dyn Connection>, String>;
    /// Sets the read timeout. None means no limit.
    fn set_read_timeout(&self, timeout: Option<Duration>) -> Result<(), String>;
    /// Closes both reading and writing of the connection.
    fn close(&self) -> Result<(), String>;
}

/// The listening address of the local endpoint.
pub trait Listener: Send + Sync {
    /// Waits for the next connection.
    fn accept(&self) -> Result<Box<dyn Connection>, String>;
    /// The transport value of endpoint.json.
    fn transport(&self) -> &'static str;
    /// The address value of endpoint.json.
    fn address(&self) -> String;
    /// Removes the file that the address created.
    fn remove(&self);
}

/// A pointer action that is delivered as native input. Coordinates are values in points relative to the upper left of
/// the content area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pointer {
    pub x: f64,
    pub y: f64,
    /// 0 move, 1 press, 2 drag, 3 release, 4 scroll.
    pub phase: i32,
    /// 0 left, 1 right.
    pub button: i32,
    pub delta_x: f64,
    pub delta_y: f64,
    /// Activates the application and makes the window the key window before the move. It is true only when phase is 0.
    pub activate: bool,
}

/// The state that AppKit reported in the attempt that was rejected with Delivery::ButtonHeld.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ButtonHeld {
    /// The NSEvent.pressedMouseButtons value.
    pub mask: u64,
    /// The frontmost application. It is None when AppKit reports no frontmost application.
    pub frontmost: Option<FrontmostApplication>,
}

/// The frontmost application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmostApplication {
    /// The bundle identifier. It is None when there is none.
    pub bundle_identifier: Option<String>,
    pub pid: i32,
}

/// The result of delivering pointer input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    /// It was delivered to the window.
    Delivered,
    /// The window, coordinates or phase are not valid.
    Rejected,
    /// A move without a button, and the window is not the key window.
    Inactive,
    /// A press or a release was delivered, but the document did not receive it within the time limit.
    Unreceived,
    /// AppKit reports a pressed mouse button, so a synthetic press or release was not delivered. The value is the state
    /// of the rejected attempt.
    ButtonHeld(ButtonHeld),
    /// A synthetic press of that button is still open in that window, so the press was not delivered.
    PressOpen,
}

/// A key action that is delivered as native input.
#[derive(Debug, Clone, PartialEq)]
pub struct Key {
    /// A key name or one character.
    pub key: String,
    /// The string to type. When it is None, key is used.
    pub text: Option<String>,
    /// A bit sum: 1 Shift, 2 Control, 4 Option, 8 Command.
    pub modifiers: u32,
    pub down: bool,
}

/// The view at a point in window coordinates. chain is the addresses from the leaf view to the content view, and
/// identifier is the identifier of the leaf view. view_class and view_frame are the actual class and the
/// content-coordinate frame of that leaf.
pub struct Hit {
    pub chain: Vec<Handle>,
    pub identifier: String,
    pub view_class: Option<String>,
    pub view_frame: Option<Frame>,
}

/// The CSS pixel insets of the surface viewport (left, top, right, bottom).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Insets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// The CSS pixel insets and the visibility of a declared DOM overlay, relative to the surface viewport.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DOMOverlay {
    pub insets: Insets,
    pub visible: bool,
}

/// A global overlay of the main DOM plane and its CSS coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowOverlay {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub visible: bool,
}

/// A value read from the system clipboard of the user. `Absent` is not an error.
#[derive(Debug, Clone, PartialEq)]
pub enum ClipboardValue {
    Absent,
    Text(String),
    Png(Vec<u8>),
    FileUrls(Vec<String>),
}

pub fn visible_window_overlay_rects(overlays: &[WindowOverlay]) -> Vec<f64> {
    overlays
        .iter()
        .filter(|overlay| overlay.visible)
        .flat_map(|overlay| [overlay.x, overlay.y, overlay.w, overlay.h])
        .collect()
}

/// The device pixel size of an applied image region and the device pixels per CSS pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// The window, webview, surface placement, shape, input, capture, Dock, directory identification and endpoint functions
/// that the operating system provides.
///
/// A function that is not implemented returns a "not implemented" error.
pub trait Platform: Send + Sync {
    /// Runs work once on the main queue after the current framework event callback ends.
    fn enqueue_ui(&self, work: Box<dyn FnOnce() + Send>) -> Result<(), String>;

    // Window

    /// Applies the operating-system-specific window settings to the project window builder.
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String>;
    /// Returns the native address of the window.
    fn window_handle(&self, window: &Window) -> Result<Handle, String>;
    fn set_main_webview(&self, window: Handle, main: Handle) -> Result<(), String>;
    /// Keeps the window transparent, and makes it opaque when the next presentation ends after the first load of the
    /// main webview ended. The caller puts the window on the screen after this call
    /// (native/darwin/src/window_reveal.h). Call it on the UI thread.
    fn reveal_after_load(&self, window: Handle) -> Result<(), String>;
    fn set_main_appearance(&self, view: &PlatformWebview, dark: bool) -> Result<(), String>;
    /// Changes the window to full screen or back, and calls done when the transition ends. A request that arrives
    /// during a transition is handled after that transition ends.
    fn fullscreen(&self, window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String>;
    /// Calls changed on the UI thread whenever the occlusion state of the window changes. The observation ends with the
    /// window.
    fn observe_occlusion(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<(), String>;

    /// Returns the title bar height (pt) of the window. It is 0 while the title bar is not shown, as in full screen,
    /// and it returns an error when the window has no buttons. Call it on the UI thread.
    fn titlebar_height(&self, window: Handle) -> Result<f64, String>;
    /// Creates the title bar of the window with height (pt). AppKit places the window buttons at the vertical center of
    /// that height, so the host does not move the buttons. It returns an error when the window has no buttons. A window
    /// in full screen does not show a title bar, and AppKit restores the height when it leaves or enters full screen,
    /// so it succeeds without changing the height. Call it on the UI thread.
    fn set_titlebar_height(&self, window: Handle, height: f64) -> Result<(), String>;
    /// Returns the area that the window buttons occupy in page coordinates.
    fn window_controls(&self, window: Handle) -> Result<Frame, String>;
    #[cfg(feature = "diagnostics")]
    /// Returns the number that the window server assigned to the window and the windows attached to it.
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String>;
    /// Returns the view at a point in window coordinates. Call it on the main thread.
    fn hit(&self, window: Handle, x: f64, y: f64) -> Result<Hit, String>;
    /// Returns the frame, the active state, the window buttons and the webviews of the window as JSON. The format is
    /// the same as sp_window_facts of native/darwin/src/window_facts.h. Call it on the main thread.
    fn window_facts(&self, window: Handle) -> Result<Value, String>;
    /// Moves the upper left of the window frame to the screen coordinates (x, y). Call it on the main thread.
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String>;
    /// Returns the displays [{x, y, width, height, scale}] in screen coordinates. Call it on the main thread.
    fn screens(&self) -> Result<Value, String>;
    /// Returns whether the application stays alive when all windows are closed.
    fn stays_open_without_windows(&self) -> bool;

    // Webview

    /// Converts a rectangle in window coordinates into the parent coordinates of the webview and places it.
    fn place_webview(
        &self,
        view: &PlatformWebview,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String>;
    /// Returns the current position and size of the webview in page coordinates.
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String>;
    /// Creates a logical SurfaceHost under the main DOM webview. This call does not create a DOM webview.
    fn create_surface(&self, main: Handle) -> Result<Handle, String>;
    fn close_surface(&self, surface: Handle) -> Result<(), String>;
    fn place_surface(&self, surface: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String>;
    fn surface_frame(&self, surface: Handle) -> Result<[f64; 4], String>;
    fn set_surface_hidden_handle(&self, surface: Handle, hidden: bool) -> Result<(), String>;
    fn set_surface_alpha_handle(&self, surface: Handle, alpha: f64) -> Result<(), String>;
    fn set_window_overlays(&self, main: Handle, overlays: &[WindowOverlay]) -> Result<(), String>;
    /// Receives the files dropped on the window of the main webview. receive receives {"urls":[...],"x":..,"y":..}
    /// (page coordinates).
    fn file_drop(&self, main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String>;
    /// Registers a surface webview in the surface container of the main webview.
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String>;
    /// Removes a surface webview and its SurfaceHost from the surface container.
    fn detach_surface(&self, view: &PlatformWebview) -> Result<(), String>;
    /// Sets the visibility of the SurfaceHost and of its two planes together.
    fn set_surface_hidden(&self, view: &PlatformWebview, hidden: bool) -> Result<(), String>;
    /// Sets the declared DOM overlays that are handled before native input.
    fn set_surface_overlays(&self, surface: Handle, overlays: &[DOMOverlay]) -> Result<(), String>;
    /// Sets the opacity of the webview.
    fn set_alpha(&self, view: &PlatformWebview, alpha: f64) -> Result<(), String>;
    /// Terminates the current WebContent process. It is called so that the termination of the application leaves no
    /// WebKit child process.
    fn kill_web_content_process(&self, view: &PlatformWebview) -> Result<(), String>;
    /// Makes the WebContent processes of view collect JavaScript objects. The memory measurement of a diagnostic build
    /// uses it.
    fn collect_garbage(&self, view: &PlatformWebview) -> Result<(), String>;
    /// Passes the start and the end of a continuous resize to the webview.
    fn set_live_resize(&self, view: &PlatformWebview, live: bool) -> Result<(), String>;
    /// Raises the webview above another view of the same parent.
    fn raise_webview(&self, view: &PlatformWebview) -> Result<(), String>;
    /// Clips the corners of the webview so that they are rounded by radius logical pixels.
    fn round_corners(&self, view: &PlatformWebview, radius: f64) -> Result<(), String>;
    /// Makes the webview the first responder of the window so that it receives keyboard input. It returns an error when
    /// the window refuses.
    fn focus_webview(&self, view: &PlatformWebview) -> Result<(), String>;

    // Document region

    /// Creates a hidden external document webview inside the surface webview surface. store is the absolute path in
    /// which the persistent data store keeps the site data. changed receives the state JSON ({url, title, loading,
    /// progress, canGoBack, canGoForward, error, scroll}) on the main thread. Call it on the main thread.
    /// folder and plugin are the installed folder and the id of the plugin whose surface owns the region; the region
    /// serves sok://<plugin>/<path> from folder (docs/spec/native-surfaces.md#document-regions).
    fn create_document(
        &self,
        surface: Handle,
        store: &str,
        folder: &str,
        plugin: &str,
        changed: Box<dyn Fn(String)>,
    ) -> Result<Handle, String>;
    fn set_document_event(
        &self,
        document: Handle,
        event: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String>;
    /// Receives {"message": value} for each message of a plugin document and {"error": reason}.
    fn set_document_message(
        &self,
        document: Handle,
        message: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String>;
    /// Posts the JSON value json to the current plugin document; false when there is none.
    fn post_document(&self, document: Handle, json: &str) -> Result<bool, String>;
    /// Opens an http, https, file or sok address; returns false for another address. Called on the main thread.
    fn load_document(&self, document: Handle, url: &str) -> Result<bool, String>;
    /// Sets the page zoom of the document. It is false when the value is not a finite positive number.
    fn zoom_document(&self, document: Handle, zoom: f64) -> Result<bool, String>;
    /// Runs back 0, forward 1, reload 2 and stop 3, and returns whether it ran. Call it on the main thread.
    fn go_document(&self, document: Handle, action: i32, offset: i32) -> Result<bool, String>;
    /// Sets the document region with the CSS pixel insets of the surface viewport. Call it on the main thread.
    fn place_document(&self, document: Handle, insets: Insets, visible: bool)
        -> Result<(), String>;
    /// Dims the document while a dialog is open. Call it on the main thread.
    fn set_document_background(&self, document: Handle, enabled: bool) -> Result<(), String>;
    /// Sets the appearance of the native document webview to the current host scheme.
    fn set_document_appearance(&self, document: Handle, dark: bool) -> Result<(), String>;
    /// Removes the document webview. changed is not called afterwards. Call it on the main thread.
    fn close_document(&self, document: Handle) -> Result<(), String>;
    /// Returns the view address that identifies the webview in the input chain.
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String>;

    // Image region

    /// Creates an external image display region inside the surface webview surface. name is the region name. event
    /// receives keyboard, IME and input events as a JSON string ({key, insert, compose, focus, size, error}) on the
    /// main thread. Call it on the main thread.
    fn create_image(
        &self,
        surface: Handle,
        name: &str,
        event: Box<dyn Fn(String)>,
    ) -> Result<Handle, String>;
    /// Sets the image region with the CSS pixel insets of the surface viewport. Call it on the main thread.
    fn place_image(&self, image: Handle, insets: Insets, visible: bool) -> Result<(), String>;
    /// Returns the raster geometry of the applied image region. It is None when there is no valid size yet.
    fn image_raster(&self, image: Handle) -> Result<Option<Raster>, String>;
    /// Whether the surface of the region has a native size. The region of a surface that is not placed yet has no
    /// raster size.
    fn image_surface_placed(&self, image: Handle) -> Result<bool, String>;
    /// Returns the current frame, the displayed raster and the error of the image region as JSON. Call it on the main
    /// thread.
    fn image_facts(&self, image: Handle) -> Result<String, String>;
    /// Displays an external IOSurface. token_id is the global ID of the IOSurface, nonce is the 16 bytes of data to
    /// check the nonce, width and height are the size in device pixels, and scale is the scale at which the image was
    /// created. It returns true on success, and false when it was not found or the size does not match. Call it on the
    /// main thread.
    fn present_image(
        &self,
        image: Handle,
        token_id: u32,
        nonce: [u8; 16],
        width: f64,
        height: f64,
        scale: f64,
    ) -> Result<bool, String>;
    /// Makes the region the first responder and sends the focus event. Call it on the main thread.
    fn focus_image(&self, image: Handle) -> Result<(), String>;
    /// Stores the caret (text cursor) position. Call it on the main thread.
    fn caret_image(&self, image: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String>;
    /// Stores the string that is shown as the accessibility value. Call it on the main thread.
    fn text_image(&self, image: Handle, utf8: &str) -> Result<(), String>;
    /// Removes the image region. event is not called afterwards. Call it on the main thread.
    fn close_image(&self, image: Handle) -> Result<(), String>;

    // Surface placement

    /// Starts the surface placement transaction ticket of the window and passes to ready whether the start is allowed.
    fn begin_layout(
        &self,
        window: Handle,
        ticket: u64,
        ready: Box<dyn Fn(bool)>,
    ) -> Result<(), String>;
    /// Settles the surface placement transaction ticket and returns whether it was settled.
    fn commit_layout(&self, window: Handle, ticket: u64) -> Result<bool, String>;
    /// Cancels the surface placement transaction in progress of the window.
    fn cancel_layout(&self, window: Handle) -> Result<(), String>;
    /// Sets the title bar of the window to height (pt) when a new page starts. A visible window is set inside the start
    /// transaction of ticket and committed together with the first presentation of the new page
    /// (surfaceLayoutStartPage). ready is called on the UI thread after the title bar is set or after a failure. Call
    /// it on the UI thread.
    fn start_page_titlebar(
        &self,
        window: Handle,
        ticket: u64,
        height: f64,
        ready: Box<dyn Fn(Result<(), String>)>,
    ) -> Result<(), String>;
    /// Checks the presentation readiness of the app document before the open placement is committed.
    fn after_presentation(&self, view: &PlatformWebview, done: Box<dyn Fn()>)
        -> Result<(), String>;
    /// When the window has no open surface placement transaction, calls done after the rendering of the main document
    /// and the shown document ended. The argument is the time (ms, mach absolute time) at which that screen is
    /// presented.
    fn after_settled(
        &self,
        view: &PlatformWebview,
        done: Box<dyn Fn(Result<f64, String>)>,
    ) -> Result<(), String>;
    /// Makes the next wait for a settled presentation fail once, for diagnostic purposes.
    fn inject_settled_failure(&self) -> Result<(), String>;

    // Shape

    /// Creates a shape view in the window content view and returns the address. It returns 0 when it could not create
    /// it.
    fn create_shape(&self, window: Handle, frame: Frame) -> Result<Handle, String>;
    /// Places the shape view and raises it above its sibling views.
    fn place_shape(&self, shape: Handle, frame: Frame) -> Result<(), String>;
    /// Sets the corner radius, line width, fill color and line color of the shape. The colors are RGBA in the range
    /// 0-1.
    fn style_shape(
        &self,
        shape: Handle,
        radius: f64,
        line_width: f64,
        fill: [f64; 4],
        line: [f64; 4],
    ) -> Result<(), String>;
    /// Removes the shape view.
    fn destroy_shape(&self, shape: Handle) -> Result<(), String>;

    // Input

    /// Registers a webview in the common pointer routing and returns whether it was registered.
    fn register_input(&self, view: &PlatformWebview) -> Result<bool, String>;
    /// Keeps the page of a webview from moving the keyboard focus of the window, and returns whether it was applied.
    fn ignore_page_focus(&self, view: &PlatformWebview) -> Result<bool, String>;
    /// Watches the input of the window and returns the address of the monitor.
    ///
    /// pressed receives the list of addresses from the view that received the input to the content view, and returns
    /// true when the input is in a view of this application. pointed receives the phases of a left-button drag that
    /// started in that view (0 press, 1 move, 2 release) and the coordinates relative to the top of the content view.
    fn watch_input(
        &self,
        window: Handle,
        pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
        pointed: Box<dyn Fn(u8, f64, f64)>,
    ) -> Result<Handle, String>;
    /// Removes an input monitor.
    fn unwatch_input(&self, monitor: Handle) -> Result<(), String>;
    /// Delivers pointer input to the window and returns the result. activate is not used. Call it on the main thread.
    /// For a press and a release, done is called on the main thread after the document at the coordinates received the
    /// event or after receive elapsed. For the other phases it is called as soon as the input is delivered.
    fn input_pointer(
        &self,
        window: Handle,
        pointer: Pointer,
        receive: Duration,
        done: Box<dyn FnOnce(Delivery) + Send>,
    ) -> Result<(), String>;
    /// Activates the application and makes the window the key window. On the main thread it calls done(Ok) when the
    /// webview of the window reflects the active state, and done(Err) that states the stopped stage when it does not
    /// finish within timeout. Call it on the main thread.
    fn input_activate(
        &self,
        window: Handle,
        x: f64,
        y: f64,
        timeout: Duration,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String>;
    /// Delivers key input to the window and returns whether it was delivered. Call it on the main thread.
    fn input_key(&self, window: Handle, key: &Key) -> Result<Delivery, String>;

    // Capture

    #[cfg(feature = "diagnostics")]
    /// Prepares the window with the window number as a capture target. When display is set, it captures the windows of
    /// this application on the display that holds the window.
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Starts to record frames in directory.
    fn capture_start(&self, directory: &str) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Waits for the first frame and returns whether it was recorded.
    fn capture_wait(&self) -> Result<bool, String>;
    #[cfg(feature = "diagnostics")]
    /// Records until the presentation time after (ms, the call time when 0), ends the record and returns the number of
    /// recorded frames.
    fn capture_stop(&self, after: f64) -> Result<i32, String>;
    #[cfg(feature = "diagnostics")]
    /// Returns whether the last recording reached the finite frame limit and stopped automatically.
    fn capture_limited(&self) -> Result<bool, String>;
    #[cfg(feature = "diagnostics")]
    /// The longest presentation interval (ms) between consecutive frames in the record that was stopped last.
    fn capture_longest_gap(&self) -> Result<f64, String>;
    #[cfg(feature = "diagnostics")]
    /// The current time (ms). It is on the same clock as the presentation time of the recorded frames.
    fn capture_clock(&self) -> Result<f64, String>;
    #[cfg(feature = "diagnostics")]
    /// Takes one still image of the window with the window number without giving it focus and writes it as PNG to path.
    /// It is observation material.
    fn capture_still(&self, window_number: isize, path: &str) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Gives done the notifications of this application that the notification center still shows as JSON [{identifier,
    /// title, body}]. Call it on the main thread, and done is called on the main thread too.
    fn delivered_notifications(&self, done: Box<dyn FnOnce(String) + Send>) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// After the application handled one event and drained the autorelease pool of that event loop iteration, gives
    /// done the count of library objects attached to windows and webviews and true when the count equals expected. If
    /// the count does not equal expected within seconds, it gives the count at that time and false. When expected is
    /// None, it gives the count after the event and true. Call it on the main thread, and done is called on the main
    /// thread too.
    fn window_objects_when(
        &self,
        expected: Option<WindowObjects>,
        seconds: f64,
        done: Box<dyn FnOnce(WindowObjects, bool) + Send>,
    ) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Gives done true when the process pid ends and false when it does not end within seconds. A process that no
    /// longer exists has ended. Call it on the main thread, and done is called on the main thread too.
    fn when_process_exited(
        &self,
        pid: i32,
        seconds: f64,
        done: Box<dyn FnOnce(bool) + Send>,
    ) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Starts to record the start, the app DOM presentation check and the commit times of each placement transaction.
    /// Call it on the main thread.
    fn layout_trace_start(&self) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Stops the record and returns ticket, begun, presented and committed (ms, on the same clock as the presentation
    /// time) of each transaction. A stage that did not happen is NaN. Call it on the main thread.
    fn layout_trace_stop(&self) -> Result<Vec<[f64; 5]>, String>;

    // Input source

    #[cfg(feature = "diagnostics")]
    /// Returns the identifier of the currently selected keyboard input source. Call it on the main thread.
    fn input_source(&self) -> Result<String, String>;
    #[cfg(feature = "diagnostics")]
    /// Selects identifier among the enabled input sources. Call it on the main thread.
    fn select_input_source(&self, identifier: &str) -> Result<(), String>;

    // Termination request

    /// Makes the first termination signal (SIGTERM, SIGINT, SIGHUP) call quit. The termination signals after it end the
    /// process with the default action.
    fn on_termination(&self, quit: Box<dyn Fn() + Send>) -> Result<(), String>;
    /// Makes a termination request of the operating system (quit from the Dock, logout, restart, a quit Apple event
    /// from another program) call quit, and does not answer that request until answer_quit_requests. Call it on the
    /// main thread after the application started.
    fn on_quit_request(&self, quit: Box<dyn Fn()>) -> Result<(), String>;
    /// Answers the termination request that was received without an error. Call it on the main thread just before the
    /// application ends after the save finished.
    fn answer_quit_requests(&self);
    /// Answers the termination request that was received with userCanceledErr. Call it on the main thread when a window
    /// protects a modified tab and the application does not end.
    fn cancel_quit_requests(&self);

    // Window behavior

    /// Makes the window zoom and the animated size change finish within one screen update. Call it before the window is
    /// created.
    fn instant_window_resize(&self) -> Result<(), String>;

    // Standard error

    /// Moves whole records of the native event ring into `buffer` and returns the number of bytes written; 0 means the ring
    /// is empty (docs/spec/logging.md#writers).
    fn pull_native_events(&self, buffer: &mut [u8]) -> Result<usize, String>;
    /// Returns the events and bytes that the native ring refused since the last call.
    fn take_native_event_loss(&self) -> Result<(u64, u64), String>;
    /// Installs the observers that record the activity of the application and of its windows as events of the native ring
    /// (docs/spec/logging.md#automatic-entrances). A second call installs nothing more.
    fn observe_activity(&self) -> Result<(), String>;
    /// Replaces the standard error of the process with file. A child process that starts afterwards also inherits that
    /// descriptor (docs/spec/hosts.md#application-log).
    fn replace_standard_error(&self, file: &std::fs::File) -> Result<(), String>;
    /// Installs the handlers that write a fatal signal or an uncaught exception as an error line before the process ends.
    fn install_fatal_handlers(&self) -> Result<(), String>;

    // Dock

    /// Installs the new window item in the Dock menu. When the item is selected, new_window is called.
    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String>;

    // Clipboard. The implementations follow the contract that the caller calls them on the main thread.
    fn clipboard_read(&self, kind: &str) -> Result<ClipboardValue, String>;
    fn clipboard_write_text(&self, text: &str) -> Result<(), String>;
    fn clipboard_write_png(&self, bytes: &[u8]) -> Result<(), String>;
    /// Opens a URL in the default application of the user for its scheme. Call it on the main thread.
    fn open_link(&self, url: &str) -> Result<(), String>;
    /// Installs the watch of the mask of the pressed mouse buttons that the operating system reports. At the
    /// installation it reports the current mask, and afterwards at every press or release of a mouse button delivered
    /// to any application it reports the mask of that attempt through changed on the main thread. The same mask is also
    /// reported again. Call it once on the main thread.
    fn watch_buttons(&self, changed: Box<dyn Fn(u64) + Send + Sync>) -> Result<(), String>;
    /// Starts to use the notification center of the operating system and passes its event JSON to receive on the main
    /// thread ({"type":"state",...} and {"type":"activated","identifier":...}). Call it on the main thread.
    fn start_notifications(&self, receive: Box<dyn Fn(String) + Send + Sync>)
        -> Result<(), String>;
    /// Posts or replaces the notification of identifier. Call it on the main thread.
    fn post_notification(&self, identifier: &str, title: &str, body: &str) -> Result<(), String>;
    /// Clears the notification of identifier. Call it on the main thread.
    fn remove_notification(&self, identifier: &str) -> Result<(), String>;
    /// Returns the list of titles of the Dock menu items. Call it on the main thread.
    fn dock_items(&self) -> Result<Value, String>;
    /// Returns the application menu. Each submenu is {title, items: [{title, key}]}. Call it on the main thread.
    fn menu_items(&self) -> Result<Value, String>;

    /// The main tag of the system preferred language. The table of the caller decides whether it is supported.
    fn preferred_language(&self) -> Result<String, String>;
    /// The product version of the operating system, such as "26.6.2" (docs/spec/debug.md).
    fn os_version(&self) -> Result<String, String>;
    /// Runs the item with the title title in the submenu with the title menu. Call it on the main thread.
    fn menu_select(&self, menu: &str, title: &str) -> Result<(), String>;
    /// The main window handle of the application. It is 0 when there is none. Call it on the main thread.
    fn main_window(&self) -> Result<Handle, String>;
    /// Runs the Dock menu item with the title title. Call it on the main thread.
    fn dock_select(&self, title: &str) -> Result<(), String>;

    // Directory identification

    /// Returns the same value for paths that point to the same directory.
    fn directory_identity(&self, path: &Path, metadata: &Metadata) -> Result<String, String>;
    /// Creates a missing directory at path with permissions for the current user only. The permissions of an existing
    /// directory are not changed.
    fn create_private_directories(&self, path: &Path) -> Result<(), String>;
    /// Opens the file at path for appending. If it does not exist, it is created as a file that only the current user
    /// reads and writes. The permissions of an existing file are not changed.
    fn append_private_file(&self, path: &Path) -> Result<std::fs::File, String>;
    /// Creates a new file at path that only the current user reads and writes, and opens it for writing. It is an
    /// AlreadyExists error when path already exists.
    fn create_private_file(&self, path: &Path) -> std::io::Result<std::fs::File>;
    /// Replaces the content of the file at path with data. If it does not exist, it is created as a file that only the
    /// current user reads and writes. The permissions of an existing file are not changed.
    fn write_private_file(&self, path: &Path, data: &[u8]) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// Creates a directory that only the current user can access, together with its parent directories.
    fn private_directory(&self, path: &Path) -> Result<(), String>;

    // Endpoint

    /// Opens the local endpoint address with the name name in directory. directory must be for the current user only.
    fn endpoint_listen(&self, directory: &Path, name: &str) -> Result<Box<dyn Listener>, String>;
    /// Connects to a local endpoint address.
    fn endpoint_connect(&self, address: &str) -> Result<Box<dyn Connection>, String>;
    /// Connects to the persistent sidecar service socket.
    fn connect_service(&self, address: &str) -> Result<Box<dyn PersistentStream>, String>;
    /// Makes the service directory for the current user only.
    fn secure_service_directory(&self, path: &Path) -> Result<(), String>;
    /// Checks whether the process of the persistent service endpoint still exists.
    fn service_process_exists(&self, pid: u32) -> Result<bool, String>;
    /// Waits until the service process `pid` ends, for at most `timeout`, and answers whether it ended. A process that
    /// does not exist has ended. The wait uses the kernel notification of the end of a process, which also reports a
    /// process that stays as a zombie, so it does not poll (docs/spec/terminal-runtime.md#updates).
    fn wait_service_process_end(
        &self,
        pid: u32,
        timeout: std::time::Duration,
    ) -> Result<bool, String>;
    /// Makes command start in a new session. A persistent service belongs to the configuration directory and not to the
    /// application process, so it does not receive the signals of the process group of the application and of the
    /// terminal. Call it before command starts.
    fn new_session(&self, command: &mut std::process::Command) -> Result<(), String>;
    /// Writes the end of an ended process as `exit status <code>` or `signal <number>`. Both hosts write the end of a
    /// sidecar to the log with the same text (docs/spec/sidecars.md#declaration-and-startup).
    fn exit_status(&self, status: std::process::ExitStatus) -> Result<String, String>;
}

/// Returns the implementation of the current operating system.
pub fn current() -> Result<&'static dyn Platform, String> {
    #[cfg(target_os = "macos")]
    return Ok(&darwin::Darwin);
    #[cfg(windows)]
    return Ok(&windows::Windows);
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("no platform implementation is registered".into())
}
