//! The calls that the page makes, routed by name to the functions of the library.
//!
//! The bootstrap script of the adapter sends each call as `{epoch, id, method, args}` over the ipc entry of wry,
//! and [`route`] answers it with `__soksak.receive({epoch, id, result | error})` in the calling web view. The
//! method names and the argument names match the calls of the page runtime (`apps/gpuikit/runtime/index.js`).

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use soksak_host::binding_record::BindingCall;
use soksak_host::framework::{self as port, AppHandle, InvokeBody, Manager};

use soksak_host::clipboard;
use soksak_host::composition;
use soksak_host::documents;
use soksak_host::exposure::{self, Changed, Forward, Register};
use soksak_host::images;
use soksak_host::link;
use soksak_host::menu;
use soksak_host::modals::{self, OverlayRequest, PlaceRequest, UpdateRequest};
use soksak_host::projects::{self, CreateProject};
use soksak_host::shapes::{self, ShapeRequest};
use soksak_host::sidecars::WindowSidecars;
use soksak_host::surfaces::{self, CancelRequest, FocusRequest, PresentRequest, SyncRequest};
use soksak_host::theme::{self, Theme};
use soksak_host::windows::{self, OpenProject, ProjectShown};
use soksak_host::workspace;

use crate::frontend;

/// One call of the page as the bootstrap script sends it.
#[derive(serde::Deserialize)]
struct Wire {
    epoch: String,
    id: u64,
    method: String,
    #[serde(default)]
    args: Value,
}

/// The reply identity of one call, which its answer carries back to the page.
#[derive(Clone)]
struct Reply {
    epoch: String,
    id: u64,
}

impl Reply {
    /// The message of the reply for result.
    fn message(&self, result: &Result<Value, String>) -> Value {
        match result {
            Ok(value) => json!({ "epoch": self.epoch, "id": self.id, "result": value }),
            Err(error) => json!({ "epoch": self.epoch, "id": self.id, "error": error }),
        }
    }
}

/// Routes one ipc message of the web view with label to the call that it names.
pub(crate) fn route(app: &AppHandle, label: &str, body: String) {
    let app = app.clone();
    let label = label.to_string();
    soksak_host::routine::spawn_named("page-call", move || {
        if let Err(error) = answer(&app, &label, &body) {
            // A message that is no call of the page reports its failure to the page and to the log.
            soksak_host::application_log::log_error("page call", error.clone());
            frontend::deliver(
                &label,
                format!(
                    "window.__soksak && window.__soksak.receive({})",
                    json!({ "error": error })
                ),
            );
        }
    });
}

/// Answers one call of the page.
fn answer(app: &AppHandle, label: &str, body: &str) -> Result<(), String> {
    let wire: Wire = serde_json::from_str(body).map_err(|error| format!("page call: {error}"))?;
    let reply = Reply {
        epoch: wire.epoch.clone(),
        id: wire.id,
    };
    let Some((window, webview)) = frontend::context(app, label) else {
        return Err(format!("webview {label} is not open"));
    };
    let body = InvokeBody::Json(&wire.args);
    let call = BindingCall::from_command(&wire.method, window.label(), &body)?;
    // The presentation of a preparation waits for the notice of the page, so it answers from its own future.
    if wire.method == "present_surfaces" {
        let result = argument::<PresentRequest>(&wire.method, "request", &body)
            .map(|request| (request, window.clone()));
        match result {
            Ok((request, window)) => {
                let page = label.to_string();
                crate::runtime().spawn(async move {
                    let result = surfaces::present(window, request)
                        .await
                        .map(|placed| json!(placed));
                    call.finish(&["request"], &result);
                    deliver_reply(&reply, &page, &result);
                });
                return Ok(());
            }
            Err(error) => {
                call.finish(&["request"], &Err::<Value, String>(error.clone()));
                deliver_reply(&reply, label, &Err(error));
                return Ok(());
            }
        }
    }
    // An account run lasts until its program ends, as a program run does.
    if wire.method == "account_run" {
        let result =
            argument::<soksak_host::program_run::AccountRunCall>(&wire.method, "request", &body)
                .map(|request| (request, window.clone()));
        match result {
            Ok((request, window)) => {
                let page = label.to_string();
                crate::runtime().spawn_blocking(move || {
                    let result = run_account(&window, request);
                    call.finish(&["request"], &result);
                    deliver_reply(&reply, &page, &result);
                });
                return Ok(());
            }
            Err(error) => {
                call.finish(&["request"], &Err::<Value, String>(error.clone()));
                deliver_reply(&reply, label, &Err(error));
                return Ok(());
            }
        }
    }
    // A program run lasts until its program ends, so it runs on the blocking pool and the dispatcher stays free for its cancel.
    if wire.method == "program_run" {
        let result = argument::<soksak_host::program_run::RunCall>(&wire.method, "request", &body)
            .map(|request| (request, window.clone()));
        match result {
            Ok((request, window)) => {
                let page = label.to_string();
                crate::runtime().spawn_blocking(move || {
                    let result = run_program(&window, request);
                    call.finish(&["request"], &result);
                    deliver_reply(&reply, &page, &result);
                });
                return Ok(());
            }
            Err(error) => {
                call.finish(&["request"], &Err::<Value, String>(error.clone()));
                deliver_reply(&reply, label, &Err(error));
                return Ok(());
            }
        }
    }
    let result = dispatch(app, &window, &webview, &wire.method, &body);
    call.finish(&[], &result);
    deliver_reply(&reply, label, &result);
    Ok(())
}

