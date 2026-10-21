//! The sidecar requests of a plugin host page (docs/plans/plugin-host-routes.md rules 2, 3 and 7). The main page of a window
//! sends a request for a sidecar that its plugin depends on, in a session plugin:<plugin id>:<project id>:<sidecar name>, and closes
//! the sessions of a plugin host that ends. A surface page cannot send to a plugin session.

use std::sync::PoisonError;

use serde::Deserialize;
use tauri::{Manager, Webview};

use crate::sidecars::{Owner, Sidecars, WindowSidecars};
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

/// Whether the surface is a plugin session of the project. A project release closes these (docs/plans/plugin-host-routes.md rule 7).
pub(crate) fn is_project_session(surface: &str, project: &str) -> bool {
    parse_session(surface).is_some_and(|(_, current, _)| current == project)
}

/// Whether the surface is a plugin session of the plugin. The close of a plugin host closes these (docs/plans/plugin-host-routes.md
/// rule 7).
pub(crate) fn is_plugin_session_of(surface: &str, plugin: &str) -> bool {
    parse_session(surface).is_some_and(|(current, _, _)| current == plugin)
}

/// Whether the surface is a plugin session of any plugin. A page start closes these (docs/plans/plugin-host-routes.md rule 7).
pub(crate) fn is_plugin_session(surface: &str) -> bool {
    parse_session(surface).is_some()
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
/// held is the root that the window records for the project of the session, or None when the window does not hold the project.
pub(crate) fn plugin_send_root(
    plugin: &str,
    sidecar: &str,
    id: &str,
    depends: bool,
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
    let held = window_data(&window)?
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
    close_plugin_host_sessions(
        &window.state::<WindowSidecars>(),
        &window,
        webview.label(),
        window.label(),
        plugin,
    )
}

/// Closes the plugin sessions of plugin that the owner holds, after the caller is checked to be the main webview of the
/// window of the owner. Tauri window values are only read by the caller of this function.
pub(crate) fn close_plugin_host_sessions<O: Owner>(
    sidecars: &Sidecars<O>,
    owner: &O,
    caller: &str,
    window: &str,
    plugin: &str,
) -> Result<(), String> {
    crate::exposure::authorize_main_caller(caller, window, "plugin host sidecar close")?;
    sidecars.close_owned(owner, &|surface| is_plugin_session_of(surface, plugin))
}

/// Closes the plugin sessions of the project that the owner holds, when the project is released (docs/plans/plugin-host-routes.md
/// rule 7). The caller clears the project root of the owner.
pub(crate) fn close_project_plugin_sessions<O: Owner>(
    sidecars: &Sidecars<O>,
    owner: &O,
    project: &str,
) -> Result<(), String> {
    sidecars.close_owned(owner, &|surface| is_project_session(surface, project))
}

/// Closes every plugin session that the owner holds, when the main page of the window starts (docs/plans/plugin-host-routes.md
/// rule 7). The surfaces of the owner are kept.
pub(crate) fn close_window_plugin_sessions<O: Owner>(
    sidecars: &Sidecars<O>,
    owner: &O,
) -> Result<(), String> {
    sidecars.close_owned(owner, &|surface| is_plugin_session(surface))
}
