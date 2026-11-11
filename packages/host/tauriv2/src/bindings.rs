//! The Tauri commands that the page calls, and the command registration.
//!
//! Each command calls a function of the module of its role. The command names and the argument names must match the
//! calls of the page runtime (`apps/tauriv2/runtime/index.js`).

use std::ops::Deref;
use std::sync::{Arc, PoisonError};

use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use soksak_host::framework::{self as port, Manager};
use tauri::Manager as _;
use tauri::ipc::{CommandArg, CommandItem, Invoke, InvokeError};

use crate::frontend::Frontend;

use soksak_host::clipboard;
use soksak_host::composition;
use soksak_host::documents;
use soksak_host::exposure::{self, Changed, Forward, Register};
use soksak_host::images;
use soksak_host::link;
use soksak_host::menu;
use soksak_host::modals::{self, OverlayRequest, PlaceRequest, RevisedContent, UpdateRequest};
use soksak_host::projects::{self, CreateProject, Folder};
use soksak_host::shapes::{self, ShapeRequest};
use soksak_host::sidecars::WindowSidecars;
use soksak_host::surfaces::{
    self, CancelRequest, FocusRequest, Placement, PreparedSurfaces, PresentRequest, Rect,
    SyncRequest,
};
use soksak_host::theme::{self, Theme};
use soksak_host::windows::{self, Geometry, OpenProject, ProjectShown};
use soksak_host::workspace;

/// Defines the commands that the page calls and generates their registration. Every command takes a [`BindingCall`] as its
/// first argument and finishes it with its result, so each call is the event `host.binding.call`
/// (docs/spec/logging.md#entrances). The registration `handler` lists the commands defined here and no other, so a command
/// is registered only through this macro. A command returns a `Result`, and its arguments are the parameters that the page
/// sends by name.
macro_rules! bindings {
    (@commands [$($registered:ident,)*]) => {
        /// Returns the handler that registers every command.
        pub(crate) fn handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($registered),*]
        }

        /// Returns the names of the commands of the table, as the snake case names of their functions. The checks of the table use it.
        #[cfg(test)]
        pub(crate) fn command_names() -> &'static [&'static str] {
            &[$(stringify!($registered)),*]
        }
    };
    (@commands [$($registered:ident,)*]
        $(#[$meta:meta])* async fn $name:ident($($param:ident: $ty:ty),* $(,)?) -> $ret:ty $body:block
        $($rest:tt)*
    ) => {
        $(#[$meta])*
        async fn $name(call: BindingCall, $($param: $ty),*) -> $ret {
            async fn run($($param: $ty),*) -> $ret $body
            let result = run($($param),*).await;
            call.finish(&[$(stringify!($param)),*], &result);
            result
        }
        bindings!(@commands [$($registered,)* $name,] $($rest)*);
    };
    (@commands [$($registered:ident,)*]
        $(#[$meta:meta])* fn $name:ident($($param:ident: $ty:ty),* $(,)?) -> $ret:ty $body:block
        $($rest:tt)*
    ) => {
        $(#[$meta])*
        fn $name(call: BindingCall, $($param: $ty),*) -> $ret {
            fn run($($param: $ty),*) -> $ret $body
            let result = run($($param),*);
            call.finish(&[$(stringify!($param)),*], &result);
            result
        }
        bindings!(@commands [$($registered,)* $name,] $($rest)*);
    };
    (@commands [$($registered:ident,)*] $item:item $($rest:tt)*) => {
        $item
        bindings!(@commands [$($registered,)*] $($rest)*);
    };
    ($($all:tt)*) => {
        bindings!(@commands [] $($all)*);
    };
}

bindings! {
/// Resolves the path as a project directory and returns the canonical path and the identifier.
#[tauri::command]
async fn project_folder(app: AppHandle, root: Argument<String>) -> Result<Folder, String> {
    let Argument(root) = root;
    blocking(move || {
        projects::project_folder(&app, root)
    })
    .await
}

/// Opens a project in a window.
#[tauri::command]
async fn project_open(
    window: Window,
    request: Argument<OpenProject>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        windows::project_open(&window, request)
    })
    .await
}

/// Commits the project after the page has selected it and loaded its project-data context.
#[tauri::command]
async fn project_shown(
    window: Window,
    request: Argument<ProjectShown>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        windows::project_shown(&window, request)
    })
    .await
}

/// Runs the body of an async command on the blocking threads of the async runtime. Tauri runs an async command as a task of
/// its runtime, which has few workers; a body that waits there for a page reply, a lock or the main thread
/// holds a worker, so a few waiting commands would stop every other command and reply until their waits end.
async fn blocking<T: Send + 'static>(
    body: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(body)
        .await
        .map_err(|e| e.to_string())?
}

