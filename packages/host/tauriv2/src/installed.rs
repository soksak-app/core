//! Provides the plugins installed in the configuration folder to the page and finds their sidecars (the provision of
//! installed plugins in docs/spec/installation.md). A file is read only from the folder that the installation recorded
//! in installed.json. The installation state is read at every request, so a page loaded after a change sees that
//! change. The format check uses the implementation of the command line sok.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::value::RawValue;
use soksak_sok::install::InstalledState;

use crate::application_log::log_error;
use crate::sidecars::SidecarDeclaration;

/// The path through which the page reads the list of installed plugins.
pub const INSTALLED_PLUGINS_PATH: &str = "/installed-plugins.json";

/// One enabled installed plugin and its file folder.
struct InstalledPlugin {
    id: String,
    package: String,
    version: String,
    dir: PathBuf,
}

/// Returns the enabled installed plugins in id order. The installation folder is recorded as a path relative to the
/// configuration folder, and the conversion report of a format 1 file is written to the standard error, which is the
/// application log (docs/spec/installation.md).
fn enabled_plugins(config_dir: &Path) -> Result<(Vec<InstalledPlugin>, InstalledState), String> {
    let state = soksak_sok::plugins::read_installed(config_dir)?;
    let mut plugins = vec![];
    for (id, plugin) in &state.plugins {
        if !plugin.enabled {
            continue;
        }
        plugins.push(InstalledPlugin {
            id: id.clone(),
            package: soksak_sok::plugins::installed_name(config_dir, plugin)?,
            version: plugin.version.clone(),
            dir: config_dir.join(&plugin.path),
        });
    }
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((plugins, state))
}

/// The folder of the enabled installed plugin, which the document regions of its surfaces serve at
/// sok://<plugin>/ (docs/spec/native-surfaces.md#document-regions).
pub fn plugin_folder(config_dir: &Path, plugin: &str) -> Result<PathBuf, String> {
    let (plugins, _) = enabled_plugins(config_dir)?;
    plugins
        .into_iter()
        .find(|entry| entry.id == plugin)
        .map(|entry| entry.dir)
        .ok_or_else(|| format!("plugin {plugin} is not installed and enabled"))
}

/// Removes the whitespace outside strings from JSON text. The key order and the strings stay as they are.
fn compact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut quoted, mut escaped) = (false, false);
    for c in text.chars() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

/// The content of /installed-plugins.json. For each plugin it holds the installed plugin.json as the manifest, so that
/// the page registers the plugins before the first screen. When the installation state cannot be read, it is an {
/// "error" } document.
pub fn installed_plugins_document(config_dir: &Path, diagnostics: bool) -> Vec<u8> {
    #[derive(Serialize)]
    struct Entry {
        id: String,
        package: String,
        version: String,
        manifest: Box<RawValue>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics: Option<Box<RawValue>>,
    }
    let failure = |error: String| {
        serde_json::to_vec(&serde_json::json!({ "error": error }))
            // default: the serialization of one string does not fail, and when it fails, a fixed error document is
            // used.
            .unwrap_or_else(|_| br#"{"error":"the error text cannot be encoded"}"#.to_vec())
    };
    let plugins = match enabled_plugins(config_dir) {
        Ok((plugins, _)) => plugins,
        Err(error) => return failure(error),
    };
    let mut entries = vec![];
    for plugin in plugins {
        let manifest_file = plugin.dir.join("plugin.json");
        let manifest = match std::fs::read_to_string(&manifest_file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return failure(format!(
                    "{}: the plugin manifest is missing",
                    manifest_file.display()
                ));
            }
            Err(error) => return failure(format!("{}: {error}", manifest_file.display())),
            Ok(text) => match RawValue::from_string(compact(&text)) {
                Ok(raw) if serde_json::from_str::<serde_json::Value>(raw.get()).is_ok() => raw,
                _ => return failure(format!("{} is not valid JSON", manifest_file.display())),
            },
        };
        let mut entry = Entry {
            id: plugin.id,
            package: plugin.package,
            version: plugin.version,
            manifest,
            diagnostics: None,
        };
        if diagnostics {
            let file = plugin.dir.join("diagnostics.json");
            match std::fs::read_to_string(&file) {
                // default: a plugin without diagnostics.json has no diagnostic declaration.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return failure(format!("{}: {error}", file.display())),
                Ok(text) => match RawValue::from_string(compact(&text)) {
                    Ok(raw) if serde_json::from_str::<serde_json::Value>(raw.get()).is_ok() => {
                        entry.diagnostics = Some(raw)
                    }
                    _ => return failure(format!("{} is not valid JSON", file.display())),
                },
            }
        }
        entries.push(entry);
    }
    #[derive(Serialize)]
    struct Document {
        plugins: Vec<Entry>,
    }
    match serde_json::to_vec(&Document { plugins: entries }) {
        Ok(data) => data,
        Err(error) => failure(error.to_string()),
    }
}

