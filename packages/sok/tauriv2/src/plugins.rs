//! 설정 폴더에 plugin 을 설치하고 바꾼다(docs/spec/cli.md, docs/spec/installation.md). archive 는 임시 폴더에 푼
//! 뒤 이름을 바꿔 제자리에 두고, installed.json 은 마지막에 한 번에 바꾸므로 실패한 설치는 이전 설치를 바꾸지
//! 않는다.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::fetch::{check_location, Fetcher};
use crate::install::{
    self, Archive, Index, InstalledPlugin, InstalledSidecar, InstalledState, Need, SelectedSidecar,
    Selection, INSTALLED, INSTALL_FORMAT,
};
use crate::platform;
use crate::registry::{archive_files, read_archive};
use crate::release::{current_platform, print_json, replace_file};
use crate::{config_dir_of, Error, Options};

/// 설정 폴더 안에서 설치가 읽는 registry index 의 주소를 담는 파일.
pub const REGISTRY_FILE: &str = "plugins/registry.json";

/// 절대 경로의 `file:` URL. 경로 문자 중 URL 에서 뜻을 가진 문자와 공백은 %XX 로 쓴다.
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

/// 경로, `file:` URL, `https:` URL 의 registry index 를 읽고 검사한다. 경로는 그 절대 `file:` URL 이 된다. 돌려주는
/// 주소는 읽은 index 의 URL 이다.
pub fn read_index_at(location: &str, fetcher: &Fetcher) -> Result<(Index, String), String> {
    let url = if location.contains(':') {
        location.to_string()
    } else {
        let path = std::path::absolute(location).map_err(|error| format!("{location}: {error}"))?;
        file_url(&path)?
    };
    let data = fetcher.read(&url, fetcher.index)?;
    // 오류는 file: 이면 경로를, https: 면 URL 을 밝힌다.
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

/// registry index 를 검사하고 그 주소를 plugins/registry.json 에 쓴다.
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

/// plugins/registry.json 이 지정한 index 를 읽는다.
fn read_registry(config_dir: &Path) -> Result<Index, String> {
    let Some(url) = read_registry_url(config_dir)? else {
        return Err(format!(
            "{} does not exist; run sok registry use <index.json>",
            config_dir.join(REGISTRY_FILE).display()
        ));
    };
    Ok(read_index_at(&url, &Fetcher::default())?.0)
}

/// plugins/registry.json 의 index 주소를 읽는다. 파일이 없으면 None 이다.
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

/// 애플리케이션이 plugin 목록에 쓰는 registry 와 설치 상태
/// (docs/spec/installation.md#plugin-operations-in-the-application). 구조체 그대로 쓰므로 key 는 선언 순서다.
#[derive(serde::Serialize)]
pub struct PluginsState {
    pub registry: Option<String>,
    pub index: IndexState,
    pub installed: InstalledState,
    /// plugins/installed.json 이 없으면 true 다. 애플리케이션은 이때 starter pack 을 설치한다.
    #[serde(rename = "firstRun")]
    pub first_run: bool,
}

/// registry 가 없으면 Missing, 읽고 검사했으면 Checked, 읽거나 검사하지 못했으면 그 오류다.
#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum IndexState {
    Missing,
    Checked(Index),
    Failed { error: String },
}

/// registry 주소, 검사한 index, 설치 상태를 읽는다. index 를 읽지 못하면 그 오류를 index 자리에
/// 담고, 설치 상태를 읽지 못하면 실패한다.
pub fn read_plugins_state(config_dir: &Path) -> Result<PluginsState, String> {
    let installed = read_installed(config_dir)?;
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
    })
}

/// sok plugin <action> <id> 의 출력. install 과 update 는 설치 결과, 나머지는 plugin 항목이나 null 이다.
#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum PluginActionResult {
    Installed(PluginResult),
    Changed(Option<InstalledPlugin>),
}

/// sok plugin <action> <id> 와 같은 작업을 실행하고 그 출력을 돌려준다.
/// action 은 install, update, remove, enable, disable 중 하나다.
pub fn run_plugin_action(
    config_dir: &Path,
    action: &str,
    id: &str,
    core: &str,
    platform: &str,
) -> Result<PluginActionResult, String> {
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

/// plugins/installed.json 을 읽는다. 파일이 없으면 아무것도 설치하지 않은 상태다. 현재 형식이 아닌 파일은
/// 오류다(docs/spec/installation.md).
pub fn read_installed(config_dir: &Path) -> Result<InstalledState, String> {
    let path = config_dir.join(INSTALLED);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InstalledState::empty())
        }
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    install::validate_installed(&value).map_err(|error| format!("{}: {error}", path.display()))
}

