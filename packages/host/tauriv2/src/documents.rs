//! Document regions in a surface page. This is the "document region" of docs/spec/native-surfaces.md.
//!
//! A surface page attaches an external document to one of its elements. The host places a document webview inside the
//! webview of that surface, lays it out with the insets that the page reported, and sends the document state only to
//! that surface. The document webview is a subview of the surface webview, so it moves and hides together with the
//! surface. It is closed when the surface is removed or the surface page is loaded again.
//!
//! Commands run outside the main thread and native work runs on the main thread. A cleanup that started on the main
//! thread is not awaited.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, Webview, Window};

use crate::application_log::{log_error, log_failure};
use crate::exposure::{self, on_main, with_view};
use crate::platform::{self, Handle};
use crate::surfaces::{require_region, surface_handle};
use crate::windows::{emit_window, window_data};

/// The directory inside the configuration directory that holds the persistent site data of document regions. It differs
/// from the storage of the app document.
/// (docs/spec/native-surfaces.md#document-regions).
const DOCUMENT_DATA: &str = "document-data";

/// A document region call of a surface page. Each call uses only the fields that it needs.
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub surface: String,
    pub document: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub zoom: Option<f64>,
    #[serde(default)]
    pub offset: Option<i32>,
    /// The JSON value that documentPost sends to a plugin document.
    #[serde(default)]
    pub message: Option<serde_json::Value>,
}

/// A message of a plugin document, {"message": value} or {"error": reason}: the payload of the document-message
/// event of the owning surface, or the reason that the host writes to the application log.
pub enum Message {
    Forward(serde_json::Value),
    Failure(String),
}

pub fn document_message(surface: &str, document: &str, value: &str) -> Result<Message, String> {
    let received: serde_json::Value = serde_json::from_str(value)
        .map_err(|error| format!("document message {document} is not JSON: {error}"))?;
    if let Some(reason) = received.get("error").and_then(|reason| reason.as_str()) {
        return Ok(Message::Failure(reason.to_string()));
    }
    match received.get("message") {
        Some(message) => Ok(Message::Forward(serde_json::json!({
            "surface": surface,
            "document": document,
            "message": message,
        }))),
        None => Err(format!(
            "document message {document} has neither message nor error"
        )),
    }
}

impl Request {
    /// The text scale of the document (docs/spec/text-size.md). It is an error when it is absent or not a finite
    /// positive number.
    pub fn zoom_factor(&self) -> Result<f64, String> {
        match self.zoom {
            Some(zoom) if zoom.is_finite() && zoom > 0.0 => Ok(zoom),
            _ => Err("document zoom must be a finite positive number".into()),
        }
    }
}

/// The value of the document-state event.
#[derive(Clone, Serialize)]
struct State {
    surface: String,
    document: String,
    state: Value,
}

#[derive(Clone, Serialize)]
struct Event {
    surface: String,
    document: String,
    event: Value,
}

/// A pair of a surface and a document name.
pub type Key = (String, String);

/// Checks that the calling surface caller is request.surface and that the document name is valid, and returns the key.
/// When caller is None, the calling webview is not a surface of this window.
pub fn check(caller: Option<&str>, request: &Request) -> Result<Key, String> {
    if caller != Some(request.surface.as_str()) {
        return Err(format!(
            "this document is not surface {:?}",
            request.surface
        ));
    }
    let mut chars = request.document.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && request.document.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("invalid document name {:?}", request.document));
    }
    Ok((request.surface.clone(), request.document.clone()))
}

/// The document regions of a window. The value is the address of the document webview, and 0 for a region that is being
/// created.
#[derive(Default)]
pub struct Documents(Mutex<HashMap<Key, Handle>>);

impl Documents {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Handle>> {
        self.0
            .lock()
            // default: a thread that stopped while holding the lock also changed the map only by one insert, remove or
            // read, so the map is consistent, and that stop was already reported as a panic report.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Takes a name. It is an error when the same name already exists.
    pub fn reserve(&self, key: &Key) -> Result<(), String> {
        let mut all = self.lock();
        if all.contains_key(key) {
            return Err(format!("document {:?} is already attached", key.1));
        }
        all.insert(key.clone(), 0);
        Ok(())
    }

    /// Writes the address of the created document to the taken name. It is false when the name was removed in the
    /// meantime.
    pub fn set(&self, key: &Key, handle: Handle) -> bool {
        match self.lock().get_mut(key) {
            Some(slot) => {
                *slot = handle;
                true
            }
            None => false,
        }
    }

    /// Returns the address of a created document.
    pub fn get(&self, key: &Key) -> Result<Handle, String> {
        match self.lock().get(key) {
            Some(&handle) if handle != 0 => Ok(handle),
            _ => Err(format!("document {:?} is not attached", key.1)),
        }
    }

    /// Removes a name and returns the address of its document. The address is 0 when the name was being created.
    pub fn remove(&self, key: &Key) -> Result<Handle, String> {
        self.lock()
            .remove(key)
            .ok_or_else(|| format!("document {:?} is not attached", key.1))
    }

