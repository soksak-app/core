//! Installs and changes plugins in the configuration folder (docs/spec/cli.md, docs/spec/installation.md). The command unpacks a release into a temporary folder,
//! renames it into place, and changes installed.json once at the end, so a failed installation does not change the
//! previous installation.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::fetch::{Fetcher, check_location};
use crate::install::{
    self, INSTALL_FORMAT, INSTALLED, Index, InstalledPlugin, InstalledSidecar, InstalledState,
    Need, Release, SelectedSidecar, Selection,
};
use crate::platform;
use crate::registry::{read_release, release_files};
use crate::release::{current_platform, print_json, replace_file};
use crate::{Error, Options, config_dir_of};

/// The file in the configuration folder that holds the address of the registry index that installation reads.
pub const REGISTRY_FILE: &str = "plugins/registry.json";
/// The file in the configuration folder that holds the first-run starter job.
pub const STARTER_JOB_FILE: &str = "plugins/starter.json";
pub const STARTER_JOB_FORMAT: u64 = 1;

/// An absolute `file:` URL. Path characters that have a meaning in a URL, and spaces, are written as %XX.
fn file_url(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not a UTF-8 path", path.display()))?;
    let mut out = String::from("file://");
    for byte in text.bytes() {
        if byte == b'%' || byte == b'?' || byte == b'#' || byte <= b' ' || byte >= 0x7f {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push(char::from(byte));
        }
    }
    Ok(out)
}

/// Reads and checks a registry index given as a path, a `file:` URL or an `https:` URL. A path becomes its absolute `file:` URL. The returned
/// address is the URL of the index that was read.
pub fn read_index_at(location: &str, fetcher: &Fetcher) -> Result<(Index, String), String> {
    let url = if location.contains(':') {
        location.to_string()
    } else {
        let path = std::path::absolute(location).map_err(|error| format!("{location}: {error}"))?;
        file_url(&path)?
    };
    let data = fetcher.read(&url, fetcher.index)?;
    // For file: the error names the path, and for https: it names the URL.
    let shown = if url.starts_with("file:") {
        install::file_path(&url)?
    } else {
        url.clone()
    };
    let value: Value = serde_json::from_slice(&data)
        .map_err(|error| format!("{shown} is not valid JSON: {error}"))?;
    let index =
        install::validate_registry_index(&value).map_err(|error| format!("{shown}: {error}"))?;
    Ok((index, url))
}

/// Checks the registry index and writes its address to plugins/registry.json.
pub fn use_registry(
    config_dir: &Path,
    location: &str,
    fetcher: &Fetcher,
) -> Result<String, String> {
    let (_, url) = read_index_at(location, fetcher)?;
    let path = config_dir.join(REGISTRY_FILE);
    create_parent(&path)?;
    let text = format!("{}\n", json!({"format": INSTALL_FORMAT, "index": url}));
    replace_file(&path, text.as_bytes())?;
    Ok(url)
}

fn create_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| crate::files::file_error(parent.display(), &error))
}

/// Reads the index that plugins/registry.json specifies.
pub(crate) fn read_registry(config_dir: &Path) -> Result<Index, String> {
    let Some(url) = read_registry_url(config_dir)? else {
        return Err(format!(
            "{} does not exist; run sok registry use <index.json>",
            config_dir.join(REGISTRY_FILE).display()
        ));
    };
    Ok(read_index_at(&url, &Fetcher::default())?.0)
}

/// Reads the index address of plugins/registry.json. It is None when the file does not exist.
fn read_registry_url(config_dir: &Path) -> Result<Option<String>, String> {
    let path = config_dir.join(REGISTRY_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    let map = value
        .as_object()
        .ok_or(format!("{REGISTRY_FILE}: expected an object"))?;
    if let Some(key) = map
        .keys()
        .filter(|key| *key != "format" && *key != "index")
        .min()
    {
        return Err(format!("{REGISTRY_FILE}: unknown field {key}"));
    }
    if map.get("format").and_then(Value::as_u64) != Some(INSTALL_FORMAT) {
        return Err(format!("{REGISTRY_FILE}: format must be {INSTALL_FORMAT}"));
    }
    let url = map.get("index").and_then(Value::as_str).ok_or(format!(
        "{REGISTRY_FILE}: index must be an https: or absolute file: URL"
    ))?;
    check_location(url).map_err(|error| format!("{REGISTRY_FILE}: {error}"))?;
    Ok(Some(url.to_string()))
}

/// The registry and the installation state that the application uses for the plugin list
/// (docs/spec/installation.md#plugin-operations-in-the-application). The structure is written as it is, so the key order is the declaration order.
#[derive(serde::Serialize)]
pub struct PluginsState {
    pub registry: Option<String>,
    pub index: IndexState,
    pub installed: InstalledState,
    /// True when plugins/installed.json does not exist. The application installs the starter pack then.
    #[serde(rename = "firstRun")]
    pub first_run: bool,
    pub starter: Option<StarterJob>,
}

/// The durable snapshot of a starter pack installation.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct StarterJob {
    pub format: u64,
    pub state: String,
    pub pack: String,
    pub registry: String,
    pub plugins: Vec<String>,
}