/// Releases the link between a project and a window.
#[tauri::command]
fn project_release(window: Window, id: Argument<String>) -> Result<(), String> {
    let Argument(id) = id;
    windows::project_release(&window, id)
}

/// Asks the window that shows the project whether the project may be removed.
#[tauri::command]
async fn project_remove_ask(window: Window, id: Argument<String>) -> Result<bool, String> {
    let Argument(id) = id;
    // The wait is for the person's answer.
    blocking(move || windows::project_remove_ask(&window, &id)).await
}

/// Answers the removal request that this window received.
#[tauri::command]
fn project_remove_answer(window: Window, answer: Argument<RemovalAnswer>) -> Result<(), String> {
    let Argument(answer) = answer;
    windows::project_remove_answer(&window, &answer.id, answer.allowed)
}

/// The answer of a window to a removal request.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RemovalAnswer {
    id: String,
    allowed: bool,
}

/// Turns the performance trace on or off and relays the page lines (V5-104).
#[tauri::command]
async fn performance(
    request: Argument<serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::performance::command(serde_json::Value::Object(request))
    })
    .await
}

/// Relays a batch of page events to the event writer of the host (docs/spec/logging.md#writers) and shows the page records of
/// the batch in the transcript of the window. It stores the line of a `transcript` request and shows it whole in the transcript, and
/// it answers a `clock` request with the clocks of the host and a `policy-read` request with `{classes}` of the policy in force.
#[tauri::command]
async fn log(
    window: Window,
    request: Argument<serde_json::Map<String, serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        let reply = soksak_host::event_relay::log_command(
            &window.state::<std::sync::Arc<soksak_host::event_log::EventLog>>(),
            serde_json::Value::Object(request),
        )?;
        for line in reply.lines {
            exposure::log(&window, &line);
        }
        if let Some(classes) = reply.classes {
            return Ok(serde_json::json!({ "classes": classes }));
        }
        serde_json::to_value(reply.clock).map_err(|error| error.to_string())
    })
    .await
}

/// Returns the position and size of a window.
#[tauri::command]
fn window_state(window: Window) -> Result<Option<Geometry>, String> {
    windows::window_state(&window)
}

/// Records that the page is ready to handle a window close request.
#[tauri::command]
fn window_ready(window: Window) -> Result<(), String> {
    windows::window_ready(&window)
}

/// Closes a window.
#[tauri::command]
fn window_close(window: Window) -> Result<(), String> {
    windows::window_close(&window)
}

/// Records that the page kept a modified tab when the window was asked to close.
#[tauri::command]
fn window_close_kept(window: Window) -> Result<(), String> {
    windows::window_close_kept(&window)
}

/// Opens a new project window.
#[tauri::command]
async fn window_new(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        windows::window_new(app.0)
    })
    .await
}

/// Runs a request of the settings and project list store.
#[tauri::command]
async fn workspace(
    app: AppHandle,
    request: Argument<workspace::Request>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        workspace::handle(&app, request)
    })
    .await
}

/// Opens the project folder selection dialog.
#[tauri::command]
async fn folder_choose(window: Window) -> Result<Option<String>, String> {
    blocking(move || {
        projects::folder_choose(&window)
    })
    .await
}

/// Creates a project folder.
#[tauri::command]
async fn project_create(app: AppHandle, request: Argument<CreateProject>) -> Result<Folder, String> {
    let Argument(request) = request;
    blocking(move || {
        projects::project_create(&app, request)
    })
    .await
}

/// Fits the child webview of a window to the surface that the page declared.
#[tauri::command]
async fn sync_surfaces(
    window: Window,
    request: Argument<SyncRequest>,
) -> Result<PreparedSurfaces, String> {
    let Argument(request) = request;
    blocking(move || {
        surfaces::sync(&window, request)
    })
    .await
}

/// Checks the presentation mark of a surface preparation that the DOM drew.
#[tauri::command]
async fn present_surfaces(
    window: Window,
    request: Argument<PresentRequest>,
) -> Result<Vec<Placement>, String> {
    let Argument(request) = request;
    surfaces::present(window.0, request).await
}

/// Gives the keyboard of the window to a surface or to the workbench.
#[tauri::command]
fn surface_focus(window: Window, request: Argument<FocusRequest>) -> Result<(), String> {
    let Argument(request) = request;
    surfaces::focus(&window, request)
}

/// Ends a preparation that the page does not present, so the windows that wait for its transaction continue.
#[tauri::command]
fn cancel_surfaces(window: Window, request: Argument<CancelRequest>) -> Result<(), String> {
    let Argument(request) = request;
    surfaces::cancel(&window, request)
}