/// Runs the declared program of a view call with the environment of the sidecars of the window, and answers its reply.
fn run_program(
    window: &port::Window,
    request: soksak_host::program_run::RunCall,
) -> Result<Value, String> {
    let data = soksak_host::windows::window_data(window)?;
    let sidecars = window.state::<WindowSidecars>();
    let environment = sidecars.program_environment()?;
    documents::program_run(&data, environment, &sidecars.config_directory(), request)
        .map(|reply| json!(reply))
}

/// Runs an account program of a plugin with the environment of the sidecars of the window, and answers its reply.
fn run_account(
    window: &port::Window,
    request: soksak_host::program_run::AccountRunCall,
) -> Result<Value, String> {
    let data = soksak_host::windows::window_data(window)?;
    let sidecars = window.state::<WindowSidecars>();
    let environment = sidecars.program_environment()?;
    documents::account_run(&data, environment, &sidecars.config_directory(), request)
        .map(|reply| json!(reply))
}

/// Delivers the reply of a call to its page.
fn deliver_reply(reply: &Reply, label: &str, result: &Result<Value, String>) {
    frontend::deliver(
        label,
        format!(
            "window.__soksak && window.__soksak.receive({})",
            reply.message(result)
        ),
    );
}

/// One argument of the call that dispatch answers.
fn argument<T: DeserializeOwned>(method: &str, key: &str, body: &InvokeBody) -> Result<T, String> {
    let value = soksak_host::arguments::Argument::<T>::from_body(method, key, body)?;
    Ok(value.0)
}

