//! The plugin host web views of a window (docs/spec/plugin-host.md). The host creates the plugin host webview of a
//! plugin when the main page of the window loads a plugin whose manifest declares host, and disposes it when the
//! plugin is removed or disabled, when the application applies a plugin change that reloads the window, and when the
//! window closes. The channel, the exposure, the snapshots, the restart limit and the state of the host page are the
//! work of F212.9-3 and F212.9-4.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde_json::Value;

use crate::platform::Handle;

/// One enabled installed plugin whose manifest declares host, with its id and page.
#[derive(Debug, Clone, PartialEq)]
pub struct HostPlugin {
    pub id: String,
    pub page: String,
}

/// Returns the enabled installed plugins whose manifest declares host, in id order. A host declaration that is not an
/// object, or whose page is not a non-empty string, is an error (docs/spec/plugin-host.md#declaration). The texts of
/// the errors are the same in both hosts (docs/spec/host-contract.md).
pub fn host_plugins(config_dir: &Path) -> Result<Vec<HostPlugin>, String> {
    let (state, manifests) = soksak_sok::plugins::read_installed_manifests(config_dir)?;
    let mut hosts = vec![];
    // The plugins are a BTreeMap, so the ids are in order.
    for (id, plugin) in &state.plugins {
        if !plugin.enabled {
            continue;
        }
        let manifest = manifests
            .get(id)
            .ok_or_else(|| format!("plugin {id} has no installed manifest"))?;
        if let Some(page) = host_page(id, &manifest.value)? {
            hosts.push(HostPlugin {
                id: id.clone(),
                page,
            });
        }
    }
    Ok(hosts)
}

/// Returns the page of the host declaration of the manifest of plugin, or None when the manifest declares no host.
pub fn host_page(plugin: &str, manifest: &Value) -> Result<Option<String>, String> {
    let host = match manifest.get("host") {
        None | Some(Value::Null) => return Ok(None),
        Some(host) => host,
    };
    let fields = host
        .as_object()
        .ok_or_else(|| format!("plugin {plugin} declares host that is not an object"))?;
    let page = fields
        .get("page")
        .and_then(Value::as_str)
        .filter(|page| !page.is_empty())
        .ok_or_else(|| format!("plugin {plugin} declares host without a page"))?;
    Ok(Some(page.to_string()))
}

/// The plugin host webviews of one window, by plugin id. The values are used only on the main thread; the record is
/// shared with the window state.
#[derive(Default)]
pub struct PluginHosts(Mutex<HashMap<String, Handle>>);

impl PluginHosts {
    /// Returns the plugins of plugins that the window has no host webview of, in the order of plugins.
    pub fn missing(&self, plugins: &[HostPlugin]) -> Vec<HostPlugin> {
        // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
        let hosts = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        plugins
            .iter()
            .filter(|plugin| !hosts.contains_key(&plugin.id))
            .cloned()
            .collect()
    }

    /// Records the host webview handle of plugin.
    pub fn insert(&self, plugin: &str, handle: Handle) {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .insert(plugin.to_string(), handle);
    }

    /// Removes the record of the host webview of plugin and returns its handle once.
    pub fn take(&self, plugin: &str) -> Option<Handle> {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .remove(plugin)
    }

    /// Removes every record and returns the handles.
    pub fn take_all(&self) -> Vec<Handle> {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .map(|(_, handle)| handle)
            .collect()
    }

    /// Returns true while a host webview of plugin is being created.
    pub fn contains(&self, plugin: &str) -> bool {
        self.0
            .lock()
            // default: a lock that a panicking thread poisoned still holds the record of the plugin host; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(plugin)
    }
}

/// The declaration and the folders of one plugin host webview.
pub struct HostView<'a> {
    /// The absolute path at which the persistent data store keeps the site data.
    pub directory: &'a str,
    /// The installed folder of the plugin.
    pub folder: &'a str,
    /// The id and the page of the plugin whose host the webview runs.
    pub plugin: &'a str,
    pub page: &'a str,
}

/// Creates the plugin host webview of view.plugin with the view configuration
/// (docs/spec/native-surfaces.md#view-surfaces) and loads sok://<plugin>/<page> into it. A failed step closes the
/// webview and reports the reason.
pub fn create_host(
    channel: &str,
    view: HostView<'_>,
    create: impl FnOnce(&str, &HostView<'_>) -> Result<Handle, String>,
    load: impl FnOnce(Handle, &str) -> Result<bool, String>,
    close: impl FnOnce(Handle) -> Result<(), String>,
) -> Result<Handle, String> {
    let handle = create(channel, &view)?;
    let address = format!("sok://{}/{}", view.plugin, view.page);
    let reason = match load(handle, &address) {
        Ok(true) => return Ok(handle),
        Ok(false) => format!("plugin host of {} cannot load {address}", view.plugin),
        Err(error) => error,
    };
    close(handle).map_err(|closing| format!("{reason}; closing the plugin host: {closing}"))?;
    Err(reason)
}