/// Waits for the DOM and native raster presentation of the last stable frame. The page asks it without an endpoint
/// connection, so the close of the window, the end of its page process and the end of the generation of the page that asked
/// it end the wait besides its presentation.
#[tauri::command]
async fn wait_presented(window: Window) -> Result<f64, String> {
    blocking(move || exposure::page_presented(&window).map_err(|error| error.message)).await
}

/// Draws a modal element in a webview inside the main window.
#[tauri::command]
fn overlay_show(window: Window, request: Argument<OverlayRequest>) -> Result<Rect, String> {
    let Argument(request) = request;
    modals::show(&window, request)
}

/// Moves the webview of an open modal.
#[tauri::command]
fn overlay_place(window: Window, request: Argument<PlaceRequest>) -> Result<Rect, String> {
    let Argument(request) = request;
    modals::place(&window, request)
}

/// Draws or updates a shape.
#[tauri::command]
fn set_shape(window: Window, request: Argument<ShapeRequest>) -> Result<(), String> {
    let Argument(request) = request;
    shapes::set(&window, request)
}

/// Removes a shape.
#[tauri::command]
fn clear_shape(window: Window, id: Argument<String>) -> Result<(), String> {
    let Argument(id) = id;
    shapes::clear(&window, id)
}

/// Returns the content that a modal document draws. It does not need the main thread.
#[tauri::command]
async fn overlay_content(
    window: Window,
    id: Argument<String>,
    instance: Argument<u64>,
) -> Result<RevisedContent, String> {
    let Argument(id) = id;
    let Argument(instance) = instance;
    blocking(move || {
        modals::content(&window, id, instance)
    })
    .await
}

/// Replaces the content of an open modal.
#[tauri::command]
fn overlay_update(window: Window, request: Argument<UpdateRequest>) -> Result<(), String> {
    let Argument(request) = request;
    modals::update(&window, request)
}

/// Receives the render completion of a modal document and shows the modal webview.
#[tauri::command]
fn overlay_ready(
    window: Window,
    id: Argument<String>,
    instance: Argument<u64>,
) -> Result<(), String> {
    let Argument(id) = id;
    let Argument(instance) = instance;
    modals::ready(&window, id, instance)
}

/// Closes a modal.
#[tauri::command]
fn overlay_hide(window: Window, id: Argument<String>) -> Result<(), String> {
    let Argument(id) = id;
    modals::hide(&window, id)
}

/// Passes the choice of a modal document to the page.
#[tauri::command]
fn overlay_pick(
    window: Window,
    id: Argument<String>,
    instance: Argument<u64>,
    key: Argument<String>,
    value: Argument<String>,
) -> Result<(), String> {
    let Argument(id) = id;
    let Argument(instance) = instance;
    let Argument(key) = key;
    let Argument(value) = value;
    modals::pick(&window, id, instance, key, value)
}

/// Returns the area that the window buttons occupy.
#[tauri::command]
fn window_controls(window: Window) -> Result<windows::Chrome, String> {
    windows::window_chrome(&window)
}

/// Passes a message that a surface page sent to the sidecar.
#[tauri::command]
fn sidecar_send(
    window: Window,
    sidecar: Argument<String>,
    surface: Argument<String>,
    body: Argument<Box<RawValue>>,
    cids: Argument<Vec<String>>,
) -> Result<(), String> {
    let Argument(sidecar) = sidecar;
    let Argument(surface) = surface;
    let Argument(body) = body;
    let Argument(cids) = cids;
    soksak_host::windows::window_data(&window)?
        .images
        .pending_detach_error(&surface)?;
    let data = soksak_host::windows::window_data(&window)?;
    documents::window_sidecar_send(&data, &window.state::<WindowSidecars>(), &window, &sidecar, &surface, &body, &cids)
}

/// The surface list that every project layout holds.
#[derive(serde::Deserialize)]
struct RetainRequest {
    surfaces: Vec<soksak_host::sidecars::RetainedSurface>,
}

/// The outdated persistent services (docs/spec/installation.md).
#[tauri::command]
async fn sidecars_outdated(window: Window) -> Result<Vec<soksak_host::sidecars::OutdatedSidecar>, String> {
    blocking(move || {
        Ok(window.state::<WindowSidecars>().outdated())
    })
    .await
}

#[derive(serde::Deserialize)]
struct ReplaceRequest {
    sidecar: String,
}

