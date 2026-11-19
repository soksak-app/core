//! The macOS implementation of the GPUI framework adapter: the NSWindow operations of the port, the wry web views
//! with the soksak and app schemes, the window notifications and the Apple event deep links.

use std::ffi::c_void;

use gpui_kit as gpui;
use http::{Response as HttpResponse, StatusCode};
use objc2::rc::Retained;
use objc2::{AnyThread, DefinedClass as _, define_class, msg_send};
use objc2_app_kit::{NSApp, NSWindow, NSWindowStyleMask};
use objc2_foundation::{MainThreadMarker, NSString};
use raw_window_handle::{AppKitWindowHandle, HasWindowHandle, RawWindowHandle};
use soksak_host::assets::Assets;
use soksak_host::framework::{
    self as port, LogicalPosition, LogicalSize, PlatformWebview, WindowEvent,
};
use wry::{Rect, WebView, WebViewBuilder, WebViewBuilderExtMacos, WebViewExtMacOS};

/// The parent view of a web view of the adapter, which gives the raw window handle of wry.
struct ParentView(*mut c_void);

impl HasWindowHandle for ParentView {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        // default: the adapter creates a web view only with a view that it just read from a live window.
        let view = std::ptr::NonNull::new(self.0.cast()).expect("the parent view is not null");
        let raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(view));
        // default: the handle of a real AppKit view is always borrowable.
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(raw) })
    }
}

/// The NSWindow of a raw NSWindow pointer. The record of the window holds the NSWindow for its lifetime.
fn ns_window(handle: *mut c_void) -> &'static NSWindow {
    unsafe { &*handle.cast::<NSWindow>() }
}

/// The raw NSWindow of a GPUI window, whose content view holds the web views of the host.
pub(crate) fn ns_window_of(window: &gpui::Window) -> *mut c_void {
    unsafe {
        let handle =
            HasWindowHandle::window_handle(window).expect("the GPUI window has a raw handle");
        let view = handle.as_raw();
        let RawWindowHandle::AppKit(handle) = view else {
            return std::ptr::null_mut();
        };
        let view: &objc2_app_kit::NSView = &*handle.ns_view.as_ptr().cast();
        let window: Option<Retained<NSWindow>> = msg_send![view, window];
        window
            .map(|window| Retained::into_raw(window) as *mut c_void)
            .unwrap_or(std::ptr::null_mut())
    }
}

// The window operations of the port.

pub(crate) fn title(window: *mut c_void) -> String {
    ns_window(window).title().to_string()
}

pub(crate) fn set_title(window: *mut c_void, title: &str) {
    ns_window(window).setTitle(&NSString::from_str(title));
}

/// Makes the window the key window and activates the application, which is what a person's request to focus the
/// window asks for.
pub(crate) fn focus_window(window: *mut c_void) {
    let mtm = MainThreadMarker::new().expect("the adapter runs window work on the main thread");
    ns_window(window).makeKeyAndOrderFront(None);
    let app = NSApp(mtm);
    if !app.isActive() {
        app.activate();
    }
}

pub(crate) fn is_focused(window: *mut c_void) -> bool {
    ns_window(window).isKeyWindow()
}

pub(crate) fn close_window(window: *mut c_void) {
    ns_window(window).performClose(None);
}

pub(crate) fn scale_factor(window: *mut c_void) -> f64 {
    f64::from(ns_window(window).backingScaleFactor())
}

/// The size of the content of the window, in points.
pub(crate) fn size(window: *mut c_void) -> LogicalSize {
    let frame = ns_window(window)
        .contentView()
        .expect("the window has a content view")
        .frame();
    LogicalSize::new(f64::from(frame.size.width), f64::from(frame.size.height))
}

/// The top left of the window in screen coordinates whose origin is the top left of the screen of the window.
pub(crate) fn position(window: *mut c_void) -> LogicalPosition {
    let frame = ns_window(window).frame();
    let visible = screen(window).frame();
    LogicalPosition::new(
        f64::from(frame.origin.x),
        f64::from(visible.origin.y + visible.size.height - frame.origin.y - frame.size.height),
    )
}