/// The requested state transition of pluginsStarter.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct StarterJobRequest {
    pub state: String,
    pub pack: String,
    pub registry: String,
    pub plugins: Vec<String>,
}

/// Missing when there is no registry, Checked when the index was read and checked, and the error when it could not be read or checked.
#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum IndexState {
    Missing,
    Checked(Index),
    Failed { error: String },
}

/// Reads the registry address, the checked index and the installation state. When the index cannot be read, the error is placed in the index
/// field, and when the installation state cannot be read, the function fails.
pub fn read_plugins_state(config_dir: &Path) -> Result<PluginsState, String> {
    let installed = read_installed(config_dir)?;
    let starter = read_starter_job(config_dir)?;
    let first_run = !config_dir
        .join(INSTALLED)
        .try_exists()
        .map_err(|error| crate::files::file_error(config_dir.join(INSTALLED).display(), &error))?;
    let (registry, index) = match read_registry_url(config_dir) {
        Err(error) => (None, IndexState::Failed { error }),
        Ok(None) => (None, IndexState::Missing),
        Ok(Some(url)) => {
            let index = match read_index_at(&url, &Fetcher::default()) {
                Ok((index, _)) => IndexState::Checked(index),
                Err(error) => IndexState::Failed { error },
            };
            (Some(url), index)
        }
    };
    Ok(PluginsState {
        registry,
        index,
        installed,
        first_run,
        starter,
    })
}

/// Reads the durable starter job. Absence means that there is no pending or completed job.
pub fn read_starter_job(config_dir: &Path) -> Result<Option<StarterJob>, String> {
    let path = config_dir.join(STARTER_JOB_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("{} is not valid JSON", path.display()))?;
    validate_starter_job(&value)
        .map(Some)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Checks the current on-disk starter job form.
pub fn validate_starter_job(value: &Value) -> Result<StarterJob, String> {
    let root = value
        .as_object()
        .ok_or_else(|| format!("{STARTER_JOB_FILE}: expected object"))?;
    if root.len() != 5
        || root
            .keys()
            .any(|key| !["format", "state", "pack", "registry", "plugins"].contains(&key.as_str()))
    {
        return Err(format!(
            "{STARTER_JOB_FILE}: expected only format, state, pack, registry and plugins"
        ));
    }
    if root.get("format").and_then(Value::as_u64) != Some(STARTER_JOB_FORMAT) {
        return Err(format!(
            "{STARTER_JOB_FILE}: format must be {STARTER_JOB_FORMAT}"
        ));
    }
    let state = root
        .get("state")
        .and_then(Value::as_str)
        .filter(|state| *state == "pending" || *state == "complete")
        .ok_or_else(|| format!("{STARTER_JOB_FILE} state: must be pending or complete"))?;
    let pack = root
        .get("pack")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{STARTER_JOB_FILE} pack: must be a non-empty string"))?;
    let registry = root
        .get("registry")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{STARTER_JOB_FILE} registry: must be a non-empty URL"))?;
    check_location(registry).map_err(|error| format!("{STARTER_JOB_FILE} registry: {error}"))?;
    let values = root
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{STARTER_JOB_FILE} plugins: expected array"))?;
    let mut plugins = Vec::with_capacity(values.len());
    let mut seen = BTreeSet::new();
    for value in values {
        let id = value
            .as_str()
            .filter(|id| crate::install::is_identifier(id))
            .ok_or_else(|| {
                format!("{STARTER_JOB_FILE} plugins: id must be a lowercase identifier")
            })?;
        if !seen.insert(id) {
            return Err(format!("{STARTER_JOB_FILE} plugins: duplicate id {id}"));
        }
        plugins.push(id.to_string());
    }
    Ok(StarterJob {
        format: STARTER_JOB_FORMAT,
        state: state.to_string(),
        pack: pack.to_string(),
        registry: registry.to_string(),
        plugins,
    })
}

/// Creates a starter snapshot or completes that exact snapshot.
pub fn write_starter_job(
    config_dir: &Path,
    request: StarterJobRequest,
) -> Result<StarterJob, String> {
    let request_value = serde_json::to_value(&request).map_err(|error| error.to_string())?;
    let mut request_object = request_value
        .as_object()
        .cloned()
        .ok_or_else(|| "starter job request must be an object".to_string())?;
    request_object.insert("format".to_string(), json!(STARTER_JOB_FORMAT));
    let requested = validate_starter_job(&Value::Object(request_object))?;
    let current_registry = read_registry_url(config_dir)?;
    if current_registry.as_deref() != Some(requested.registry.as_str()) {
        return Err("starter job registry does not match the current registry".to_string());
    }
    let existing = read_starter_job(config_dir)?;
    let installed = read_installed(config_dir)?;
    let path = config_dir.join(STARTER_JOB_FILE);
    match existing.as_ref() {
        None => {
            if requested.state != "pending" {
                return Err("starter job can only start as pending".to_string());
            }
            match config_dir.join(INSTALLED).try_exists() {
                Ok(false) => {}
                Ok(true) => {
                    return Err(
                        "starter job cannot start after plugin installation has begun".to_string(),
                    );
                }
                Err(error) => {
                    return Err(crate::files::file_error(
                        config_dir.join(INSTALLED).display(),
                        &error,
                    ));
                }
            }
        }
        Some(existing) => {
            if existing.pack != requested.pack
                || existing.registry != requested.registry
                || existing.plugins != requested.plugins
            {
                return Err("starter job request does not match the stored snapshot".to_string());
            }
            if existing.state == "complete" {
                if requested.state == "complete" {
                    return Ok(existing.clone());
                }
                return Err("completed starter job cannot be reset".to_string());
            }
            if requested.state == "pending" {
                return Ok(existing.clone());
            }
        }
    }
    if requested.state == "complete" {
        for id in &requested.plugins {
            if !installed.plugins.contains_key(id) {
                return Err(format!(
                    "starter job cannot complete: plugin {id} is not installed"
                ));
            }
        }
    }
    let mut out = vec![];
    print_json(&mut out, &requested)?;
    create_parent(&path)?;
    replace_file(&path, &out)?;
    Ok(requested)
}

/// The output of sok plugin <action> <id>. install and update output the installation result, and the others output a plugin entry or null.
#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum PluginActionResult {
    Installed(PluginResult),
    Changed(Option<InstalledPlugin>),
}