/// Replaces the outdated persistent service of a sidecar (docs/spec/persistent-services.md#updates). The call waits
/// for the service, so it is an async command.
#[tauri::command]
async fn sidecars_replace(window: Window, request: Argument<ReplaceRequest>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        window.state::<WindowSidecars>().replace(&request.sidecar)
    })
    .await
}

/// Closes the sessions of the surfaces that no layout holds in the persistent sidecar service and returns the number
/// closed (docs/spec/persistent-services.md). It waits for the service, so it is an async command.
#[tauri::command]
async fn sidecars_retain(
    window: Window,
    request: Argument<RetainRequest>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        let closed = window
            .state::<WindowSidecars>()
            .retain_sessions(&request.surfaces)?;
        Ok(serde_json::json!({ "closed": closed }))
    })
    .await
}

/// Returns the current theme.
#[tauri::command]
fn theme(window: Window) -> Result<Theme, String> {
    theme::get(&window)
}

/// Records the current theme of a page and passes it to the other pages.
#[tauri::command]
fn set_theme(window: Window, theme: Argument<Theme>) -> Result<(), String> {
    let Argument(theme) = theme;
    theme::set(&window, theme)
}

/// The page reports the effective menu language. A language that is not in the table is an explicit error, and the same
/// language does not rebuild the menu (Application menu in docs/spec/host-contract.md).
#[tauri::command]
fn set_menu_language(app: AppHandle, language: Argument<String>) -> Result<(), String> {
    let Argument(language) = language;
    menu::set_language(&app, &language)
}

/// Receives the reply of a document to a request that the host sent.
#[tauri::command]
fn exposure_reply(webview: Webview, request: Argument<String>) -> Result<(), String> {
    let Argument(request) = request;
    exposure::reply(&webview, request)
}

/// Sends a state change that the main page sent to the connections that watch it.
#[tauri::command]
fn exposure_changed(webview: Webview, request: Argument<Changed>) -> Result<(), String> {
    let Argument(request) = request;
    exposure::changed(&webview, request)
}

/// Sends a request of the main page to a surface page and returns the reply.
#[tauri::command]
async fn exposure_forward(
    webview: Webview,
    request: Argument<Forward>,
) -> Result<Box<serde_json::value::RawValue>, String> {
    let Argument(request) = request;
    blocking(move || {
        exposure::forward(&webview, request)
    })
    .await
}

/// Passes the item registration of a surface page to the main page.
#[tauri::command]
fn exposure_register(webview: Webview, request: Argument<Register>) -> Result<(), String> {
    let Argument(request) = request;
    exposure::register(&webview, request)
}

/// Attaches a document region to an element of the calling surface page.
#[tauri::command]
async fn document_attach(webview: Webview, request: Argument<documents::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::attach(&webview, request)
    })
    .await
}

/// Registers the immutable composition declaration of the surface before the native placement.
#[tauri::command]
async fn composition_declare(
    webview: Webview,
    request: Argument<surfaces::CompositionDeclareRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        surfaces::declare(&webview, request)
    })
    .await
}

/// Places the complete composition revision of the calling surface page.
#[tauri::command]
async fn composition_place(
    webview: Webview,
    request: Argument<composition::CompositionPlaceRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        composition::place(&webview, request)
    })
    .await
}

/// Opens an http or https address in a document region.
#[tauri::command]
async fn document_load(webview: Webview, request: Argument<documents::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::load(&webview, request)
    })
    .await
}

/// Sends a JSON message to the plugin document of a region (docs/spec/native-surfaces.md#document-regions).
#[tauri::command]
async fn document_post(webview: Webview, request: Argument<documents::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::post(&webview, request)
    })
    .await
}

/// Posts a command request of the main page to the view of the request (docs/spec/native-surfaces.md#view-surfaces).
#[tauri::command]
async fn view_request(webview: Webview, request: Argument<documents::ViewRequest>) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        documents::view_request(&webview, request)
    })
    .await
}

/// Pushes an event of a subscription of a view to the view (docs/spec/native-surfaces.md#view-surfaces).
#[tauri::command]
async fn view_event(webview: Webview, request: Argument<documents::ViewEventRequest>) -> Result<bool, String> {
    let Argument(request) = request;
    blocking(move || {
        documents::view_event(&webview, request)
    })
    .await
}

/// Sets whether the main page receives the messages of a pair of a sidecar and a session id
/// (docs/spec/native-surfaces.md#view-surfaces).
#[tauri::command]
async fn sidecar_listen(
    webview: Webview,
    request: Argument<soksak_host::sidecar_routes::SidecarListenRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        let window = webview.window();
        soksak_host::exposure::authorize_main_caller(webview.label(), window.label(), "sidecar listen")?;
        let request = request.check()?;
        soksak_host::windows::window_data(&window)?
            .sidecar_routes
            .listen(&request.sidecar, &request.id, request.on);
        Ok(())
    })
    .await
}