pub(crate) fn set_size(window: *mut c_void, size: LogicalSize) {
    let frame = ns_window(window).frame();
    let size = objc2_foundation::NSSize::new(size.width, size.height);
    let rect = objc2_foundation::NSRect::new(frame.origin, size);
    ns_window(window).setFrame_display(rect, true);
}

pub(crate) fn set_position(window: *mut c_void, position: LogicalPosition) {
    let frame = ns_window(window).frame();
    let visible = screen(window).frame();
    let origin = objc2_foundation::NSPoint::new(
        position.x,
        f64::from(visible.origin.y + visible.size.height)
            - position.y
            - f64::from(frame.size.height),
    );
    ns_window(window).setFrameOrigin(origin);
}

pub(crate) fn maximize(window: *mut c_void) {
    if !ns_window(window).isZoomed() {
        ns_window(window).zoom(None);
    }
}

pub(crate) fn unmaximize(window: *mut c_void) {
    if ns_window(window).isZoomed() {
        ns_window(window).zoom(None);
    }
}

pub(crate) fn is_maximized(window: *mut c_void) -> bool {
    ns_window(window).isZoomed()
}

pub(crate) fn is_fullscreen(window: *mut c_void) -> bool {
    ns_window(window)
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen)
}

pub(crate) fn is_minimized(window: *mut c_void) -> bool {
    ns_window(window).isMiniaturized()
}

/// The screen of the window, or the main screen of a window that no screen holds.
fn screen(window: *mut c_void) -> Retained<objc2_app_kit::NSScreen> {
    let mtm = MainThreadMarker::new().expect("the adapter reads screens on the main thread");
    ns_window(window)
        .screen()
        .or(objc2_app_kit::NSScreen::mainScreen(mtm))
        .expect("the window has a screen")
}

// The web view operations of the port.

pub(crate) fn evaluate_webview(view: *mut WebView, script: &str) {
    // default: a script that the view cannot run reports nothing to a caller that reads no completion.
    let _ = unsafe { (*view).evaluate_script(script) };
}

pub(crate) fn navigate(view: *mut WebView, url: &str) {
    // default: a URL that the view cannot load reports nothing to a caller that reads no completion.
    let _ = unsafe { (*view).load_url(url) };
}

pub(crate) fn webview_url(view: *mut WebView) -> port::Result<url::Url> {
    let address = unsafe { (*view).url() }.map_err(|error| port::Error::from(error.to_string()))?;
    url::Url::parse(&address).map_err(|error| port::Error::from(format!("webview url: {error}")))
}

pub(crate) fn reload(view: *mut WebView) {
    // default: a reload that the view refuses reports nothing to a caller that reads no completion.
    let _ = unsafe { (*view).reload() };
}

/// Drops the wry web view, which removes its view from the window.
pub(crate) fn close_webview(view: *mut WebView) {
    drop(unsafe { Box::from_raw(view) });
}

pub(crate) fn set_webview_visible(view: *mut WebView, visible: bool) {
    // default: a visibility change that the view refuses reports nothing to a caller that reads no completion.
    let _ = unsafe { (*view).set_visible(visible) };
}

pub(crate) fn focus_webview(view: *mut WebView) {
    // default: a focus that the view refuses reports nothing to a caller that reads no completion.
    let _ = unsafe { (*view).focus() };
}

pub(crate) fn set_webview_auto_resize(view: *mut WebView, auto_resize: bool) {
    use objc2_app_kit::NSAutoresizingMaskOptions;
    unsafe {
        let view = (*view).webview();
        let mask = if auto_resize {
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable
        } else {
            NSAutoresizingMaskOptions::empty()
        };
        view.setAutoresizingMask(mask);
    }
}

/// The native handles of a wry web view.
pub(crate) fn platform_webview(view: *mut WebView) -> PlatformWebview {
    unsafe {
        PlatformWebview {
            webview: Retained::into_raw((*view).webview()) as *mut c_void,
            controller: Retained::into_raw((*view).manager()) as *mut c_void,
            window: Retained::into_raw((*view).ns_window()) as *mut c_void,
        }
    }
}

/// The shared configuration of every web view of a window, which holds the process pool, the data store and the
/// scheme handlers of the main web view.
fn shared_configuration(main: *mut WebView) -> Retained<objc2_web_kit::WKWebViewConfiguration> {
    unsafe { (*main).webview().configuration() }
}

