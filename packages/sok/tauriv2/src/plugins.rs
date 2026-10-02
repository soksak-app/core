//! 설정 폴더에 plugin 을 설치하고 바꾼다(docs/spec/cli.md, docs/spec/installation.md). archive 는 임시 폴더에 푼
//! 뒤 이름을 바꿔 제자리에 두고, installed.json 은 마지막에 한 번에 바꾸므로 실패한 설치는 이전 설치를 바꾸지
//! 않는다.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::install::{
    self, Archive, Index, InstalledPlugin, InstalledSidecar, InstalledState, INSTALLED,
    INSTALL_FORMAT,
};
use crate::platform;
use crate::registry::read_archive;
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

/// 경로나 `file:` URL 의 registry index 를 읽고 검사한다.
fn read_index_at(location: &str) -> Result<(Index, String), String> {
    let path = if location.starts_with("file:") {
        PathBuf::from(install::file_path(location)?)
    } else {
        PathBuf::from(location)
    };
    let path = std::path::absolute(&path).map_err(|error| format!("{location}: {error}"))?;
    let text = std::fs::read_to_string(&path)
        .map_err(|error| crate::files::file_error(path.display(), &error))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    let index = install::validate_registry_index(&value)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok((index, file_url(&path)?))
}

/// registry index 를 검사하고 그 주소를 plugins/registry.json 에 쓴다.
pub fn use_registry(config_dir: &Path, location: &str) -> Result<String, String> {
    let (_, url) = read_index_at(location)?;
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
    Ok(read_index_at(&url)?.0)
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
        "{REGISTRY_FILE}: index must be an absolute file: URL"
    ))?;
    install::file_path(url).map_err(|error| format!("{REGISTRY_FILE}: {error}"))?;
    Ok(Some(url.to_string()))
}

/// 애플리케이션이 plugin 목록에 쓰는 registry 와 설치 상태
/// (docs/spec/installation.md#plugin-operations-in-the-application). 구조체 그대로 쓰므로 key 는 선언 순서다.
#[derive(serde::Serialize)]
pub struct PluginsState {
    pub registry: Option<String>,
    pub index: IndexState,
    pub installed: InstalledState,
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
    let (registry, index) = match read_registry_url(config_dir) {
        Err(error) => (None, IndexState::Failed { error }),
        Ok(None) => (None, IndexState::Missing),
        Ok(Some(url)) => {
            let index = match read_index_at(&url) {
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

/// plugins/installed.json 을 읽는다. 파일이 없으면 아무것도 설치하지 않은 상태다.
fn read_installed(config_dir: &Path) -> Result<InstalledState, String> {
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
    install::validate_installed(&value)
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

/// plugin 의 고른 version 을 설치한다. update 가 참이면 설치된 plugin 만 받는다.
pub fn install_plugin(
    config_dir: &Path,
    id: &str,
    core: &str,
    platform: &str,
    update: bool,
) -> Result<PluginResult, String> {
    let index = read_registry(config_dir)?;
    let mut state = read_installed(config_dir)?;
    let current = state.plugins.get(id).cloned();
    if update && current.is_none() {
        return Err(format!("plugin {id} is not installed"));
    }
    let selection = install::resolve_install(&index, id, core, platform, &state)?;
    let version = selection.version.version.clone();
    if current
        .as_ref()
        .is_some_and(|plugin| plugin.version == version)
    {
        return Ok(plugin_result(&state, id));
    }
    let plugin_folder = config_dir.join(install::plugin_install_path(id, &version)?);
    install_archive(
        &format!("plugin {id} {version} package"),
        &selection.version.package,
        &plugin_folder,
    )?;
    let mut chosen = vec![];
    for sidecar in &selection.sidecars {
        let folder = config_dir.join(install::sidecar_install_path(
            &sidecar.name,
            &sidecar.version,
            platform,
        )?);
        install_archive(
            &format!("sidecar {} {} {platform}", sidecar.name, sidecar.version),
            &sidecar.asset,
            &folder,
        )?;
        chosen.push((
            sidecar.name.clone(),
            InstalledSidecar {
                version: sidecar.version.clone(),
                path: folder.display().to_string(),
            },
        ));
    }
    let entry = InstalledPlugin {
        package: selection.plugin.package.clone(),
        version: version.clone(),
        path: plugin_folder.display().to_string(),
        enabled: current.as_ref().is_none_or(|plugin| plugin.enabled),
        sidecars: selection.version.sidecars.clone(),
        previous: current.map(|plugin| plugin.version),
    };
    state.plugins.insert(id.to_string(), entry);
    state.sidecars.extend(chosen);
    drop_unnamed_sidecars(&mut state);
    install::validate_installed(&serde_json::to_value(&state).map_err(|error| error.to_string())?)?;
    write_installed(config_dir, &state)?;
    prune_folders(config_dir, &state)?;
    Ok(plugin_result(&state, id))
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
    let Some(plugin) = state.plugins.get_mut(id) else {
        return Err(format!("plugin {id} is not installed"));
    };
    if action == "remove" {
        state.plugins.remove(id);
        drop_unnamed_sidecars(&mut state);
    } else {
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
    // 설치 상태는 절대 폴더를 기록하므로 설정 폴더도 절대 경로로 쓴다.
    let config_dir = std::path::absolute(config_dir_of(values, options.identifier)?)
        .map_err(|error| format!("configuration directory: {error}"))?;
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
            let index = use_registry(&config_dir, &positionals[2])?;
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