/// Runs the same operation as sok plugin <action> <id> and returns its output.
/// action is one of install, update, remove, enable and disable.
pub fn run_plugin_action(
    config_dir: &Path,
    action: &str,
    id: &str,
    core: &str,
    platform: &str,
) -> Result<PluginActionResult, String> {
    // The hosts call this inside their own ownership of the configuration directory, so it takes no lock; the command
    // line entry owns the directory for the duration of the write (docs/spec/installation.md).
    match action {
        "install" | "update" => Ok(PluginActionResult::Installed(install_plugin(
            config_dir,
            id,
            core,
            platform,
            action == "update",
        )?)),
        "remove" | "enable" | "disable" => Ok(PluginActionResult::Changed(change_plugin(
            config_dir, id, action,
        )?)),
        _ => Err(format!("unknown plugin action {action:?}")),
    }
}

/// The plugin.json of an installed plugin. read_installed_manifests reads and parses it once, and the dependency and document
/// code use this value.
pub struct InstalledManifest {
    /// The plugin.json text with the whitespace outside strings removed; the key order is kept.
    pub compact: Box<RawValue>,
    /// The parsed plugin.json.
    pub value: Value,
}

/// Reads plugins/installed.json. When the file does not exist, nothing is installed. A file that is not in the current format is
/// an error (docs/spec/installation.md).
pub fn read_installed(config_dir: &Path) -> Result<InstalledState, String> {
    read_installed_manifests(config_dir).map(|(state, _)| state)
}