/// Creates the main web view of the window in the GPUI window and registers it as the main web view of the native
/// window.
pub(crate) fn main_webview(
    window: &gpui::Window,
    app: port::AppHandle,
    label: &str,
    background: port::Color,
) -> Result<*mut WebView, String> {
    let ns_window = ns_window_of(window);
    let parent = ParentView(content_view(ns_window)?);
    let view = build_webview(parent, app, label, None, Some(background), true, None)?;
    let platform = soksak_host::platform::current()?;
    platform
        .set_main_webview(ns_window as usize, raw_wk(view) as usize)
        .map_err(|error| format!("main webview: {error}"))?;
    unsafe {
        (*view).set_bounds(Rect {
            position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(0.0, 0.0)),
            size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(
                size(ns_window).width,
                size(ns_window).height,
            )),
        })
    }
    .map_err(|error| format!("main webview: {error}"))?;
    Ok(view)
}

/// Adds a child web view to the window of the main web view main, with the configuration that the main web view
/// built.
pub(crate) fn add_child(
    main: *mut WebView,
    label: String,
    url: url::Url,
    background: Option<port::Color>,
    focused: bool,
    position: LogicalPosition,
    size: LogicalSize,
) -> Result<*mut WebView, String> {
    let app = crate::app();
    let window = unsafe { (*main).ns_window() };
    let parent = ParentView(content_view(Retained::as_ptr(&window) as *mut c_void)?);
    let view = build_webview(
        parent,
        app,
        &label,
        Some(url.to_string()),
        background,
        focused,
        Some(shared_configuration(main)),
    )?;
    unsafe {
        (*view).set_bounds(Rect {
            position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(
                position.x, position.y,
            )),
            size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(size.width, size.height)),
        })
    }
    .map_err(|error| format!("webview {label}: {error}"))?;
    Ok(view)
}

/// The raw WKWebView of a wry web view.
fn raw_wk(view: *mut WebView) -> *mut c_void {
    unsafe { Retained::into_raw((*view).webview()) as *mut c_void }
}

/// The content view of a window.
fn content_view(window: *mut c_void) -> Result<*mut c_void, String> {
    let view = ns_window(window)
        .contentView()
        .ok_or("the window has no content view")?;
    Ok(Retained::as_ptr(&view) as *mut c_void)
}

/// The reply of a page file request: its bytes with the content type of its extension, or 404.
fn page_response(path: &str) -> HttpResponse<Vec<u8>> {
    let assets = crate::page_assets();
    let found = assets.get(path);
    let content_type = match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "jsonl" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    match found {
        Some(bytes) => HttpResponse::builder()
            .status(StatusCode::OK)
            .header("Content-Type", content_type)
            .header("Cache-Control", "no-store")
            .body(bytes.into_owned())
            // default: a response of fixed headers over built bytes does not fail.
            .unwrap_or_else(|_| HttpResponse::new(vec![])),
        None => HttpResponse::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(format!("{path} not found\n").into_bytes())
            .unwrap_or_else(|_| HttpResponse::new(vec![])),
    }
}