/// Runs one call of the page by its method name.
fn dispatch(
    app: &AppHandle,
    window: &port::Window,
    webview: &port::Webview,
    method: &str,
    body: &InvokeBody,
) -> Result<Value, String> {
    let value = match method {
        "project_folder" => {
            let root: String = argument(method, "root", body)?;
            json!(projects::project_folder(app, root)?)
        }
        "project_open" => {
            let request: OpenProject = argument(method, "request", body)?;
            windows::project_open(window, request)?
        }
        "project_shown" => {
            let request: ProjectShown = argument(method, "request", body)?;
            windows::project_shown(window, request)?;
            Value::Null
        }
        "project_release" => {
            let id: String = argument(method, "id", body)?;
            windows::project_release(window, id)?;
            Value::Null
        }
        "project_activity" => {
            let request: soksak_host::project_activity::ProjectActivityRequest =
                argument(method, "request", body)?;
            windows::project_activity(window, request)?;
            Value::Null
        }
        "project_remove_ask" => {
            let id: String = argument(method, "id", body)?;
            json!(windows::project_remove_ask(window, &id)?)
        }
        "project_remove_answer" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct RemovalAnswer {
                id: String,
                allowed: bool,
            }
            let answer: RemovalAnswer = argument(method, "answer", body)?;
            windows::project_remove_answer(window, &answer.id, answer.allowed)?;
            Value::Null
        }
        "performance" => {
            let request: serde_json::Map<String, Value> = argument(method, "request", body)?;
            soksak_host::performance::command(Value::Object(request))?
        }
        "log" => {
            let request: serde_json::Map<String, Value> = argument(method, "request", body)?;
            let reply = soksak_host::event_relay::log_command(
                &window.state::<Arc<soksak_host::event_log::EventLog>>(),
                Value::Object(request),
            )?;
            for line in reply.lines {
                exposure::log(window, &line);
            }
            if let Some(classes) = reply.classes {
                json!({ "classes": classes })
            } else {
                serde_json::to_value(reply.clock).map_err(|error| error.to_string())?
            }
        }
        "window_state" => json!(windows::window_state(window)?),
        "window_ready" => {
            windows::window_ready(window)?;
            Value::Null
        }
        "window_close" => {
            windows::window_close(window)?;
            Value::Null
        }
        "window_close_kept" => {
            windows::window_close_kept(window)?;
            Value::Null
        }
        "window_new" => {
            windows::window_new(app.clone())?;
            Value::Null
        }
        "workspace" => {
            let request: workspace::Request = argument(method, "request", body)?;
            workspace::handle(app, request)?
        }
        "folder_choose" => json!(projects::folder_choose(window)?),
        "project_create" => {
            let request: CreateProject = argument(method, "request", body)?;
            json!(projects::project_create(app, request)?)
        }
        "sync_surfaces" => {
            let request: SyncRequest = argument(method, "request", body)?;
            json!(surfaces::sync(window, request)?)
        }
        "surface_focus" => {
            let request: FocusRequest = argument(method, "request", body)?;
            surfaces::focus(window, request)?;
            Value::Null
        }
        "cancel_surfaces" => {
            let request: CancelRequest = argument(method, "request", body)?;
            surfaces::cancel(window, request)?;
            Value::Null
        }
        "wait_presented" => json!(exposure::page_presented(window).map_err(|error| error.message)?),
        "overlay_show" => {
            let request: OverlayRequest = argument(method, "request", body)?;
            json!(modals::show(window, request)?)
        }
        "overlay_place" => {
            let request: PlaceRequest = argument(method, "request", body)?;
            json!(modals::place(window, request)?)
        }
        "set_shape" => {
            let request: ShapeRequest = argument(method, "request", body)?;
            shapes::set(window, request)?;
            Value::Null
        }
        "clear_shape" => {
            let id: String = argument(method, "id", body)?;
            shapes::clear(window, id)?;
            Value::Null
        }
        "overlay_content" => {
            let id: String = argument(method, "id", body)?;
            let instance: u64 = argument(method, "instance", body)?;
            json!(modals::content(window, id, instance)?)
        }
        "overlay_update" => {
            let request: UpdateRequest = argument(method, "request", body)?;
            modals::update(window, request)?;
            Value::Null
        }
        "overlay_ready" => {
            let id: String = argument(method, "id", body)?;
            let instance: u64 = argument(method, "instance", body)?;
            modals::ready(window, id, instance)?;
            Value::Null
        }
        "overlay_hide" => {
            let id: String = argument(method, "id", body)?;
            modals::hide(window, id)?;
            Value::Null
        }
        "overlay_pick" => {
            let id: String = argument(method, "id", body)?;
            let instance: u64 = argument(method, "instance", body)?;
            let key: String = argument(method, "key", body)?;
            let value: String = argument(method, "value", body)?;
            modals::pick(window, id, instance, key, value)?;
            Value::Null
        }
        "window_controls" => json!(windows::window_chrome(window)?),
        "sidecar_send" => {
            let sidecar: String = argument(method, "sidecar", body)?;
            let surface: String = argument(method, "surface", body)?;
            let message: Box<RawValue> = argument(method, "body", body)?;
            let cids: Vec<String> = argument(method, "cids", body)?;
            // An answered send waits for the reply and returns its body (docs/spec/persistent-services.md#owned-session-messages).
            let answer: Option<bool> = argument(method, "answer", body)?;
            let data = soksak_host::windows::window_data(window)?;
            data.images.pending_detach_error(&surface)?;
            let sidecars = window.state::<WindowSidecars>();
            // default: an absent answer member means that the caller waits for no reply.
            if answer.unwrap_or(false) {
                let reply = documents::window_sidecar_send_answered(
                    &data, &sidecars, window, &sidecar, &surface, &message, &cids,
                )?
                .wait()?;
                serde_json::from_str(reply.get()).map_err(|error| error.to_string())?
            } else {
                documents::window_sidecar_send(
                    &data, &sidecars, window, &sidecar, &surface, &message, &cids,
                )?;
                Value::Null
            }
        }
        "sidecar_sessions" => {
            let sidecar: String = argument(method, "sidecar", body)?;
            json!(
                window
                    .state::<WindowSidecars>()
                    .sessions_of(soksak_host::sidecars::SidecarSessionsRequest { sidecar })?
            )
        }
        "program_cancel" => {
            let request: soksak_host::program_run::CancelCall = argument(method, "request", body)?;
            let data = soksak_host::windows::window_data(window)?;
            documents::program_cancel(&data, request);
            Value::Null
        }
        "account_run_cancel" => {
            let request: soksak_host::program_run::AccountRunCancelCall =
                argument(method, "request", body)?;
            let data = soksak_host::windows::window_data(window)?;
            documents::account_run_cancel(&data, request);
            Value::Null
        }
        "account_homes" => {
            let request: soksak_host::account_run::HomesCall = argument(method, "request", body)?;
            soksak_host::account_run::homes(
                &window.state::<WindowSidecars>().config_directory(),
                &request.plugin,
            )?
        }
        "account_home_create" => {
            let request: soksak_host::account_run::HomeCall = argument(method, "request", body)?;
            soksak_host::account_run::create(
                &window.state::<WindowSidecars>().config_directory(),
                &request.plugin,
                &request.id,
            )?;
            Value::Null
        }
        "account_home_remove" => {
            let request: soksak_host::account_run::HomeCall = argument(method, "request", body)?;
            soksak_host::account_run::remove(
                &window.state::<WindowSidecars>().config_directory(),
                &request.plugin,
                &request.id,
            )?;
            Value::Null
        }
        "sidecars_outdated" => json!(window.state::<WindowSidecars>().outdated()),
        "sidecars_replace" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct ReplaceRequest {
                sidecar: String,
            }
            let request: ReplaceRequest = argument(method, "request", body)?;
            window.state::<WindowSidecars>().replace(&request.sidecar)?;
            Value::Null
        }
        "sidecars_retain" => {
            #[derive(serde::Deserialize)]
            struct RetainRequest {
                surfaces: Vec<soksak_host::sidecars::RetainedSurface>,
            }
            let request: RetainRequest = argument(method, "request", body)?;
            let closed = window
                .state::<WindowSidecars>()
                .retain_sessions(&request.surfaces)?;
            json!({ "closed": closed })
        }
        "theme" => json!(theme::get(window)?),
        "set_theme" => {
            let value: Theme = argument(method, "theme", body)?;
            theme::set(window, value)?;
            Value::Null
        }
        "set_menu_language" => {
            let language: String = argument(method, "language", body)?;
            menu::set_language(app, &language)?;
            Value::Null
        }
        "exposure_reply" => {
            let request: String = argument(method, "request", body)?;
            exposure::reply(webview, request)?;
            Value::Null
        }
        "exposure_changed" => {
            let request: Changed = argument(method, "request", body)?;
            exposure::changed(webview, request)?;
            Value::Null
        }
        "exposure_forward" => {
            let request: Forward = argument(method, "request", body)?;
            json!(exposure::forward(webview, request)?)
        }
        "exposure_register" => {
            let request: Register = argument(method, "request", body)?;
            exposure::register(webview, request)?;
            Value::Null
        }
        "document_attach" => {
            let request: documents::Request = argument(method, "request", body)?;
            documents::attach(webview, request)?;
            Value::Null
        }
        "composition_declare" => {
            let request: surfaces::CompositionDeclareRequest = argument(method, "request", body)?;
            surfaces::declare(webview, request)?;
            Value::Null
        }
        "composition_place" => {
            let request: composition::CompositionPlaceRequest = argument(method, "request", body)?;
            composition::place(webview, request)?;
            Value::Null
        }
        "document_load" => {
            let request: documents::Request = argument(method, "request", body)?;
            documents::load(webview, request)?;
            Value::Null
        }
        "document_post" => {
            let request: documents::Request = argument(method, "request", body)?;
            documents::post(webview, request)?;
            Value::Null
        }
        "view_request" => documents::view_request(webview, argument(method, "request", body)?)?,
        "view_event" => json!(documents::view_event(
            webview,
            argument(method, "request", body)?
        )?),
        "sidecar_listen" => {
            let request: soksak_host::sidecar_routes::SidecarListenRequest =
                argument(method, "request", body)?;
            let window = webview.window();
            soksak_host::exposure::authorize_main_caller(
                webview.label(),
                window.label(),
                "sidecar listen",
            )?;
            let request = request.check()?;
            soksak_host::windows::window_data(&window)?
                .sidecar_routes
                .listen(&request.sidecar, &request.id, request.on);
            Value::Null
        }
        // Reloads the main page that applies a plugin change (docs/spec/native-host.md#page-reload).
        "page_reload" => {
            let request: soksak_host::exposure::PageReloadRequest =
                argument(method, "request", body)?;
            let window = webview.window();
            soksak_host::exposure::authorize_main_caller(
                webview.label(),
                window.label(),
                "page reload",
            )?;
            soksak_host::exposure::request_page_reload(&window, &request.cause)?;
            Value::Null
        }
        // Restarts the view of a tab of the surface (docs/spec/native-surfaces.md#view-surfaces).
        "view_reload" => {
            let surface: String = argument(method, "surface", body)?;
            documents::reload_view(window, &surface)?;
            Value::Null
        }
        "view_sidecar_route" => {
            let request: soksak_host::sidecar_routes::ViewSidecarRouteRequest =
                argument(method, "request", body)?;
            let window = webview.window();
            soksak_host::exposure::authorize_main_caller(
                webview.label(),
                window.label(),
                "view sidecar route",
            )?;
            let request = request.check()?;
            soksak_host::windows::window_data(&window)?
                .sidecar_routes
                .route_view(
                    &request.surface,
                    request.generation,
                    &request.sidecar,
                    &request.id,
                    request.on,
                );
            Value::Null
        }
        "view_sidecar_send" => {
            let request: documents::ViewSidecarSendRequest = argument(method, "request", body)?;
            let window = webview.window();
            soksak_host::exposure::authorize_main_caller(
                webview.label(),
                window.label(),
                "view sidecar send",
            )?;
            let data = soksak_host::windows::window_data(&window)?;
            data.images.pending_detach_error(&request.surface)?;
            let sidecars = window.state::<WindowSidecars>();
            if request.answer {
                // An answered view send waits for the reply and returns its body (docs/spec/persistent-services.md#owned-session-messages).
                let reply =
                    documents::view_sidecar_send_answered(&data, &sidecars, &window, request)?
                        .wait()?;
                serde_json::from_str(reply.get()).map_err(|error| error.to_string())?
            } else {
                documents::view_sidecar_send(&data, &sidecars, &window, request)?;
                Value::Null
            }
        }
        "view_reply" => {
            let request: documents::ViewReply = argument(method, "request", body)?;
            documents::view_reply(webview, request)?;
            Value::Null
        }
        "view_source_origins" => {
            let window = webview.window();
            soksak_host::exposure::authorize_main_caller(
                webview.label(),
                window.label(),
                "view source origins",
            )?;
            let task_window = window.clone();
            let snapshot = soksak_host::exposure::on_main(&window, move || {
                soksak_host::windows::window_data(&task_window)
                    .map(|data| data.view_source_origins.snapshot())
            })?;
            json!(snapshot)
        }
        "view_source_event_stream" => {
            let label = webview.label().to_string();
            let channel = port::Channel::<windows::ViewSourceEvent>::new(move |message| {
                let text = match message {
                    port::InvokeResponseBody::Json(text) => text,
                    port::InvokeResponseBody::Raw(_bytes) => {
                        return Err(port::Error::from("a raw stream body reaches no page"));
                    }
                };
                frontend::deliver(
                    &label,
                    format!("window.__soksak && window.__soksak.stream({text})"),
                );
                Ok(())
            });
            windows::register_view_source_event_stream(webview, channel)?;
            Value::Null
        }
        "document_zoom" => {
            let request: documents::Request = argument(method, "request", body)?;
            documents::zoom(webview, request)?;
            Value::Null
        }
        "document_go" => {
            let request: documents::Request = argument(method, "request", body)?;
            json!(documents::go(webview, request)?)
        }
        "document_query" => {
            let request: documents::Request = argument(method, "request", body)?;
            json!(documents::query(webview, request)?)
        }
        "document_interaction_state" => {
            let request: documents::Request = argument(method, "request", body)?;
            json!(documents::interaction_state(webview, request)?)
        }
        "document_detach" => {
            let request: documents::Request = argument(method, "request", body)?;
            documents::detach(webview, request)?;
            Value::Null
        }
        "document_subscribe" => {
            let request: documents::Request = argument(method, "request", body)?;
            json!(documents::subscribe(webview, request)?)
        }
        "document_unsubscribe" => {
            let request: documents::Request = argument(method, "request", body)?;
            documents::unsubscribe(webview, request)?;
            Value::Null
        }
        "image_attach" => {
            let request: images::Request = argument(method, "request", body)?;
            images::attach(webview, request)
                .map_err(|error| images::image_call_error("imageAttach", error))?;
            Value::Null
        }
        "image_focus" => {
            let request: images::Request = argument(method, "request", body)?;
            images::focus(webview, request)
                .map_err(|error| images::image_call_error("imageFocus", error))?;
            Value::Null
        }
        "image_caret" => {
            let request: images::Request = argument(method, "request", body)?;
            let x: f64 = argument(method, "x", body)?;
            let y: f64 = argument(method, "y", body)?;
            let w: f64 = argument(method, "w", body)?;
            let h: f64 = argument(method, "h", body)?;
            images::caret(webview, request, x, y, w, h)
                .map_err(|error| images::image_call_error("imageCaret", error))?;
            Value::Null
        }
        "image_text" => {
            let request: images::Request = argument(method, "request", body)?;
            let text: String = argument(method, "text", body)?;
            images::text(webview, request, text)
                .map_err(|error| images::image_call_error("imageText", error))?;
            Value::Null
        }
        "image_detach" => {
            let request: images::Request = argument(method, "request", body)?;
            images::detach(webview, request)
                .map_err(|error| images::image_call_error("imageDetach", error))?;
            Value::Null
        }
        "clipboard_read" => {
            let request: clipboard::ReadRequest = argument(method, "request", body)?;
            json!(clipboard::read(window, request)?)
        }
        "link_open" => {
            let request: link::OpenRequest = argument(method, "request", body)?;
            link::open(window, request)?;
            Value::Null
        }
        "app_update_state" => {
            let directory = window
                .state::<soksak_host::workspace::Workspace>()
                .directory()
                .to_path_buf();
            json!(soksak_host::app_update::state(&directory)?)
        }
        "app_update_stage" => {
            let request: soksak_host::app_update::StageRequest = argument(method, "request", body)?;
            let directory = window
                .state::<soksak_host::workspace::Workspace>()
                .directory()
                .to_path_buf();
            json!(soksak_host::app_update::stage_call(&directory, request)?)
        }
        "app_update_apply" => {
            let request: soksak_host::app_update::ApplyRequest = argument(method, "request", body)?;
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
                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                Some(soksak_host::app_update::PendingStart {
                    command,
                    relaunch: false,
                });
            soksak_host::event_record::quit_with_cause(
                "update",
                soksak_host::event_record::host_quit_source("update"),
                || app.quit(),
            );
            Value::Null
        }
        "debug_files" => {
            let directory = window
                .state::<soksak_host::workspace::Workspace>()
                .directory()
                .to_path_buf();
            json!(soksak_host::debug::list(&directory)?)
        }
        "debug_read" => {
            let request: soksak_host::debug::SaveRequest = argument(method, "request", body)?;
            json!(soksak_host::debug::read_file(window, request)?)
        }
        "debug_record" => {
            let request: soksak_host::debug::RecordRequest = argument(method, "request", body)?;
            soksak_host::debug::record(app, request)?
        }
        "debug_save" => {
            let request: soksak_host::debug::SaveRequest = argument(method, "request", body)?;
            json!(soksak_host::debug::save(window, request)?)
        }
        "log_query" => {
            let request: serde_json::Map<String, Value> = argument(method, "request", body)?;
            json!(soksak_host::debug::log_query(app, request)?)
        }
        "debug_follow" => {
            let request: windows::FollowRequest = argument(method, "request", body)?;
            windows::debug_follow(window, request)?;
            Value::Null
        }
        "debug_save_text" => {
            let request: soksak_host::debug::TextRequest = argument(method, "request", body)?;
            json!(soksak_host::debug::save_text(window, request)?)
        }
        "file_place" => {
            let request: soksak_host::file_place::FilePlaceRequest =
                argument(method, "request", body)?;
            json!(soksak_host::file_place::place(window, request)?)
        }
        "debug_save_all" => json!(soksak_host::debug::save_all(window)?),
        "plugins_state" => json!(app.state::<soksak_host::plugins::Plugins>().state()?),
        "plugins_run" => {
            let request: soksak_host::plugins::RunRequest = argument(method, "request", body)?;
            json!(app.state::<soksak_host::plugins::Plugins>().run(request)?)
        }
        "plugins_use_registry" => {
            let request: soksak_host::plugins::RegistryRequest = argument(method, "request", body)?;
            app.state::<soksak_host::plugins::Plugins>()
                .use_registry(request)?
        }
        "setup_state" => json!(app.state::<soksak_host::setup::Setups>().state()?),
        "setup_install" => {
            let request: soksak_host::setup::InstallRequest = argument(method, "request", body)?;
            json!(app.state::<soksak_host::setup::Setups>().install(request)?)
        }
        "setup_change" => {
            let request: soksak_host::setup::ChangeRequest = argument(method, "request", body)?;
            json!(app.state::<soksak_host::setup::Setups>().change(request)?)
        }
        "plugins_starter" => {
            let request: soksak_host::plugins::StarterRequest = argument(method, "request", body)?;
            json!(
                app.state::<soksak_host::plugins::Plugins>()
                    .set_starter(request)?
            )
        }
        "notify" => {
            let request: soksak_host::notifications::NotificationRequest =
                argument(method, "request", body)?;
            soksak_host::notifications::notify(window, request)?;
            Value::Null
        }
        "notification_remove" => {
            let request: soksak_host::notifications::NotificationRequest =
                argument(method, "request", body)?;
            soksak_host::notifications::remove(window, request)?;
            Value::Null
        }
        "notification_state" => json!(soksak_host::notifications::state()?),
        "clipboard_write_text" => {
            let text: String = argument(method, "text", body)?;
            clipboard::write_text(window, text)?;
            Value::Null
        }
        "clipboard_read_view_png" => {
            let request: clipboard::ViewReadRequest = argument(method, "request", body)?;
            json!(clipboard::read_view_png(window, request)?)
        }
        "clipboard_persist_view_png" => {
            let request: clipboard::ViewPersistRequest = argument(method, "request", body)?;
            json!({ "path": clipboard::persist_view_png(app, window, request)? })
        }
        "clipboard_persist_png" => {
            let request: clipboard::PersistRequest = argument(method, "request", body)?;
            json!({ "path": clipboard::persist_png(app, request.data)? })
        }
        unknown => return Err(format!("the page called no known method {unknown:?}")),
    };
    Ok(value)
}

#[cfg(test)]
#[path = "../tests/bindings/bindings_test.rs"]
mod bindings_test;
