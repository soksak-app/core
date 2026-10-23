//! Provides the plugins installed in the configuration folder to the page and finds their sidecars (the provision of
//! installed plugins in docs/spec/installation.md). A file is read only from the folder that the installation recorded
//! in installed.json. The installation state is read at every request, so a page loaded after a change sees that
//! change. The format check uses the implementation of the command line sok.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::value::RawValue;
use soksak_sok::install::{InstalledState, PluginFiles};

use crate::application_log::log_error;
use crate::platform::CoreRootHost;
use crate::sidecars::SidecarDeclaration;

/// The path through which the page reads the list of installed plugins.
pub const INSTALLED_PLUGINS_PATH: &str = "/installed-plugins.json";

/// One enabled installed plugin, its file folder and its plugin.json in compact form.
struct InstalledPlugin {
    id: String,
    package: String,
    version: String,
    dir: PathBuf,
    manifest: Box<RawValue>,
}

/// Returns the enabled installed plugins in id order. The installation folder is recorded as a path relative to the
/// configuration folder, and the conversion report of a format 1 file is written to the standard error, which is the
/// application log (docs/spec/installation.md).
fn enabled_plugins(config_dir: &Path) -> Result<(Vec<InstalledPlugin>, InstalledState), String> {
    let (state, mut manifests) = soksak_sok::plugins::read_installed_manifests(config_dir)?;
    let mut plugins = vec![];
    for (id, plugin) in &state.plugins {
        if !plugin.enabled {
            continue;
        }
        let manifest = manifests
            .remove(id)
            .ok_or_else(|| format!("plugin {id} has no installed manifest"))?;
        plugins.push(InstalledPlugin {
            id: id.clone(),
            package: soksak_sok::plugins::installed_name(config_dir, plugin)?,
            version: plugin.version.clone(),
            dir: config_dir.join(&plugin.path),
            manifest: manifest.compact,
        });
    }
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((plugins, state))
}

/// The folder of the enabled installed plugin, which the document regions of its surfaces serve at
/// soksak://<plugin>/ (docs/spec/native-surfaces.md#document-regions).
pub fn plugin_folder(config_dir: &Path, plugin: &str) -> Result<PathBuf, String> {
    let (plugins, _) = enabled_plugins(config_dir)?;
    plugins
        .into_iter()
        .find(|entry| entry.id == plugin)
        .map(|entry| entry.dir)
        .ok_or_else(|| format!("plugin {plugin} is not installed and enabled"))
}

/// The sidecar facts of the installed plugins: plugin id, then sidecar name, then the kept fields of sidecar.json.
type SidecarFacts = BTreeMap<String, BTreeMap<String, serde_json::Map<String, serde_json::Value>>>;

/// The sidecar facts of each installed plugin, by plugin id and then by sidecar name: the message form and the host read
/// operations of the sidecar.json of each sidecar dependency (docs/spec/sidecars.md#messages). Only those two fields are
/// kept; the page validates them. A plugin without sidecar dependencies has no entry.
fn sidecar_facts(config_dir: &Path) -> Result<SidecarFacts, String> {
    let mut facts: SidecarFacts = BTreeMap::new();
    for declaration in installed_sidecars(config_dir)? {
        let file = declaration.folder.join("sidecar.json");
        let value: serde_json::Value = serde_json::from_slice(&declaration.data)
            .map_err(|error| format!("{}: {error}", file.display()))?;
        let serde_json::Value::Object(object) = value else {
            return Err(format!("{}: expected an object", file.display()));
        };
        let kept: serde_json::Map<String, serde_json::Value> = object
            .into_iter()
            .filter(|(key, _)| key == "message" || key == "hostReadOperations")
            .collect();
        for plugin in &declaration.dependents {
            facts
                .entry(plugin.clone())
                .or_default()
                .insert(declaration.name.clone(), kept.clone());
        }
    }
    Ok(facts)
}

