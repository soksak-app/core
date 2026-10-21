//! The sidecar requests of a plugin host page (docs/plans/plugin-host-routes.md rules 2, 3 and 7). The main page of a window
//! sends a request for a sidecar that its plugin depends on, in a session plugin:<plugin id>:<project id>:<sidecar name>, and closes
//! the sessions of a plugin host that ends. A surface page cannot send to a plugin session.

use std::sync::PoisonError;

use serde::Deserialize;
use tauri::{Manager, Webview};

use crate::sidecars::WindowSidecars;
use crate::windows::window_data;

/// Returns the plugin, the project and the sidecar of a plugin session id plugin:<plugin>:<project>:<sidecar>, or None for an id
/// that is not one (docs/plans/plugin-host-routes.md rule 2). No id contains a colon, so the split is unambiguous.
pub(crate) fn parse_session(id: &str) -> Option<(&str, &str, &str)> {
    let parts: Vec<&str> = id.strip_prefix("plugin:")?.split(':').collect();
    match parts.as_slice() {
        [plugin, project, sidecar]
            if !plugin.is_empty() && !project.is_empty() && !sidecar.is_empty() =>
        {
            Some((plugin, project, sidecar))
        }
        _ => None,
    }
}

/// Returns the plugin and the project of a state session id state:<plugin>:<project>, or None for an id that is not one
/// (docs/plans/plugin-host-routes.md F229-8).
pub(crate) fn parse_state_session(id: &str) -> Option<(&str, &str)> {
    let parts: Vec<&str> = id.strip_prefix("state:")?.split(':').collect();
    match parts.as_slice() {
        [plugin, project] if !plugin.is_empty() && !project.is_empty() => Some((plugin, project)),
        _ => None,
    }
}

/// Reports whether surface is a plugin session or a state session of project. Both end with the release of the project
/// (docs/plans/plugin-host-routes.md rule 7, F229-8).
pub(crate) fn is_project_session(surface: &str, project: &str) -> bool {
    parse_session(surface).is_some_and(|(_, session_project, _)| session_project == project)
        || parse_state_session(surface)
            .is_some_and(|(_, session_project)| session_project == project)
}

/// A sidecar request of the host of plugin: the sidecar, the session id, the body and the correlation identifiers.
#[derive(Deserialize)]
pub struct PluginHostSidecarSend {
    pub plugin: String,
    pub sidecar: String,
    pub id: String,
    pub body: Box<serde_json::value::RawValue>,
    #[serde(default)]
    pub cids: Vec<String>,
}

/// Refuses a send of a surface page to a plugin session, which only the host of the plugin sends (docs/plans/plugin-host-routes.md
/// rule 2).
pub(crate) fn refuse_surface_send(surface: &str) -> Result<(), String> {
    if surface.starts_with("plugin:") {
        return Err(format!(
            "sidecar session {surface} is reserved for a plugin host"
        ));
    }
    Ok(())
}

/// The checks of a sidecar request of the host of plugin before its send, and the folder root that it sends with (rules 2 and 3).
/// shown is whether the window shows a project, and held is the root that the window records for the project of the session, or
/// None when the window does not hold the project. A window that shows no project refuses every request (F229-1).
pub(crate) fn plugin_send_root(
    plugin: &str,
    sidecar: &str,
    id: &str,
    depends: bool,
    shown: bool,
    held: Option<&str>,
) -> Result<String, String> {
    let Some((_, project, _)) = parse_session(id).filter(|(session_plugin, _, session_sidecar)| {
        *session_plugin == plugin && *session_sidecar == sidecar
    }) else {
        return Err(format!(
            "plugin host {plugin} cannot use sidecar session {id}"
        ));
    };
    if !depends {
        return Err(format!("plugin host {plugin} cannot use sidecar {sidecar}"));
    }
    if !shown {
        return Err(format!("plugin host {plugin}: no project is shown"));
    }
    let root = held.ok_or_else(|| {
        format!("plugin host {plugin}: project {project} is not held by this window")
    })?;
    if root.is_empty() {
        return Err(format!(
            "plugin host {plugin}: project {project} has no folder"
        ));
    }
    Ok(root.to_string())
}

/// Sends a sidecar request of the host of the plugin that the main page of the calling window answers, through the sidecar path
/// with the folder root of the project of the session (docs/plans/plugin-host-routes.md rules 2 and 3).
pub(crate) fn plugin_host_sidecar_send(
    webview: &Webview,
    request: PluginHostSidecarSend,
) -> Result<(), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(
        webview.label(),
        window.label(),
        "plugin host sidecar send",
    )?;
    let sidecars = window.state::<WindowSidecars>();
    let depends = sidecars.depends_on(&request.plugin, &request.sidecar);
    // default: a session id that names no project holds no root, so the checks of plugin_send_root refuse it.
    let project = parse_session(&request.id).map_or("", |(_, project, _)| project);
    let data = window_data(&window)?;
    let shown = !data
        .shown
        .lock()
        // default: a lock that a panicking thread poisoned still holds the shown project, which is only read; the panic hook
        // records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .is_empty();
    let held = data
        .projects
        .lock()
        // default: a lock that a panicking thread poisoned still holds the project roots, which are only read; the panic hook
        // records the panic.
        .unwrap_or_else(PoisonError::into_inner)
        .get(project)
        .cloned();
    let root = plugin_send_root(
        &request.plugin,
        &request.sidecar,
        &request.id,
        depends,
        shown,
        held.as_deref(),
    )?;
    sidecars.send_plugin_with_cids(
        &window,
        &request.sidecar,
        &request.id,
        &root,
        &request.body,
        &request.cids,
    )
}

/// Closes the plugin sessions of plugin that the calling window owns, when the main page receives plugin-host-ended (docs/plans/
/// plugin-host-routes.md rule 7).
pub(crate) fn plugin_host_sidecar_close(webview: &Webview, plugin: &str) -> Result<(), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(
        webview.label(),
        window.label(),
        "plugin host sidecar close",
    )?;
    window
        .state::<WindowSidecars>()
        .close_owned(&window, &|surface| {
            parse_session(surface).is_some_and(|(session_plugin, _, _)| session_plugin == plugin)
        })
}