/// Adds or removes a view as a receiver of the messages of a pair of a sidecar and a session id
/// (docs/spec/native-surfaces.md#view-surfaces).
#[tauri::command]
async fn view_sidecar_route(
    webview: Webview,
    request: Argument<soksak_host::sidecar_routes::ViewSidecarRouteRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        let window = webview.window();
        soksak_host::exposure::authorize_main_caller(webview.label(), window.label(), "view sidecar route")?;
        let request = request.check()?;
        soksak_host::windows::window_data(&window)?.sidecar_routes.route_view(
            &request.surface,
            request.generation,
            &request.sidecar,
            &request.id,
            request.on,
        );
        Ok(())
    })
    .await
}

/// Sends for the original validated native-view incarnation, independently of background sends.
#[tauri::command]
async fn view_sidecar_send(
    webview: Webview,
    request: Argument<documents::ViewSidecarSendRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        let window = webview.window();
        soksak_host::exposure::authorize_main_caller(webview.label(), window.label(), "view sidecar send")?;
        let data = soksak_host::windows::window_data(&window)?;
        data.images.pending_detach_error(&request.surface)?;
        documents::view_sidecar_send(&data, &window.state::<WindowSidecars>(), &window, request)
    })
    .await
}

/// Receives the reply of the main page to a call request of a view (docs/spec/native-surfaces.md#view-surfaces).
#[tauri::command]
async fn view_reply(webview: Webview, request: Argument<documents::ViewReply>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::view_reply(&webview, request)
    })
    .await
}

/// Returns the current view-source incarnations and generation floor of the calling window.
#[tauri::command]
async fn view_source_origins(
    webview: Webview,
) -> Result<soksak_host::source_origins::ViewSourceOriginsSnapshot, String> {
    blocking(move || {
        let window = webview.window();
        soksak_host::exposure::authorize_main_caller(webview.label(), window.label(), "view source origins")?;
        let task_window = window.clone();
        soksak_host::exposure::on_main(&window, move || {
            Ok(soksak_host::windows::window_data(&task_window)?.view_source_origins.snapshot())
        })
    })
    .await
}

/// Registers the ordered main-page channel for source lifecycle and message events.
#[tauri::command]
async fn view_source_event_stream(
    webview: Webview,
    on_message: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    let on_message = port::Channel::<windows::ViewSourceEvent>::new(move |body| {
        on_message
            .send(match body {
                port::InvokeResponseBody::Json(text) => tauri::ipc::InvokeResponseBody::Json(text),
                port::InvokeResponseBody::Raw(bytes) => tauri::ipc::InvokeResponseBody::Raw(bytes),
            })
            .map_err(crate::framework::error)
    });
    blocking(move || {
        windows::register_view_source_event_stream(&webview, on_message)
    })
    .await
}

/// Sets the page zoom of a document region as the text scale.
#[tauri::command]
async fn document_zoom(webview: Webview, request: Argument<documents::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::zoom(&webview, request)
    })
    .await
}

/// Runs history navigation, reload and stop of a document region.
#[tauri::command]
async fn document_go(webview: Webview, request: Argument<documents::Request>) -> Result<bool, String> {
    let Argument(request) = request;
    blocking(move || {
        documents::go(&webview, request)
    })
    .await
}

/// Answers the media, capture and form state of a document region (docs/spec/plugins.md#memory-saver).
#[tauri::command]
async fn document_query(webview: Webview, request: Argument<documents::Request>) -> Result<documents::Report, String> {
    let Argument(request) = request;
    blocking(move || {
        documents::query(&webview, request)
    })
    .await
}

/// Returns the interactionState of a document region as base64.
#[tauri::command]
async fn document_interaction_state(webview: Webview, request: Argument<documents::Request>) -> Result<String, String> {
    let Argument(request) = request;
    blocking(move || {
        documents::interaction_state(&webview, request)
    })
    .await
}

/// Closes a document region.
#[tauri::command]
async fn document_detach(webview: Webview, request: Argument<documents::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::detach(&webview, request)
    })
    .await
}

/// Subscribes to a stream of a document region of the calling surface page and returns the handle.
#[tauri::command]
async fn document_subscribe(webview: Webview, request: Argument<documents::Request>) -> Result<documents::Subscription, String> {
    let Argument(request) = request;
    blocking(move || {
        documents::subscribe(&webview, request)
    })
    .await
}

/// Ends a stream subscription of a document region of the calling surface page.
#[tauri::command]
async fn document_unsubscribe(webview: Webview, request: Argument<documents::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        documents::unsubscribe(&webview, request)
    })
    .await
}