/// Builds one web view of the host with the soksak scheme of the start documents, the app scheme of the page files
/// and the call channel of the runtime.
#[allow(clippy::too_many_arguments)]
fn build_webview(
    parent: ParentView,
    app: port::AppHandle,
    label: &str,
    url: Option<String>,
    background: Option<port::Color>,
    focused: bool,
    shared: Option<Retained<objc2_web_kit::WKWebViewConfiguration>>,
) -> Result<*mut WebView, String> {
    let scheme_app = app.clone();
    let page_app = app.clone();
    let label_text = label.to_string();
    let mut builder = WebViewBuilder::new()
        .with_id(label)
        .with_initialization_script(crate::BOOTSTRAP)
        .with_accept_first_mouse(true)
        .with_asynchronous_custom_protocol("soksak".into(), move |id, request, responder| {
            let app = scheme_app.clone();
            let owner = id.to_string();
            soksak_host::start::serve_async(
                crate::PAGE_APP_ORIGIN,
                owner,
                request.uri().path().to_string(),
                id.to_string(),
                move |webview| soksak_host::start::start_page(&app, webview),
                move |response| {
                    // default: a responder of an ended task drops its response, which wry reports to WebKit.
                    responder.respond(response);
                },
            );
        })
        .with_asynchronous_custom_protocol("app".into(), move |_id, request, responder| {
            let path = request.uri().path();
            // The address of the start file of a directory is the directory with a trailing separator.
            let path = if path == "/" {
                "index.html"
            } else {
                path.trim_start_matches('/')
            };
            let response = page_response(path);
            let _ = page_app;
            responder.respond(response);
        })
        .with_ipc_handler(move |request| {
            crate::bindings::route(&page_app, &label_text, request.body().to_string());
        });
    if let Some(url) = url {
        builder = builder.with_url(url);
    } else {
        builder = builder.with_url(format!("{}/", crate::PAGE_APP_ORIGIN));
    }
    if let Some(configuration) = shared {
        builder = builder.with_webview_configuration(configuration);
    }
    if let Some(port::Color(red, green, blue, alpha)) = background {
        builder = builder.with_background_color((red, green, blue, alpha));
    }
    let view = builder
        .build_as_child(&parent)
        .map_err(|error| format!("webview {label}: {error}"))?;
    let view = Box::into_raw(Box::new(view));
    if !focused {
        focus_webview(view);
    }
    Ok(view)
}

// The window notifications of the port.

/// The listeners of the window events of each window, by the address of its NSWindow.
static LISTENERS: std::sync::OnceLock<
    std::sync::Mutex<
        std::collections::HashMap<usize, Vec<Box<dyn Fn(&WindowEvent) + Send + Sync>>>,
    >,
> = std::sync::OnceLock::new();

/// The windows whose notifications a block of this adapter already observes.
static OBSERVED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<usize>>> =
    std::sync::OnceLock::new();

/// Observes the resize, move, key and close notifications of the window and reports them as port events. The
/// observations live as long as the window; a listener that ends leaves its calls unused.
pub(crate) fn observe_window(
    window: *mut c_void,
    listener: Box<dyn Fn(&WindowEvent) + Send + Sync>,
) {
    let key = window as usize;
    LISTENERS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(key)
        .or_default()
        .push(listener);
    let mut observed = OBSERVED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !observed.insert(key) {
        return;
    }
    unsafe {
        let center = objc2_foundation::NSNotificationCenter::defaultCenter();
        for (name, event) in [
            (
                objc2_app_kit::NSWindowDidResizeNotification,
                WindowEvent::Resized,
            ),
            (
                objc2_app_kit::NSWindowDidMoveNotification,
                WindowEvent::Moved,
            ),
            (
                objc2_app_kit::NSWindowDidBecomeKeyNotification,
                WindowEvent::Focused(true),
            ),
            (
                objc2_app_kit::NSWindowDidResignKeyNotification,
                WindowEvent::Focused(false),
            ),
            (
                objc2_app_kit::NSWindowWillCloseNotification,
                WindowEvent::Destroyed,
            ),
        ] {
            let block = block2::RcBlock::new(
                move |note: std::ptr::NonNull<objc2_foundation::NSNotification>| {
                    let note = note.as_ptr();
                    let window: *mut c_void = msg_send![note, object];
                    fire(window as usize, &event);
                },
            );
            // default: the note names its window, so the observer needs no object and fire chooses the listeners.
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
            // default: the observer lives as long as the window, which outlives the listeners of its pages.
            std::mem::forget(block);
        }
    }
}

/// Reports event to every listener of the window with the address key.
fn fire(key: usize, event: &WindowEvent) {
    let listeners = LISTENERS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(listeners) = listeners.get(&key) else {
        return;
    };
    for listener in listeners {
        listener(event);
    }
}

// The deep links.

// The handler of the GURL Apple events, which holds the application of the host.
define_class!(
    #[unsafe(super(objc2_foundation::NSObject))]
    #[thread_kind = AnyThread]
    #[ivars = port::AppHandle]
    struct LinkHandler;

    impl LinkHandler {
        #[unsafe(method(handleGURL:withReplyEvent:))]
        fn handle_gurl(
            &self,
            event: &objc2_foundation::NSAppleEventDescriptor,
            _reply: *mut objc2::runtime::AnyObject,
        ) {
            let url = event
                .descriptorForKeyword(0x4755_524c /* GURL */)
                .and_then(|descriptor| descriptor.stringValue().map(|text| text.to_string()));
            if let Some(url) = url {
                soksak_host::deep_link::open(self.ivars(), url);
            }
        }
    }
);