/// The content of /installed-plugins.json. For each plugin it holds the installed plugin.json as the manifest, so that
/// the page registers the plugins before the first screen, and the facts of its sidecar dependencies. When the installation
/// state cannot be read, it is an { "error" } document.
pub fn installed_plugins_document(config_dir: &Path, diagnostics: bool) -> Vec<u8> {
    #[derive(Serialize)]
    struct Entry {
        id: String,
        package: String,
        version: String,
        manifest: Box<RawValue>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sidecars: Option<BTreeMap<String, serde_json::Map<String, serde_json::Value>>>,
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
    let mut facts = match sidecar_facts(config_dir) {
        Ok(facts) => facts,
        Err(error) => return failure(error),
    };
    let mut entries = vec![];
    for plugin in plugins {
        let mut entry = Entry {
            sidecars: facts.remove(&plugin.id),
            id: plugin.id,
            package: plugin.package,
            version: plugin.version,
            manifest: plugin.manifest,
            diagnostics: None,
        };
        if diagnostics {
            let file = plugin.dir.join("diagnostics.json");
            match std::fs::read_to_string(&file) {
                // default: a plugin without diagnostics.json has no diagnostic declaration.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return failure(format!("{}: {error}", file.display())),
                Ok(text) => match RawValue::from_string(soksak_sok::plugins::compact_json(&text)) {
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

/// A file that the core root serves to a view: its content and its content type.
#[derive(Debug, PartialEq)]
pub struct CoreRootFile {
    pub data: Vec<u8>,
    pub content_type: &'static str,
}

/// The file of the bundled frontend that lists the core targets of the view import map. The staging tool writes it from
/// viewCoreTargets of @soksak/plugin-api (CORE_ROOT_FILE), so the host holds no copy of the list.
const CORE_ROOT_FILE: &str = "core-root.json";

/// Reads the core targets of the view import map from core-root.json of the bundled frontend. A missing file, a file that
/// is not a JSON array of core target paths, or a path outside /modules is an error.
fn core_root_targets(frontend: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Vec<String>, String> {
    let data = frontend(CORE_ROOT_FILE).ok_or_else(|| {
        format!("{CORE_ROOT_FILE}: the core targets are missing from the bundled frontend")
    })?;
    let paths: Vec<String> = serde_json::from_slice(&data)
        .map_err(|_| format!("{CORE_ROOT_FILE}: expected a JSON array of core target paths"))?;
    if let Some(path) = paths.iter().find(|path| !path.starts_with("/modules/")) {
        return Err(format!(
            "{CORE_ROOT_FILE}: {path:?} is not a core target path"
        ));
    }
    Ok(paths)
}

/// Returns the file at url_path of the core root for a view of plugin (docs/spec/plugin-processes.md, rule 4). A core
/// target is read from the bundled frontend, which frontend gives by its name without a leading slash. Any other path is
/// read from an installed plugin folder only when the granted item rule (granted_files) grants it to plugin; the rule
/// reads the installation record at each request. Ok(None) is a refused path, and the refusal is written as an error
/// record. An error is returned when the declarations are malformed, or when a core target or a granted file is missing
/// or unreadable.
pub fn core_root(
    config_dir: &Path,
    plugin: &str,
    url_path: &str,
    frontend: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<Option<CoreRootFile>, String> {
    let targets = core_root_targets(frontend)?;
    let (plugins, state) = enabled_plugins(config_dir)?;
    if !plugins.iter().any(|entry| entry.id == plugin) {
        return Ok(refuse_core_root(url_path, plugin));
    }
    if targets.iter().any(|target| target == url_path) {
        let name = url_path.trim_start_matches('/');
        let data = frontend(name).ok_or_else(|| {
            format!("{url_path}: the core file is missing from the bundled frontend")
        })?;
        return Ok(Some(CoreRootFile {
            data,
            content_type: core_content_type(url_path),
        }));
    }
    let mut files = BTreeMap::new();
    for entry in &plugins {
        let manifest_file = entry.dir.join("plugin.json");
        let text = std::fs::read_to_string(&manifest_file)
            .map_err(|error| format!("{}: {error}", manifest_file.display()))?;
        let manifest: serde_json::Value = serde_json::from_str(&text)
            .map_err(|error| format!("{}: {error}", manifest_file.display()))?;
        files.insert(
            entry.id.clone(),
            PluginFiles {
                package: entry.package.clone(),
                manifest,
            },
        );
    }
    let granted = soksak_sok::install::granted_files(&state, &files, plugin)?;
    if !granted.iter().any(|path| path == url_path) {
        return Ok(refuse_core_root(url_path, plugin));
    }
    let module = if url_path.starts_with(SHARED_PREFIX) {
        installed_shared(config_dir, url_path)?
    } else {
        installed_module(config_dir, url_path)?
    };
    let Module::File(file) = module else {
        return Err(format!(
            "{url_path} is granted to {plugin}, but its file is missing"
        ));
    };
    let data = std::fs::read(&file).map_err(|error| format!("{}: {error}", file.display()))?;
    Ok(Some(CoreRootFile {
        data,
        content_type: core_content_type(url_path),
    }))
}

/// Registers the core root resolver of the configuration folder with the platform. The resolver answers each request of a view
/// with core_root, and an error of core_root is written to the application log and answered not found.
/// The bundled frontend as the core root reads it: the bytes of a file by its name without a leading slash.
pub type CoreFrontend = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

pub fn register_core_root(
    platform: &dyn CoreRootHost,
    config_dir: PathBuf,
    frontend: CoreFrontend,
) -> Result<(), String> {
    platform.set_core_root(Box::new(move |plugin, url_path| {
        match core_root(&config_dir, plugin, url_path, &*frontend) {
            Ok(file) => file,
            Err(error) => {
                log_error("core root", error);
                None
            }
        }
    }))
}

/// Writes the refusal of url_path for plugin as an error record and returns the not found result.
fn refuse_core_root(url_path: &str, plugin: &str) -> Option<CoreRootFile> {
    log_error(
        "core root",
        format!("{url_path} is not granted to {plugin}"),
    );
    None
}

/// Returns the content type of a core root file by its extension. The table is fixed, so that both hosts give a file the
/// same type.
fn core_content_type(url_path: &str) -> &'static str {
    match Path::new(url_path)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("js" | "mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("html") => "text/html",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
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
            if names.contains(&name) {
                continue;
            }
            // A sidecar that several plugins list is declared once, and each of them is one of its dependents.
            if let Some(item) = declarations.iter_mut().find(|item| item.name == name) {
                item.dependents.push(plugin.id.clone());
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
                dependents: vec![plugin.id.clone()],
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
    pub frontend: Arc<dyn tauri::Assets<R>>,
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

/// Gives the writer the classes that the catalogs of the enabled installed plugins declare, and records each catalog that it
/// cannot use as an error of the place plugin catalog (docs/spec/logging.md#plugin-catalogs). The host applies it when it starts
/// and after each change of the installed plugins.
pub fn apply_plugin_event_classes(log: &crate::event_log::EventLog, config_dir: &Path) {
    let (classes, errors) = soksak_sok::plugin_catalog::plugin_event_classes(config_dir);
    log.set_plugin_classes(classes);
    for error in errors {
        log_error("plugin catalog", error);
    }
}

/// The file of the bundled frontend that holds the view import map. The staging tool writes it from VIEW_IMPORTS of
/// @soksak/plugin-api (VIEW_IMPORTS_FILE), so the host holds no copy of the map.
const VIEW_IMPORTS_FILE: &str = "view-imports.json";

/// Sets the view import map of the application from view-imports.json of the bundled frontend. The native view handler inserts the
/// map into each view page (docs/spec/plugin-processes.md, rule 4). A missing file is an error.
pub fn register_view_import_map(
    platform: &dyn CoreRootHost,
    frontend: CoreFrontend,
) -> Result<(), String> {
    let data = (*frontend)(VIEW_IMPORTS_FILE).ok_or_else(|| {
        format!("{VIEW_IMPORTS_FILE}: the view import map is missing from the bundled frontend")
    })?;
    let text = String::from_utf8(data).map_err(|error| {
        format!("{VIEW_IMPORTS_FILE}: the view import map is not UTF-8: {error}")
    })?;
    platform.set_view_import_map(&text)
}