/// Attaches an image region to an element of the calling surface page.
#[tauri::command]
async fn image_attach(webview: Webview, request: Argument<images::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        images::attach(&webview, request)
            .map_err(|error| images::image_call_error("imageAttach", error))
    })
    .await
}

/// Makes the image region the first responder and sends the focus event.
#[tauri::command]
async fn image_focus(webview: Webview, request: Argument<images::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        images::focus(&webview, request).map_err(|error| images::image_call_error("imageFocus", error))
    })
    .await
}

/// Stores the caret (text cursor) position.
#[tauri::command]
async fn image_caret(
    webview: Webview,
    request: Argument<images::Request>,
    x: Argument<f64>,
    y: Argument<f64>,
    w: Argument<f64>,
    h: Argument<f64>,
) -> Result<(), String> {
    let Argument(request) = request;
    let Argument(x) = x;
    let Argument(y) = y;
    let Argument(w) = w;
    let Argument(h) = h;
    blocking(move || {
        images::caret(&webview, request, x, y, w, h)
            .map_err(|error| images::image_call_error("imageCaret", error))
    })
    .await
}

/// Stores the string that is shown as the accessibility value.
#[tauri::command]
async fn image_text(
    webview: Webview,
    request: Argument<images::Request>,
    text: Argument<String>,
) -> Result<(), String> {
    let Argument(request) = request;
    let Argument(text) = text;
    blocking(move || {
        images::text(&webview, request, text)
            .map_err(|error| images::image_call_error("imageText", error))
    })
    .await
}

/// Closes an image region.
#[tauri::command]
async fn image_detach(webview: Webview, request: Argument<images::Request>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        images::detach(&webview, request)
            .map_err(|error| images::image_call_error("imageDetach", error))
    })
    .await
}

#[tauri::command]
async fn clipboard_read(
    window: Window,
    request: Argument<clipboard::ReadRequest>,
) -> Result<clipboard::ReadResponse, String> {
    let Argument(request) = request;
    blocking(move || {
        clipboard::read(&window, request)
    })
    .await
}

#[tauri::command]
async fn link_open(window: Window, request: Argument<link::OpenRequest>) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        link::open(&window, request)
    })
    .await
}

/// The version of the running core and the candidate of an application update.
#[tauri::command]
async fn app_update_state(window: Window) -> Result<soksak_sok::appupdate::AppUpdateState, String> {
    blocking(move || {
        let directory = window
            .state::<soksak_host::workspace::Workspace>()
            .directory()
            .to_path_buf();
        soksak_host::app_update::state(&directory)
    })
    .await
}

/// Downloads, checks and extracts the release of the candidate of an application update.
#[tauri::command]
async fn app_update_stage(
    window: Window,
    request: Argument<soksak_host::app_update::StageRequest>,
) -> Result<soksak_host::app_update::Staged, String> {
    let Argument(request) = request;
    blocking(move || {
        let directory = window
            .state::<soksak_host::workspace::Workspace>()
            .directory()
            .to_path_buf();
        soksak_host::app_update::stage_call(&directory, request)
    })
    .await
}

/// Prepares the replacement of the application bundle with a staged one and quits the application as host.quit does.
#[tauri::command]
async fn app_update_apply(
    window: Window,
    request: Argument<soksak_host::app_update::ApplyRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        let directory = window
            .state::<soksak_host::workspace::Workspace>()
            .directory()
            .to_path_buf();
        let command = soksak_host::app_update::apply_call(&directory, request)?;
        *window
            .state::<soksak_host::windows::Windows>()
            .update
            .lock()
            // default: a lock that a panicking thread poisoned still holds the pending update, which the call replaces; the
            // panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner) = Some(soksak_host::app_update::PendingStart {
            command,
            relaunch: false,
        });
        soksak_host::event_record::quit_with_cause(
            "update",
            soksak_host::event_record::host_quit_source("update"),
            || window.app_handle().quit(),
        );
        Ok(())
    })
    .await
}

/// The files of the logs folder (docs/spec/debug.md).
#[tauri::command]
async fn debug_files(window: Window) -> Result<Vec<soksak_host::debug::DebugFile>, String> {
    blocking(move || {
        let directory = window
            .state::<soksak_host::workspace::Workspace>()
            .directory()
            .to_path_buf();
        soksak_host::debug::list(&directory)
    })
    .await
}

/// Reads the end of one text file of the logs folder.
#[tauri::command]
async fn debug_read(
    window: Window,
    request: Argument<soksak_host::debug::SaveRequest>,
) -> Result<soksak_host::debug::ReadResult, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::debug::read_file(&window, request)
    })
    .await
}