/// Reads plugins/installed.json and the plugin.json of each installed plugin, each once. It returns the state and the manifest of
/// each installed plugin by id.
pub fn read_installed_manifests(
    config_dir: &Path,
) -> Result<(InstalledState, BTreeMap<String, InstalledManifest>), String> {
    // The entry of the shared reader migrates the file to the current format first, so every reader in every process
    // finds the current form (docs/spec/installation.md#stored-data-migration).
    crate::migrate::migrate_installed(config_dir)?;
    let path = config_dir.join(INSTALLED);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((InstalledState::empty(), BTreeMap::new()));
        }
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let value: Value =
        serde_json::from_str(&text).map_err(|_| format!("{} is not valid JSON", path.display()))?;
    let state = install::validate_installed(&value)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let mut manifests = BTreeMap::new();
    for (id, plugin) in &state.plugins {
        let file = manifest_file(config_dir, plugin);
        let data = match std::fs::read(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!(
                    "{}: the plugin manifest is missing",
                    file.display()
                ));
            }
            other => other.map_err(|error| crate::files::file_error(file.display(), &error))?,
        };
        let location = file.display().to_string();
        let manifest = parse_manifest(&location, &data)?;
        install::check_plugin_id(id, &manifest).map_err(|error| format!("{location}: {error}"))?;
        let invalid = || format!("{location} is not valid JSON");
        let text = std::str::from_utf8(&data).map_err(|_| invalid())?;
        let compact = RawValue::from_string(compact_json(text)).map_err(|_| invalid())?;
        manifests.insert(
            id.clone(),
            InstalledManifest {
                compact,
                value: manifest,
            },
        );
        AFTER_MANIFEST_READ.with(|slot| {
            if let Some(hook) = slot.borrow().as_ref() {
                hook(&file);
            }
        });
    }
    Ok((state, manifests))
}

/// The plugin.json in the recorded folder of an installed plugin.
fn manifest_file(config_dir: &Path, plugin: &InstalledPlugin) -> PathBuf {
    config_dir.join(&plugin.path).join("plugin.json")
}

/// Removes the whitespace outside strings from JSON text. The key order and the strings stay as they are.
pub fn compact_json(text: &str) -> String {
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

/// The fault hook of read_installed_manifests: it receives the location of each plugin.json after the reader checks it.
type ManifestHook = Box<dyn Fn(&Path)>;

thread_local! {
    // The fault hook of the reader. It runs on the calling thread after read_installed reads and checks a plugin.json.
    static AFTER_MANIFEST_READ: RefCell<Option<ManifestHook>> = const { RefCell::new(None) };
}

/// Sets the fault hook that runs after read_installed reads and checks each plugin.json on the calling thread. Tests use
/// it to change a file between two reads; None removes the hook.
pub fn set_after_manifest_read(hook: Option<ManifestHook>) {
    AFTER_MANIFEST_READ.with(|slot| *slot.borrow_mut() = hook);
}

/// Changes installed.json once.
pub(crate) fn write_installed(config_dir: &Path, state: &InstalledState) -> Result<(), String> {
    let mut out = vec![];
    print_json(&mut out, state)?;
    let path = config_dir.join(INSTALLED);
    create_parent(&path)?;
    replace_file(&path, &out)
}

/// Unpacks a tar.gz release into a temporary folder next to target, then renames it to target. It accepts only regular files and folders and rejects absolute paths and
/// `..`.
fn extract(data: &[u8], target: &Path) -> Result<(), String> {
    create_parent(target)?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no name", target.display()))?;
    let temp = target.with_file_name(format!(".{name}.{}", std::process::id()));
    let result = extract_into(data, &temp).and_then(|()| {
        std::fs::rename(&temp, target)
            .map_err(|error| crate::files::file_error(target.display(), &error))
    });
    result.map_err(|error| {
        crate::files::with_cleanup(error, &temp, |path| std::fs::remove_dir_all(path))
    })
}

fn extract_into(data: &[u8], temp: &Path) -> Result<(), String> {
    std::fs::create_dir_all(temp)
        .map_err(|error| crate::files::file_error(temp.display(), &error))?;
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(data));
    for entry in reader.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let raw = String::from_utf8(entry.path_bytes().into_owned())
            .map_err(|_| "release entry name is not UTF-8".to_string())?;
        // default: a trailing / only marks a folder entry, so the name is used unchanged when there is none.
        let name = raw.strip_suffix('/').unwrap_or(&raw);
        if name.is_empty() || name.starts_with('/') || name.split('/').any(|part| part == "..") {
            return Err(format!("release entry {raw} leaves the folder"));
        }
        let path = temp.join(name);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            std::fs::create_dir_all(&path)
                .map_err(|error| crate::files::file_error(path.display(), &error))?;
            continue;
        }
        if !kind.is_file() {
            return Err(format!(
                "release entry {raw} is neither a regular file nor a folder"
            ));
        }
        let mode = entry.header().mode().map_err(|error| error.to_string())?;
        create_parent(&path)?;
        let mut content = vec![];
        entry
            .read_to_end(&mut content)
            .map_err(|error| error.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| crate::files::file_error(path.display(), &error))?;
        file.write_all(&content)
            .map_err(|error| crate::files::file_error(path.display(), &error))?;
        platform::current()?.set_executable(&path, mode & 0o111 != 0)?;
    }
    Ok(())
}