/// The handler of the GURL Apple events of the process, which the adapter installs once.
static LINK_HANDLER: std::sync::OnceLock<Retained<LinkHandler>> = std::sync::OnceLock::new();

/// Registers the Apple event handler of the GURL deep links, which the system sends for the link that launched the
/// application and for every link that arrives while it runs.
pub(crate) fn register_deep_links(app: port::AppHandle) {
    let handler = LINK_HANDLER.get_or_init(|| {
        let allocated = LinkHandler::alloc().set_ivars(app.clone());
        // default: the init of NSObject is the designated initializer of the handler.
        unsafe { objc2::msg_send![super(allocated), init] }
    });
    unsafe {
        let manager = objc2_foundation::NSAppleEventManager::sharedAppleEventManager();
        manager.setEventHandler_andSelector_forEventClass_andEventID(
            handler,
            objc2::sel!(handleGURL:withReplyEvent:),
            0x4755_524c, /* GURL, the event class of an Internet address */
            0x4755_524c, /* GURL, the event id of an open request */
        );
    }
}

// The panels and the directories.

/// Shows the folder panel attached to the window and returns the chosen path.
pub(crate) fn choose_folder(
    window: *mut c_void,
    title: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let mtm = MainThreadMarker::new().ok_or("the panel runs on the main thread")?;
    let panel = objc2_app_kit::NSOpenPanel::openPanel(mtm);
    panel.setTitle(Some(&*NSString::from_str(title)));
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setCanCreateDirectories(true);
    if ns_window(window).isVisible() {
        // default: a panel that its window cannot take runs by itself, which the modal answer of runModal holds.
        // The panel is an NSWindow subclass, so the upcast is always valid.
        let sheet: Retained<NSWindow> = unsafe { Retained::cast_unchecked(panel.clone()) };
        ns_window(window).beginSheet_completionHandler(&sheet, None);
    }
    let answer = panel.runModal();
    if answer != objc2_app_kit::NSModalResponseOK {
        return Ok(None);
    }
    Ok(panel.URLs().iter().next().map(|url| {
        std::path::PathBuf::from(url.path().map(|path| path.to_string()).unwrap_or_default())
    }))
}

/// Shows the save panel attached to the window and returns the chosen path.
pub(crate) fn save_file(
    window: *mut c_void,
    name: &str,
    directory: Option<std::path::PathBuf>,
) -> Result<Option<std::path::PathBuf>, String> {
    let mtm = MainThreadMarker::new().ok_or("the panel runs on the main thread")?;
    let panel = objc2_app_kit::NSSavePanel::savePanel(mtm);
    panel.setNameFieldStringValue(&NSString::from_str(name));
    if let Some(directory) = directory {
        let url = objc2_foundation::NSURL::fileURLWithPath(&NSString::from_str(
            directory.to_string_lossy().as_ref(),
        ));
        panel.setDirectoryURL(Some(&url));
    }
    if ns_window(window).isVisible() {
        // default: a panel that its window cannot take runs by itself, which the modal answer of runModal holds.
        // The panel is an NSWindow subclass, so the upcast is always valid.
        let sheet: Retained<NSWindow> = unsafe { Retained::cast_unchecked(panel.clone()) };
        ns_window(window).beginSheet_completionHandler(&sheet, None);
    }
    if panel.runModal() != objc2_app_kit::NSModalResponseOK {
        return Ok(None);
    }
    Ok(panel.URL().map(|url| {
        std::path::PathBuf::from(url.path().map(|path| path.to_string()).unwrap_or_default())
    }))
}

/// The user configuration directory of the operating system.
pub(crate) fn config_dir() -> Result<std::path::PathBuf, String> {
    let home = home_dir()?;
    Ok(home.join("Library").join("Application Support"))
}

/// The home directory of the user.
pub(crate) fn home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "the home directory of the user is not set".to_string())
}