/// What /modules/<package>/<path> points to.
#[derive(Debug, PartialEq)]
pub enum Module {
    /// The package of the application frontend.
    Frontend,
    /// A package of an enabled installed plugin, but the file is missing or the path is wrong.
    Missing,
    /// A file of an enabled installed plugin.
    File(PathBuf),
}

/// The file at a relative path inside a package when every part of the path is a name and the file is a regular file.
fn inside_package(dir: &Path, parts: &[&str]) -> Module {
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Module::Missing;
    }
    let file = parts
        .iter()
        .fold(dir.to_path_buf(), |path, part| path.join(part));
    if file.is_file() {
        Module::File(file)
    } else {
        Module::Missing
    }
}

/// The path prefix that serves the shared modules of extension points.
pub const SHARED_PREFIX: &str = "/shared/";

/// Returns the file that extends.<point>.modules of the plugin.json of the enabled installed plugin maps the specifier
/// of /shared/<plugin id>.<point>/<specifier>.js to. The path ends in .js because the webview protocol takes the MIME
/// type of a module from its path. Another path is Frontend. A path without .js, a point that the plugin does not
/// declare, a specifier that the point does not map, a missing file and a path outside the package are Missing.
pub fn installed_shared(config_dir: &Path, url_path: &str) -> Result<Module, String> {
    #[derive(serde::Deserialize)]
    struct Point {
        // default: a point without shared modules has no modules.
        #[serde(default)]
        modules: std::collections::BTreeMap<String, String>,
    }
    #[derive(serde::Deserialize)]
    struct Manifest {
        // default: the plugin.json of a plugin that declares no extension point has no extends.
        #[serde(default)]
        extends: std::collections::BTreeMap<String, Point>,
    }
    let Some(rest) = url_path.strip_prefix(SHARED_PREFIX) else {
        return Ok(Module::Frontend);
    };
    let Some(((id, point), specifier)) = rest
        .split_once('/')
        .and_then(|(key, file)| Some((key.split_once('.')?, file.strip_suffix(".js")?)))
        .filter(|(_, specifier)| !specifier.is_empty())
    else {
        return Ok(Module::Missing);
    };
    let (plugins, _) = enabled_plugins(config_dir)?;
    let Some(plugin) = plugins.iter().find(|plugin| plugin.id == id) else {
        return Ok(Module::Missing);
    };
    let file = plugin.dir.join("plugin.json");
    let text =
        std::fs::read_to_string(&file).map_err(|error| format!("{}: {error}", file.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", file.display()))?;
    let Some(target) = manifest
        .extends
        .get(point)
        .and_then(|point| point.modules.get(specifier))
    else {
        return Ok(Module::Missing);
    };
    let parts: Vec<&str> = target.split('/').collect();
    Ok(inside_package(&plugin.dir, &parts))
}

/// Returns the path when /modules/<package>/<path> is a file of an enabled installed plugin.
pub fn installed_module(config_dir: &Path, url_path: &str) -> Result<Module, String> {
    let Some(rest) = url_path.strip_prefix("/modules/") else {
        return Ok(Module::Frontend);
    };
    let parts: Vec<&str> = rest.split('/').collect();
    let count = if parts[0].starts_with('@') { 2 } else { 1 };
    if parts.len() <= count {
        return Ok(Module::Frontend);
    }
    let name = parts[..count].join("/");
    let (plugins, _) = enabled_plugins(config_dir)?;
    let Some(plugin) = plugins.iter().find(|plugin| plugin.package == name) else {
        return Ok(Module::Frontend);
    };
    Ok(inside_package(&plugin.dir, &parts[count..]))
}

/// Returns the sidecars that the plugin.json dependencies of an enabled installed plugin specify, together with the
/// folder that the installation recorded.
/// A dependency that names the package of an installed plugin is not a sidecar.
pub fn installed_sidecars(config_dir: &Path) -> Result<Vec<SidecarDeclaration>, String> {
    #[derive(serde::Deserialize)]
    struct Manifest {
        // default: the plugin.json of a plugin that uses no sidecar has no dependencies.
        // They are read in name order so that both hosts declare the sidecars in the same order.
        #[serde(default)]
        dependencies: std::collections::BTreeMap<String, String>,
    }
    let (plugins, state) = enabled_plugins(config_dir)?;
    let mut names = std::collections::BTreeSet::new();
    for plugin in state.plugins.values() {
        names.insert(soksak_sok::plugins::installed_name(config_dir, plugin)?);
    }
    let mut declarations: Vec<SidecarDeclaration> = vec![];
    for plugin in plugins {
        let file = plugin.dir.join("plugin.json");
        let text = std::fs::read_to_string(&file)
            .map_err(|error| format!("{}: {error}", file.display()))?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|error| format!("{}: {error}", file.display()))?;
        for name in manifest.dependencies.into_keys() {
            // The package of an installed plugin is a plugin dependency, so it is not declared as a sidecar.
            if declarations.iter().any(|item| item.name == name) || names.contains(&name) {
                continue;
            }
            let sidecar = state.sidecars.get(&name).ok_or_else(|| {
                format!(
                    "{}: sidecar {name} has no installed version",
                    file.display()
                )
            })?;
            let folder = config_dir.join(&sidecar.path);
            let declaration = folder.join("sidecar.json");
            let data = std::fs::read(&declaration)
                .map_err(|error| format!("{}: {error}", declaration.display()))?;
            declarations.push(SidecarDeclaration {
                name,
                folder,
                data,
                version: sidecar.version.clone(),
            });
        }
    }
    Ok(declarations)
}

/// A provider without any asset. It is kept in Context while the frontend assets are moved to InstalledAssets.
pub struct NoAssets;

impl<R: tauri::Runtime> tauri::Assets<R> for NoAssets {
    fn get(&self, _key: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(
        &self,
        _html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The asset provider that provides the installed plugins. The application frontend provides the other paths. The setup
/// of the host decides the configuration folder.
pub struct InstalledAssets<R: tauri::Runtime> {
    pub frontend: Box<dyn tauri::Assets<R>>,
    pub config_dir: Arc<OnceLock<PathBuf>>,
    pub diagnostics: bool,
}

impl<R: tauri::Runtime> tauri::Assets<R> for InstalledAssets<R> {
    fn get(&self, key: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        let path = key.as_ref();
        let Some(config_dir) = self.config_dir.get() else {
            log_error(path, "the configuration directory is not ready");
            return None;
        };
        if path == INSTALLED_PLUGINS_PATH {
            return Some(Cow::Owned(installed_plugins_document(
                config_dir,
                self.diagnostics,
            )));
        }
        let module = if path.starts_with(SHARED_PREFIX) {
            installed_shared(config_dir, path)
        } else {
            installed_module(config_dir, path)
        };
        match module {
            Ok(Module::Frontend) => self.frontend.get(key),
            Ok(Module::Missing) => None,
            Ok(Module::File(file)) => match std::fs::read(&file) {
                Ok(data) => Some(Cow::Owned(data)),
                Err(error) => {
                    log_error(path, format!("{}: {error}", file.display()));
                    None
                }
            },
            Err(error) => {
                log_error(path, error);
                None
            }
        }
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        self.frontend.iter()
    }

    fn csp_hashes(
        &self,
        html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        self.frontend.csp_hashes(html_path)
    }
}