/// Verifies a release and unpacks it into a version folder that does not exist yet.
fn install_release(at: &str, release: &Release, target: &Path) -> Result<(), String> {
    match std::fs::metadata(target) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(crate::files::file_error(at, &error)),
    }
    let data = read_release(at, release)?;
    extract(&data, target).map_err(|error| format!("{at}: {error}"))
}

/// The output of a plugin installation. The structure is written as it is, so the key order is the declaration order and the bytes match the Go implementation.
#[derive(serde::Serialize)]
pub struct PluginResult {
    plugin: InstalledPlugin,
    sidecars: BTreeMap<String, String>,
}

fn plugin_result(state: &InstalledState, id: &str) -> PluginResult {
    let plugin = state.plugins[id].clone();
    let sidecars = plugin
        .sidecars
        .keys()
        .filter_map(|name| {
            state
                .sidecars
                .get(name)
                .map(|sidecar| (name.clone(), sidecar.version.clone()))
        })
        .collect();
    PluginResult { plugin, sidecars }
}

/// Installs the selected version of a plugin and its plugin dependencies. With update it accepts only an installed
/// plugin. It reads the plugin.json of every selected plugin version and completes the plan before it extracts an
/// release.
pub fn install_plugin(
    config_dir: &Path,
    id: &str,
    core: &str,
    platform: &str,
    update: bool,
) -> Result<PluginResult, String> {
    let index = read_registry(config_dir)?;
    let (state, manifests) = read_installed_manifests(config_dir)?;
    if update && !state.plugins.contains_key(id) {
        return Err(format!("plugin {id} is not installed"));
    }
    let mut plan = DependencyPlan {
        config_dir,
        core,
        platform,
        index: &index,
        state,
        manifests,
        dependencies: BTreeMap::new(),
        providers: BTreeMap::new(),
        releases: BTreeMap::new(),
        order: vec![],
        sidecars: BTreeMap::new(),
        placed: BTreeSet::new(),
        changed: false,
    };
    plan.place(id, false, &[])?;
    let DependencyPlan {
        mut state,
        releases,
        order,
        sidecars,
        changed,
        ..
    } = plan;
    if !changed {
        return Ok(plugin_result(&state, id));
    }
    for changed in &order {
        let Some(data) = releases.get(changed) else {
            continue;
        };
        let plugin = &state.plugins[changed];
        extract(data, &config_dir.join(&plugin.path))
            .map_err(|error| format!("plugin {changed} {} package: {error}", plugin.version))?;
    }
    drop_unnamed_sidecars(&mut state);
    for (name, sidecar) in &sidecars {
        let Some(installed) = state
            .sidecars
            .get(name)
            .filter(|installed| installed.version == sidecar.version)
        else {
            continue;
        };
        install_release(
            &format!("sidecar {} {} {platform}", sidecar.name, sidecar.version),
            &sidecar.release,
            &config_dir.join(&installed.path),
        )?;
    }
    install::validate_installed(&serde_json::to_value(&state).map_err(|error| error.to_string())?)?;
    write_installed(config_dir, &state)?;
    prune_folders(config_dir, &state)?;
    Ok(plugin_result(&state, id))
}

/// The plan that installs a plugin and its plugin dependencies. state is the planned installation state; dependencies
/// holds the plugin.json dependencies of the version in use of each plugin of state; providers holds the plugin
/// dependencies of the versions that the plan selected; releases holds the releases of plugin versions that are not
/// extracted yet; order lists the plugins whose version changed in selection order; sidecars holds the sidecar
/// versions that the plan selected.
struct DependencyPlan<'a> {
    config_dir: &'a Path,
    core: &'a str,
    platform: &'a str,
    index: &'a Index,
    state: InstalledState,
    manifests: BTreeMap<String, InstalledManifest>,
    dependencies: BTreeMap<String, BTreeMap<String, String>>,
    providers: BTreeMap<String, BTreeMap<String, String>>,
    releases: BTreeMap<String, Vec<u8>>,
    order: Vec<String>,
    sidecars: BTreeMap<String, SelectedSidecar>,
    placed: BTreeSet<String>,
    changed: bool,
}

/// Parses a plugin.json text into an object. file is the location for errors. The error names only the file: the parser texts
/// of serde_json and encoding/json differ, so a parser detail would make the hosts report different texts
/// (docs/spec/host-contract.md#installed.plugin-json.invalid-text).
fn parse_manifest(file: &str, data: &[u8]) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(data).map_err(|_| format!("{file} is not valid JSON"))?;
    if !value.is_object() {
        return Err(format!("{file}: expected an object"));
    }
    Ok(value)
}

/// Checks and returns the dependencies of a parsed plugin.json. file is the location for errors.
fn manifest_dependencies_of(file: &str, value: &Value) -> Result<BTreeMap<String, String>, String> {
    install::manifest_dependencies(value).map_err(|error| format!("{file}: {error}"))
}