/// installed.json 을 한 번에 바꾼다.
fn write_installed(config_dir: &Path, state: &InstalledState) -> Result<(), String> {
    let mut out = vec![];
    print_json(&mut out, state)?;
    let path = config_dir.join(INSTALLED);
    create_parent(&path)?;
    replace_file(&path, &out)
}

/// tar.gz archive 를 target 옆 임시 폴더에 푼 뒤 이름을 바꿔 target 에 둔다. 일반 파일과 폴더만 받고, 절대 경로와
/// `..` 는 거부한다.
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
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(data));
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let raw = String::from_utf8(entry.path_bytes().into_owned())
            .map_err(|_| "archive entry name is not UTF-8".to_string())?;
        // 기본값: 끝의 / 는 폴더 항목의 표기일 뿐이므로 없으면 이름을 그대로 쓴다.
        let name = raw.strip_suffix('/').unwrap_or(&raw);
        if name.is_empty() || name.starts_with('/') || name.split('/').any(|part| part == "..") {
            return Err(format!("archive entry {raw} leaves the folder"));
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
                "archive entry {raw} is neither a regular file nor a folder"
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

/// 아직 없는 version 폴더에 archive 를 확인해 푼다.
fn install_archive(at: &str, archive: &Archive, target: &Path) -> Result<(), String> {
    match std::fs::metadata(target) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(crate::files::file_error(at, &error)),
    }
    let data = read_archive(at, archive)?;
    extract(&data, target).map_err(|error| format!("{at}: {error}"))
}