    /// Removes every name of a surface and returns the addresses of the created documents.
    pub fn remove_surface(&self, surface: &str) -> Vec<Handle> {
        let mut removed = Vec::new();
        self.lock().retain(|key, handle| {
            if key.0 != surface {
                return true;
            }
            if *handle != 0 {
                removed.push(*handle);
            }
            false
        });
        removed
    }

    /// The key of each address of a created document.
    pub fn names(&self) -> HashMap<Handle, Key> {
        self.lock()
            .iter()
            .filter(|(_, &handle)| handle != 0)
            .map(|(key, &handle)| (handle, key.clone()))
            .collect()
    }

    /// The addresses of created documents.
    pub fn all(&self) -> Vec<Handle> {
        self.lock()
            .values()
            .copied()
            .filter(|&handle| handle != 0)
            .collect()
    }
}

/// Checks the surface id of the calling webview and returns the key and the window of the request.
fn owner(webview: &Webview, request: &Request) -> Result<(Key, Window), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), "surface operations")?;
    let key = check(Some(request.surface.as_str()), request)?;
    Ok((key, window))
}

/// Creates a hidden document region inside a surface. It is an error when the same name already exists.
pub(crate) fn attach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let platform = platform::current()?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    // The name is taken first. The lock is not held while waiting for native work.
    data.documents.reserve(&key)?;
    let handle = match create(webview, &window, &key, platform, data.overlay.dialog()) {
        Ok(handle) => handle,
        Err(error) => {
            drop(data.documents.remove(&key));
            return Err(error);
        }
    };
    // When the surface was removed during creation, the created document is closed. The registration and the close
    // happen in one task of the main thread.
    let registry = data.clone();
    let stored = key.clone();
    let registered = on_main(&window, move || {
        if registry.documents.set(&stored, handle) {
            return Ok(true);
        }
        platform.close_document(handle)?;
        Ok(false)
    })?;
    if !registered {
        return Err(format!(
            "surface {:?} closed while its document was created",
            key.0
        ));
    }
    Ok(())
}

/// Creates a document webview inside the surface webview and returns its address.
fn create(
    webview: &Webview,
    window: &Window,
    key: &Key,
    platform: &'static dyn platform::Platform,
    dialog: bool,
) -> Result<Handle, String> {
    with_view(webview, move |view| platform.view_id(view))?;
    let host = window.clone();
    let (surface_id, name) = key.clone();
    let state_host = host.clone();
    let state_surface = surface_id.clone();
    let state_document = name.clone();
    on_main(window, move || {
        let changed = Box::new(move |state: String| {
            let state = match serde_json::from_str(&state) {
                Ok(state) => state,
                Err(error) => {
                    log_error(
                        "document-state",
                        format!("the state is not JSON: {error}: {state}"),
                    );
                    return;
                }
            };
            let payload = State {
                surface: state_surface.clone(),
                document: state_document.clone(),
                state,
            };
            if let Err(error) = emit_window(&state_host, "document-state", payload) {
                log_error("document-state", error);
            }
            exposure::window_changed(&state_host);
        });
        let surface = surface_handle(&host, &surface_id)?;
        let directory = crate::config_directory(host.app_handle())
            .map_err(|e| e.to_string())?
            .join(DOCUMENT_DATA);
        let directory = directory.to_str().ok_or_else(|| {
            format!(
                "document data directory is not UTF-8: {}",
                directory.display()
            )
        })?;
        let plugin = window_data(&host)?
            .surface_plugins
            .lock()
            .map_err(|e| e.to_string())?
            .get(&surface_id)
            .cloned()
            .ok_or_else(|| format!("surface {surface_id:?} has no composition declaration"))?;
        let config = crate::config_directory(host.app_handle()).map_err(|e| e.to_string())?;
        let folder = crate::installed::plugin_folder(&config, &plugin)?;
        let folder = folder
            .to_str()
            .ok_or_else(|| format!("plugin folder is not UTF-8: {}", folder.display()))?
            .to_string();
        let handle = platform.create_document(surface, directory, &folder, &plugin, changed)?;
        let dark = crate::theme::is_dark(&host)?;
        platform.set_document_appearance(handle, dark)?;
        platform.set_document_background(handle, dialog)?;
        let message_host = host.clone();
        let message_surface = surface_id.clone();
        let message_document = name.clone();
        platform.set_document_message(
            handle,
            Box::new(move |value| {
                let place = format!("document message {message_document}");
                match document_message(&message_surface, &message_document, &value) {
                    Ok(Message::Forward(payload)) => {
                        if let Err(error) = emit_window(&message_host, "document-message", payload)
                        {
                            log_error(&place, error);
                        }
                    }
                    Ok(Message::Failure(reason)) => log_error(&place, reason),
                    Err(error) => log_error(&place, error),
                }
            }),
        )?;
        let event_host = host.clone();
        let event_surface = surface_id.clone();
        let event_document = name.clone();
        platform.set_document_event(
            handle,
            Box::new(move |value| {
                let event = match serde_json::from_str(&value) {
                    Ok(event) => event,
                    Err(error) => {
                        log_error(
                            "document-event",
                            format!("the event is not JSON: {error}: {value}"),
                        );
                        return;
                    }
                };
                if let Err(error) = emit_window(
                    &event_host,
                    "document-event",
                    Event {
                        surface: event_surface.clone(),
                        document: event_document.clone(),
                        event,
                    },
                ) {
                    log_error("document-event", error);
                }
                exposure::window_changed(&event_host);
            }),
        )?;
        Ok(handle)
    })
}