/// Reads the name of the package.json in the recorded folder of an installed plugin.
pub fn installed_name(config_dir: &Path, plugin: &InstalledPlugin) -> Result<String, String> {
    let file = config_dir.join(&plugin.path).join("package.json");
    let data =
        std::fs::read(&file).map_err(|error| crate::files::file_error(file.display(), &error))?;
    let value: Value = serde_json::from_slice(&data)
        .map_err(|_| format!("{} is not valid JSON", file.display()))?;
    let package = value
        .as_object()
        .ok_or_else(|| format!("{}: package.json: expected an object", file.display()))?;
    install::check_package_json_name("package.json name", package.get("name"))
        .map(str::to_string)
        .map_err(|error| format!("{}: {error}", file.display()))
}

impl DependencyPlan<'_> {
    /// The plugin.json dependencies of the version in use of a planned plugin.
    fn manifest(&mut self, id: &str) -> Result<BTreeMap<String, String>, String> {
        if let Some(dependencies) = self.dependencies.get(id) {
            return Ok(dependencies.clone());
        }
        let installed = self
            .manifests
            .get(id)
            .ok_or_else(|| format!("plugin {id} has no installed manifest"))?;
        let file = manifest_file(self.config_dir, &self.state.plugins[id]);
        let dependencies = manifest_dependencies_of(&file.display().to_string(), &installed.value)?;
        self.dependencies
            .insert(id.to_string(), dependencies.clone());
        Ok(dependencies)
    }

    /// The range of each planned plugin that names the package. The range of id itself is left out.
    fn needs(&mut self, id: &str, package: &str) -> Result<Vec<Need>, String> {
        let mut needs = vec![];
        let others: Vec<String> = self.state.plugins.keys().cloned().collect();
        for other in others.iter().filter(|other| *other != id) {
            if let Some(range) = self.manifest(other)?.get(package) {
                needs.push(Need {
                    who: format!("{other} {}", self.state.plugins[other].version),
                    range: range.clone(),
                });
            }
        }
        Ok(needs)
    }

    /// Adds plugin id to the plan and then each of its plugin dependencies. A provider is a plugin that another
    /// plugin names as a dependency: its installed version is kept when it satisfies every range, and it is enabled
    /// when it is disabled. path lists the plugin ids that the dependencies were followed through.
    fn place(&mut self, id: &str, provider: bool, path: &[String]) -> Result<(), String> {
        if let Some(start) = path.iter().position(|item| item == id) {
            let mut cycle = path[start..].to_vec();
            cycle.push(id.to_string());
            return Err(format!("plugin dependency cycle: {}", cycle.join(" -> ")));
        }
        let index = self.index;
        let current = self.state.plugins.get(id).cloned();
        let package = match index.plugins.iter().find(|entry| entry.id == id) {
            Some(entry) => entry.package.clone(),
            None => match &current {
                Some(plugin) => installed_name(self.config_dir, plugin)?,
                // default: a plugin that neither the index nor installed.json lists has no package, so no plugin
                // names it, and resolve_install reports that it is not in the registry.
                None => String::new(),
            },
        };
        let needs = self.needs(id, &package)?;
        let satisfied = current.as_ref().is_some_and(|plugin| {
            needs
                .iter()
                .all(|need| install::satisfies(&plugin.version, &need.range))
        });
        if self.placed.contains(id) {
            // A version that the plan selected earlier must also satisfy the range of a dependent that was read
            // later.
            if !satisfied {
                return Err(format!(
                    "plugin {id} has no version for core {} that satisfies every installed plugin: {}",
                    self.core,
                    install::needs_text(&needs)
                ));
            }
            return Ok(());
        }
        self.placed.insert(id.to_string());
        if !provider || !satisfied {
            let selection =
                install::resolve_install(index, id, self.core, self.platform, &self.state, &needs)?;
            if current
                .as_ref()
                .is_none_or(|plugin| plugin.version != selection.version.version)
            {
                self.replace(id, current.as_ref(), selection)?;
            }
        }
        if let Some(plugin) = self
            .state
            .plugins
            .get_mut(id)
            .filter(|plugin| provider && !plugin.enabled)
        {
            plugin.enabled = true;
            self.changed = true;
        }
        let providers = match self.providers.get(id) {
            Some(providers) => providers.clone(),
            None => {
                // The plugin dependencies of a plugin that the plan did not change are its dependencies without a
                // recorded sidecar range.
                let sidecars = self.state.plugins[id].sidecars.clone();
                self.manifest(id)?
                    .into_iter()
                    .filter(|(name, _)| !sidecars.contains_key(name))
                    .collect()
            }
        };
        for name in providers.keys() {
            let mut dependency = index
                .plugins
                .iter()
                .find(|entry| &entry.package == name)
                .map(|entry| entry.id.clone());
            if dependency.is_none() {
                for (other, plugin) in &self.state.plugins {
                    if &installed_name(self.config_dir, plugin)? == name {
                        dependency = Some(other.clone());
                        break;
                    }
                }
            }
            let Some(dependency) = dependency else {
                return Err(format!(
                    "{id} {}: dependency {name} is neither a plugin nor a sidecar of the registry",
                    self.state.plugins[id].version
                ));
            };
            let mut next = path.to_vec();
            next.push(id.to_string());
            self.place(&dependency, true, &next)?;
        }
        Ok(())
    }

    /// Adds the selected version of a plugin to the plan. It reads the plugin.json of that version from its
    /// extracted folder, or else from the release after it checks the sha256, and keeps the release for extraction
    /// after the plan is complete.
    fn replace(
        &mut self,
        id: &str,
        current: Option<&InstalledPlugin>,
        selection: Selection,
    ) -> Result<(), String> {
        let version = selection.version.version.clone();
        let at = format!("plugin {id} {version} package");
        let plugin_path = install::plugin_install_path(id, &version)?;
        let folder = self.config_dir.join(&plugin_path);
        let manifest = folder.join("plugin.json");
        let (file, data) = match std::fs::metadata(&folder) {
            Ok(_) => (
                manifest.display().to_string(),
                std::fs::read(&manifest)
                    .map_err(|error| crate::files::file_error(manifest.display(), &error))?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let release = read_release(&at, &selection.version.release)?;
                let mut files = release_files(&release, &["plugin.json"])
                    .map_err(|error| format!("{at}: {error}"))?;
                let data = files
                    .remove("plugin.json")
                    .ok_or_else(|| format!("{at}: the release holds no plugin.json"))?;
                self.releases.insert(id.to_string(), release);
                (format!("{at}: plugin.json"), data)
            }
            Err(error) => return Err(crate::files::file_error(&at, &error)),
        };
        let manifest = parse_manifest(&file, &data)?;
        install::check_plugin_id(id, &manifest).map_err(|error| format!("{file}: {error}"))?;
        crate::manifest::validate_manifest(&manifest)
            .map_err(|error| format!("{file}: {error}"))?;
        let dependencies = manifest_dependencies_of(&file, &manifest)?;
        let (providers, _) =
            install::classify_dependencies(self.index, id, &version, &dependencies)?;
        self.dependencies.insert(id.to_string(), dependencies);
        self.providers.insert(id.to_string(), providers);
        let entry = InstalledPlugin {
            version: version.clone(),
            path: plugin_path,
            enabled: current.is_none_or(|plugin| plugin.enabled),
            sidecars: selection.version.sidecars.clone(),
            previous: current.map(|plugin| plugin.version.clone()),
        };
        self.state.plugins.insert(id.to_string(), entry);
        for sidecar in selection.sidecars {
            let path =
                install::sidecar_install_path(&sidecar.name, &sidecar.version, self.platform)?;
            self.state.sidecars.insert(
                sidecar.name.clone(),
                InstalledSidecar {
                    version: sidecar.version.clone(),
                    path,
                },
            );
            self.sidecars.insert(sidecar.name.clone(), sidecar);
        }
        self.order.push(id.to_string());
        self.changed = true;
        Ok(())
    }
}