/// Records the state of every window into the logs folder.
#[tauri::command]
async fn debug_record(
    window: Window,
    request: Argument<soksak_host::debug::RecordRequest>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::debug::record(window.app_handle(), request)
    })
    .await
}

/// Saves one file of the logs folder through the save panel.
#[tauri::command]
async fn debug_save(
    window: Window,
    request: Argument<soksak_host::debug::SaveRequest>,
) -> Result<soksak_host::debug::Saved, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::debug::save(&window, request)
    })
    .await
}

/// Answers one page of the query over the event files of the logs folder (docs/spec/debug.md#timeline).
#[tauri::command]
async fn log_query(
    window: Window,
    request: Argument<serde_json::Map<String, serde_json::Value>>,
) -> Result<soksak_sok::log_query::LogPage, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::debug::log_query(window.app_handle(), request)
    })
    .await
}

/// Saves text that the page built through the save panel.
#[tauri::command]
async fn debug_save_text(
    window: Window,
    request: Argument<soksak_host::debug::TextRequest>,
) -> Result<soksak_host::debug::Saved, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::debug::save_text(&window, request)
    })
    .await
}

/// Asks through the save panel of the window where to save a new document of its project.
#[tauri::command]
async fn file_place(
    window: Window,
    request: Argument<soksak_host::file_place::FilePlaceRequest>,
) -> Result<soksak_host::file_place::FilePlaced, String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::file_place::place(&window, request)
    })
    .await
}

/// Saves the logs folder as one gzip-compressed tar file through the save panel.
#[tauri::command]
async fn debug_save_all(window: Window) -> Result<soksak_host::debug::SaveAllStarted, String> {
    blocking(move || {
        soksak_host::debug::save_all(&window)
    })
    .await
}

/// Returns the registry address, the checked index and the installation state.
#[tauri::command]
async fn plugins_state(
    app: AppHandle,
) -> Result<soksak_sok::plugins::PluginsState, String> {
    blocking(move || {
        let plugins = app.state::<soksak_host::plugins::Plugins>();
        plugins.state()
    })
    .await
}

/// Runs a plugin action, the same as sok plugin <action> <plugin>.
#[tauri::command]
async fn plugins_run(
    app: AppHandle,
    request: Argument<soksak_host::plugins::RunRequest>,
) -> Result<soksak_sok::plugins::PluginActionResult, String> {
    let Argument(request) = request;
    blocking(move || {
        let plugins = app.state::<soksak_host::plugins::Plugins>();
        plugins.run(request)
    })
    .await
}

/// Sets the registry index, the same as sok registry use <index>.
#[tauri::command]
async fn plugins_use_registry(
    app: AppHandle,
    request: Argument<soksak_host::plugins::RegistryRequest>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        let plugins = app.state::<soksak_host::plugins::Plugins>();
        plugins.use_registry(request)
    })
    .await
}

/// Records or completes the durable starter installation job.
#[tauri::command]
async fn plugins_starter(
    app: AppHandle,
    request: Argument<soksak_host::plugins::StarterRequest>,
) -> Result<soksak_sok::plugins::StarterJob, String> {
    let Argument(request) = request;
    blocking(move || {
        let plugins = app.state::<soksak_host::plugins::Plugins>();
        plugins.set_starter(request)
    })
    .await
}

/// Posts the tab notification of the calling window as a system notification.
#[tauri::command]
async fn notify(
    window: Window,
    request: Argument<soksak_host::notifications::NotificationRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::notifications::notify(&window, request)
    })
    .await
}

/// Clears the tab notification of the calling window.
#[tauri::command]
async fn notification_remove(
    window: Window,
    request: Argument<soksak_host::notifications::NotificationRequest>,
) -> Result<(), String> {
    let Argument(request) = request;
    blocking(move || {
        soksak_host::notifications::remove(&window, request)
    })
    .await
}

/// Returns the permission state that the notification center reported last.
#[tauri::command]
async fn notification_state() -> Result<soksak_host::notifications::NotificationState, String> {
    blocking(move || {
        soksak_host::notifications::state()
    })
    .await
}

#[tauri::command]
async fn clipboard_write_text(window: Window, text: Argument<String>) -> Result<(), String> {
    let Argument(text) = text;
    blocking(move || {
        clipboard::write_text(&window, text)
    })
    .await
}

#[tauri::command]
async fn clipboard_read_view_png(
    window: Window,
    request: Argument<clipboard::ViewReadRequest>,
) -> Result<clipboard::ViewReadResponse, String> {
    let Argument(request) = request;
    blocking(move || {
        clipboard::read_view_png(&window, request)
    })
    .await
}