/// Runs work on the main thread for an open document region.
fn with_document<T: Send + 'static>(
    webview: &Webview,
    request: &Request,
    work: impl FnOnce(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (key, window) = owner(webview, request)?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    // The lookup and the use happen in one task of the main thread. A close also happens on the main thread together
    // with the unregistration, so the looked-up address is not released during this task.
    on_main(&window, move || work(data.documents.get(&key)?))
}

/// Sends a JSON message to the current plugin document of a region.
pub(crate) fn post(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let message = request
        .message
        .clone()
        .ok_or("documentPost requires a JSON message")?
        .to_string();
    let name = request.document.clone();
    with_document(webview, &request, move |handle| {
        if platform.post_document(handle, &message)? {
            Ok(())
        } else {
            Err(format!("document {name} shows no plugin document"))
        }
    })
}

pub(crate) fn load(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let url = request.url.clone();
    with_document(webview, &request, move |handle| {
        if platform.load_document(handle, &url)? {
            Ok(())
        } else {
            Err(format!(
                "only http, https, file, and sok addresses can be opened: {url:?}"
            ))
        }
    })
}

/// Sets the page zoom of a document as the text scale.
pub(crate) fn zoom(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    let zoom = request.zoom_factor()?;
    with_document(webview, &request, move |handle| {
        if platform.zoom_document(handle, zoom)? {
            Ok(())
        } else {
            Err(format!("document zoom {zoom} was rejected"))
        }
    })
}

/// The action number and the distance of a go request. entry needs a nonzero offset, and the other actions take no
/// offset.
pub fn go_action(request: &Request) -> Result<(i32, i32), String> {
    let action = match request.action.as_str() {
        "back" => 0,
        "forward" => 1,
        "reload" => 2,
        "stop" => 3,
        "entry" => 4,
        other => return Err(format!("unknown document action {other:?}")),
    };
    match (action, request.offset) {
        (4, Some(offset)) if offset != 0 => Ok((action, offset)),
        (4, _) => Err("document action entry requires a non-zero offset".into()),
        (_, Some(_)) => Err(format!(
            "document action {:?} does not take an offset",
            request.action
        )),
        (_, None) => Ok((action, 0)),
    }
}

/// Runs history navigation, opening a history entry, reload and stop, and returns whether it ran.
pub(crate) fn go(webview: &Webview, request: Request) -> Result<bool, String> {
    let platform = platform::current()?;
    let (action, offset) = go_action(&request)?;
    with_document(webview, &request, move |handle| {
        platform.go_document(handle, action, offset)
    })
}

pub(crate) fn detach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let data = window_data(&window)?;
    require_region(&data.compositions, &key.0, &key.1, "document", None)?;
    let platform = platform::current()?;
    // The unregistration and the close happen in one task of the main thread.
    on_main(&window, move || {
        let handle = data.documents.remove(&key)?;
        if handle != 0 {
            platform.close_document(handle)?;
        }
        Ok(())
    })?;
    exposure::window_changed(&window);
    Ok(())
}

/// Closes every document region of a surface. It does not wait for main-thread work, so it can be called from any
/// thread.
pub(crate) fn close_surface(window: &Window, surface: &str) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(error) => return log_error("document close", error),
    };
    let host = window.clone();
    let surface = surface.to_string();
    // The unregistration and the close happen in one task of the main thread. Other work that uses a document also
    // looks it up on the main thread, so a released address is not used.
    log_failure(
        "document close",
        window
            .run_on_main_thread(move || {
                let handles = data.documents.remove_surface(&surface);
                if handles.is_empty() {
                    return;
                }
                for handle in handles {
                    log_failure("document close", platform.close_document(handle));
                }
                exposure::window_changed(&host);
            })
            .map_err(|e| e.to_string()),
    );
}

/// Dims the document regions while a dialog is open. It does not wait.
pub(crate) fn set_background(window: &Window, enabled: bool) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let platform = match platform::current() {
        Ok(platform) => platform,
        Err(error) => return log_error("document background", error),
    };
    // The document address is looked up on the main thread. It is the same thread as the close, so a released address
    // is not used.
    log_failure(
        "document background",
        window
            .run_on_main_thread(move || {
                for handle in data.documents.all() {
                    log_failure(
                        "document background",
                        platform.set_document_background(handle, enabled),
                    );
                }
            })
            .map_err(|e| e.to_string()),
    );
}