/// Removes a sidecar that no plugin specifies.
fn drop_unnamed_sidecars(state: &mut InstalledState) {
    let plugins = &state.plugins;
    state.sidecars.retain(|name, _| {
        plugins
            .values()
            .any(|plugin| plugin.sidecars.contains_key(name))
    });
}

/// The entry names in a folder. The list is empty when the folder does not exist.
fn folder_names(path: &Path) -> Result<Vec<(String, bool)>, String> {
    let listing = match std::fs::read_dir(path) {
        Ok(listing) => listing,
        // default: a configuration folder in which nothing has been installed yet has no such folder.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let mut names = vec![];
    for item in listing {
        let item = item.map_err(|error| crate::files::file_error(path.display(), &error))?;
        let is_dir = item
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir();
        let name = item
            .file_name()
            .into_string()
            .map_err(|name| format!("{name:?} in {} is not a UTF-8 name", path.display()))?;
        names.push((name, is_dir));
    }
    names.sort();
    Ok(names)
}

/// Removes the plugin folders and version folders that are neither the version in use nor the previous version of an installed plugin, and the sidecar folders and
/// version folders that installed.json does not specify. It reports every folder that it could not remove.
fn prune_folders(config_dir: &Path, state: &InstalledState) -> Result<(), String> {
    let mut failures = vec![];
    let mut remove = |path: PathBuf| {
        if let Err(error) = std::fs::remove_dir_all(&path) {
            failures.push(format!("cannot delete {}: {error}", path.display()));
        }
    };
    let plugins = config_dir.join("plugins");
    for (name, is_dir) in folder_names(&plugins)? {
        if !is_dir {
            continue;
        }
        let Some(plugin) = state.plugins.get(&name) else {
            remove(plugins.join(&name));
            continue;
        };
        for (version, _) in folder_names(&plugins.join(&name))? {
            if version != plugin.version && Some(&version) != plugin.previous.as_ref() {
                remove(plugins.join(&name).join(&version));
            }
        }
    }
    let mut kept = HashMap::new();
    for (name, sidecar) in &state.sidecars {
        kept.insert(install::sidecar_file_name(name)?, &sidecar.version);
    }
    let sidecars = config_dir.join("sidecars");
    for (name, _) in folder_names(&sidecars)? {
        let Some(version) = kept.get(&name) else {
            remove(sidecars.join(&name));
            continue;
        };
        for (item, _) in folder_names(&sidecars.join(&name))? {
            if &&item != version {
                remove(sidecars.join(&name).join(&item));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// Removes, enables or disables an installed plugin.
pub fn change_plugin(
    config_dir: &Path,
    id: &str,
    action: &str,
) -> Result<Option<InstalledPlugin>, String> {
    let (mut state, manifests) = read_installed_manifests(config_dir)?;
    let Some(plugin) = state.plugins.get(id) else {
        return Err(format!("plugin {id} is not installed"));
    };
    if action == "remove" || action == "disable" {
        let name = installed_name(config_dir, plugin)?;
        // A plugin whose package another enabled plugin names as a dependency is neither removed nor disabled.
        for (other, dependent) in &state.plugins {
            if other == id || !dependent.enabled {
                continue;
            }
            let installed = manifests
                .get(other)
                .ok_or_else(|| format!("plugin {other} has no installed manifest"))?;
            let file = manifest_file(config_dir, dependent);
            let dependencies =
                manifest_dependencies_of(&file.display().to_string(), &installed.value)?;
            if let Some(range) = dependencies.get(&name) {
                return Err(format!("plugin {id} is required by {other} {range}"));
            }
        }
    }
    if action == "remove" {
        state.plugins.remove(id);
        drop_unnamed_sidecars(&mut state);
    } else if let Some(plugin) = state.plugins.get_mut(id) {
        plugin.enabled = action == "enable";
    }
    write_installed(config_dir, &state)?;
    if action == "remove" {
        prune_folders(config_dir, &state)?;
        return Ok(None);
    }
    Ok(state.plugins.get(id).cloned())
}

/// Runs registry use and plugin install, update, remove, enable, disable and list.
pub(crate) fn run_plugins(
    positionals: &[String],
    values: &HashMap<String, String>,
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let config_dir = config_dir_of(values, options)?;
    // The writing commands own the configuration directory for the duration of their write, so a running host or a
    // second command refuses instead of racing the same files (docs/spec/installation.md).
    let ownership = (positionals[0] == "plugin" && positionals[1] != "list")
        .then(|| crate::ownership::own_configuration(&config_dir))
        .transpose()?;
    let command = format!("{} {}", positionals[0], positionals[1]);
    let want = if command == "plugin list" { 2 } else { 3 };
    if positionals.len() < want {
        return Err(Error::Usage(format!("{command} needs an argument")));
    }
    if let Some(extra) = positionals.get(want) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    let result = (|| {
        match command.as_str() {
            "registry use" => {
                let index = use_registry(&config_dir, &positionals[2], &Fetcher::default())?;
                Ok(print_json(stdout, &json!({"index": index}))?)
            }
            "plugin list" => Ok(print_json(stdout, &read_installed(&config_dir)?)?),
            "plugin install" | "plugin update" | "plugin remove" | "plugin enable"
            | "plugin disable" => {
                let action = positionals[1].as_str();
                // platform is needed only by install and update, which choose a version.
                let platform = if action == "install" || action == "update" {
                    current_platform()?
                } else {
                    String::new()
                };
                let result = run_plugin_action(
                    &config_dir,
                    action,
                    &positionals[2],
                    options.core_version,
                    &platform,
                )?;
                Ok(print_json(stdout, &result)?)
            }
            _ => Err(Error::Usage(format!("unknown command: {command}"))),
        }
    })();
    if let Some(release) = ownership {
        release();
    }
    result
}