#[tauri::command]
async fn clipboard_persist_view_png(
    app: AppHandle,
    window: Window,
    request: Argument<clipboard::ViewPersistRequest>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        Ok(serde_json::json!({ "path": clipboard::persist_view_png(&app, &window, request)? }))
    })
    .await
}

#[tauri::command]
async fn clipboard_persist_png(
    app: AppHandle,
    request: Argument<clipboard::PersistRequest>,
) -> Result<serde_json::Value, String> {
    let Argument(request) = request;
    blocking(move || {
        Ok(serde_json::json!({ "path": clipboard::persist_png(&app, request.data)? }))
    })
    .await
}
}

/// The host library application that the commands reach: the application that run gave Tauri as its state.
fn host_application<R: tauri::Runtime>(
    command: &CommandItem<'_, R>,
) -> Result<port::AppHandle, InvokeError> {
    command
        .message
        .webview()
        .try_state::<port::AppHandle>()
        .map(|app| app.inner().clone())
        .ok_or_else(|| InvokeError::from("the host application is not managed"))
}

/// The body of a command as the body of the host library.
fn payload<'a, R: tauri::Runtime>(command: &CommandItem<'a, R>) -> port::InvokeBody<'a> {
    match command.message.payload() {
        tauri::ipc::InvokeBody::Json(value) => port::InvokeBody::Json(value),
        tauri::ipc::InvokeBody::Raw(bytes) => port::InvokeBody::Raw(bytes),
    }
}

/// The host library application as a command argument.
struct AppHandle(port::AppHandle);

impl Deref for AppHandle {
    type Target = port::AppHandle;
    fn deref(&self) -> &port::AppHandle {
        &self.0
    }
}

impl<'a, R: tauri::Runtime> CommandArg<'a, R> for AppHandle {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        host_application(&command).map(AppHandle)
    }
}

/// The window of the calling web view as a command argument.
struct Window(port::Window);

impl Deref for Window {
    type Target = port::Window;
    fn deref(&self) -> &port::Window {
        &self.0
    }
}

impl<'a> CommandArg<'a, tauri::Wry> for Window {
    fn from_command(command: CommandItem<'a, tauri::Wry>) -> Result<Self, InvokeError> {
        let app = host_application(&command)?;
        let window = command.message.webview().window();
        Ok(Window(app.window_of(Arc::new(Frontend::new(window)))))
    }
}

/// The calling web view as a command argument.
struct Webview(port::Webview);

impl Deref for Webview {
    type Target = port::Webview;
    fn deref(&self) -> &port::Webview {
        &self.0
    }
}

impl<'a> CommandArg<'a, tauri::Wry> for Webview {
    fn from_command(command: CommandItem<'a, tauri::Wry>) -> Result<Self, InvokeError> {
        let app = host_application(&command)?;
        let webview = command.message.webview();
        Ok(Webview(app.webview_of(
            Arc::new(Frontend::new(webview.window())),
            webview.label(),
        )))
    }
}

/// One command argument, which the host library decodes.
struct Argument<T>(T);

impl<'a, R: tauri::Runtime, T: DeserializeOwned> CommandArg<'a, R> for Argument<T> {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        soksak_host::arguments::Argument::from_body(command.name, command.key, &payload(&command))
            .map(|soksak_host::arguments::Argument(value)| Argument(value))
            .map_err(InvokeError::from)
    }
}

/// The record of the command being handled as a command argument.
struct BindingCall(soksak_host::binding_record::BindingCall);

impl BindingCall {
    fn finish<T, E: std::fmt::Display>(self, names: &[&str], result: &Result<T, E>) {
        self.0.finish(names, result)
    }
}

impl<'a, R: tauri::Runtime> CommandArg<'a, R> for BindingCall {
    fn from_command(command: CommandItem<'a, R>) -> Result<Self, InvokeError> {
        soksak_host::binding_record::BindingCall::from_command(
            command.name,
            command.message.webview().window().label(),
            &payload(&command),
        )
        .map(BindingCall)
        .map_err(InvokeError::from)
    }
}

#[cfg(test)]
#[path = "../tests/view_source_stream/bindings_test.rs"]
mod view_source_stream_tests;

#[cfg(test)]
#[path = "../tests/project_data_order/bindings_test.rs"]
mod project_data_order_tests;

#[cfg(test)]
#[path = "../tests/surface_layout/bindings_test.rs"]
mod surface_layout_tests;

#[cfg(test)]
#[path = "plugins_starter_test.rs"]
mod plugins_starter_tests;