/// plugin 설치의 출력. 구조체 그대로 쓰므로 key 는 선언 순서이며 Go 구현과 같은 byte 를 쓴다.
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
/// archive.
pub fn install_plugin(
    config_dir: &Path,
    id: &str,
    core: &str,
    platform: &str,
    update: bool,
) -> Result<PluginResult, String> {
    let index = read_registry(config_dir)?;
    let state = read_installed(config_dir)?;
    if update && !state.plugins.contains_key(id) {
        return Err(format!("plugin {id} is not installed"));
    }
    let mut plan = DependencyPlan {
        config_dir,
        core,
        platform,
        index: &index,
        state,
        dependencies: BTreeMap::new(),
        providers: BTreeMap::new(),
        archives: BTreeMap::new(),
        order: vec![],
        sidecars: BTreeMap::new(),
        placed: BTreeSet::new(),
        changed: false,
    };
    plan.place(id, false, &[])?;
    let DependencyPlan {
        mut state,
        archives,
        order,
        sidecars,
        changed,
        ..
    } = plan;
    if !changed {
        return Ok(plugin_result(&state, id));
    }
    for changed in &order {
        let Some(data) = archives.get(changed) else {
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
        install_archive(
            &format!("sidecar {} {} {platform}", sidecar.name, sidecar.version),
            &sidecar.asset,
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
/// dependencies of the versions that the plan selected; archives holds the archives of plugin versions that are not
/// extracted yet; order lists the plugins whose version changed in selection order; sidecars holds the sidecar
/// versions that the plan selected.
struct DependencyPlan<'a> {
    config_dir: &'a Path,
    core: &'a str,
    platform: &'a str,
    index: &'a Index,
    state: InstalledState,
    dependencies: BTreeMap<String, BTreeMap<String, String>>,
    providers: BTreeMap<String, BTreeMap<String, String>>,
    archives: BTreeMap<String, Vec<u8>>,
    order: Vec<String>,
    sidecars: BTreeMap<String, SelectedSidecar>,
    placed: BTreeSet<String>,
    changed: bool,
}

/// Checks and returns the dependencies of a plugin.json text. file is the location for errors.
fn manifest_dependencies_of(file: &str, data: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let value: Value = serde_json::from_slice(data)
        .map_err(|error| format!("{file} is not valid JSON: {error}"))?;
    if !value.is_object() {
        return Err(format!("{file}: expected an object"));
    }
    install::manifest_dependencies(&value).map_err(|error| format!("{file}: {error}"))
}

/// Reads the plugin.json dependencies from the recorded folder of an installed plugin.
fn installed_dependencies(
    config_dir: &Path,
    plugin: &InstalledPlugin,
) -> Result<BTreeMap<String, String>, String> {
    let file = config_dir.join(&plugin.path).join("plugin.json");
    let data =
        std::fs::read(&file).map_err(|error| crate::files::file_error(file.display(), &error))?;
    manifest_dependencies_of(&file.display().to_string(), &data)
}

impl DependencyPlan<'_> {
    /// The plugin.json dependencies of the version in use of a planned plugin.
    fn manifest(&mut self, id: &str) -> Result<BTreeMap<String, String>, String> {
        if let Some(dependencies) = self.dependencies.get(id) {
            return Ok(dependencies.clone());
        }
        let dependencies = installed_dependencies(self.config_dir, &self.state.plugins[id])?;
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
        let package = index
            .plugins
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.package.clone())
            .or_else(|| current.as_ref().map(|plugin| plugin.package.clone()))
            // default: a plugin that neither the index nor installed.json lists has no package, so no plugin names
            // it, and resolve_install reports that it is not in the registry.
            .unwrap_or_default();
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
            let dependency = index
                .plugins
                .iter()
                .find(|entry| &entry.package == name)
                .map(|entry| entry.id.clone())
                .or_else(|| {
                    self.state
                        .plugins
                        .iter()
                        .find(|(_, plugin)| &plugin.package == name)
                        .map(|(other, _)| other.clone())
                });
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
    /// extracted folder, or else from the archive after it checks the sha256, and keeps the archive for extraction
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
                let archive = read_archive(&at, &selection.version.package)?;
                let mut files = archive_files(&archive, &["plugin.json"])
                    .map_err(|error| format!("{at}: {error}"))?;
                let data = files
                    .remove("plugin.json")
                    .ok_or_else(|| format!("{at}: the archive holds no plugin.json"))?;
                self.archives.insert(id.to_string(), archive);
                (format!("{at}: plugin.json"), data)
            }
            Err(error) => return Err(crate::files::file_error(&at, &error)),
        };
        let dependencies = manifest_dependencies_of(&file, &data)?;
        let (providers, _) =
            install::classify_dependencies(self.index, id, &version, &dependencies)?;
        self.dependencies.insert(id.to_string(), dependencies);
        self.providers.insert(id.to_string(), providers);
        let entry = InstalledPlugin {
            package: selection.plugin.package.clone(),
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

/// 어느 plugin 도 지정하지 않은 sidecar 를 지운다.
fn drop_unnamed_sidecars(state: &mut InstalledState) {
    let plugins = &state.plugins;
    state.sidecars.retain(|name, _| {
        plugins
            .values()
            .any(|plugin| plugin.sidecars.contains_key(name))
    });
}

/// 폴더 안의 항목 이름. 폴더가 없으면 빈 목록이다.
fn folder_names(path: &Path) -> Result<Vec<(String, bool)>, String> {
    let listing = match std::fs::read_dir(path) {
        Ok(listing) => listing,
        // 기본값: 아직 아무것도 설치하지 않은 설정 폴더에는 이 폴더가 없다.
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

/// 설치된 plugin 의 쓰는 version 과 previous 가 아닌 plugin 폴더와 version 폴더, installed.json 이 지정하지 않은
/// sidecar 폴더와 version 폴더를 지운다. 지우지 못한 폴더를 모두 보고한다.
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

/// 설치된 plugin 을 지우거나 켜고 끈다.
pub fn change_plugin(
    config_dir: &Path,
    id: &str,
    action: &str,
) -> Result<Option<InstalledPlugin>, String> {
    let mut state = read_installed(config_dir)?;
    let Some(plugin) = state.plugins.get(id) else {
        return Err(format!("plugin {id} is not installed"));
    };
    if action == "remove" || action == "disable" {
        // A plugin whose package another enabled plugin names as a dependency is neither removed nor disabled.
        for (other, dependent) in &state.plugins {
            if other == id || !dependent.enabled {
                continue;
            }
            if let Some(range) = installed_dependencies(config_dir, dependent)?.get(&plugin.package)
            {
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

/// registry use 와 plugin install, update, remove, enable, disable, list 를 실행한다.
pub(crate) fn run_plugins(
    positionals: &[String],
    values: &HashMap<String, String>,
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let config_dir = config_dir_of(values, options)?;
    let command = format!("{} {}", positionals[0], positionals[1]);
    let want = if command == "plugin list" { 2 } else { 3 };
    if positionals.len() < want {
        return Err(Error::Usage(format!("{command} needs an argument")));
    }
    if let Some(extra) = positionals.get(want) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    match command.as_str() {
        "registry use" => {
            let index = use_registry(&config_dir, &positionals[2], &Fetcher::default())?;
            Ok(print_json(stdout, &json!({"index": index}))?)
        }
        "plugin list" => Ok(print_json(stdout, &read_installed(&config_dir)?)?),
        "plugin install" | "plugin update" | "plugin remove" | "plugin enable"
        | "plugin disable" => {
            let action = positionals[1].as_str();
            // platform 은 버전을 고르는 install 과 update 에만 필요하다.
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
}
