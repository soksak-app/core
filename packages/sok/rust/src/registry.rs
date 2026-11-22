//! Checks the registry folder and writes index.json (docs/spec/cli.md). The command changes index.json once and only when every check passes.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::Error;
use crate::install::{
    self, CoreRelease, Index, PluginVersion, RegistryPlugin, RegistrySidecar, Release,
    SidecarVersion,
};
use crate::output::{hex, print_json, read_json_file, replace_file};

type Validate = fn(&Value) -> Result<(), String>;
type FileName = fn(&Value) -> Result<String, String>;

/// Reads the *.json files of one folder of the registry in name order, checks the entries, and then checks that each file name matches its entry.
fn read_entries(
    dir: &Path,
    kind: &str,
    validate: Validate,
    file_name: FileName,
) -> Result<Vec<Value>, String> {
    let folder = dir.join(kind);
    let listing = match std::fs::read_dir(&folder) {
        Ok(listing) => listing,
        // default: a registry without the folder has no entries of that kind.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(crate::files::file_error(folder.display(), &error)),
    };
    let mut names = vec![];
    for item in listing {
        let item = item.map_err(|error| crate::files::file_error(folder.display(), &error))?;
        if let Some(name) = item
            .file_name()
            .to_str()
            .filter(|name| name.ends_with(".json"))
        {
            names.push(name.to_string());
        }
    }
    names.sort();
    let mut entries = vec![];
    for name in names {
        let value = read_json_file(&folder, &name)?;
        validate(&value).map_err(|error| format!("{kind}/{name}: {error}"))?;
        let want = file_name(&value)?;
        if name != format!("{want}.json") {
            return Err(format!(
                "{kind}/{name} holds {want}; its file name must be {want}.json"
            ));
        }
        entries.push(value);
    }
    Ok(entries)
}

/// The folder of every entry of a plugin or sidecar release, the layout that `npm pack` writes
/// (docs/spec/installation.md#plugin-release).
pub(crate) const PACKAGE_ROOT: &str = "package/";

/// The path segment that the binary store of a page reserves. The host answers that path before it looks up a file, so a
/// plugin release cannot hold a file under it (docs/spec/native-surfaces.md).
pub(crate) const BINARY_SEGMENT: &str = ".binary";

/// The modules that plugin.json loads and their names: the surface module and the page of a view composition.
pub(crate) fn manifest_modules(manifest: &Value) -> Vec<(String, String)> {
    let mut modules = vec![];
    let mut add = |what: String, value: &Value| {
        if let Some(module) = value.as_str() {
            modules.push((what, module.to_string()));
        }
    };
    add("surface module".into(), &manifest["surface"]["module"]);
    if manifest["surface"]["composition"]["kind"] == "view" {
        add(
            "view page".into(),
            &manifest["surface"]["composition"]["page"],
        );
    }
    modules
}

/// The paths of the files of a release under PACKAGE_ROOT, without that folder. extract refuses an entry outside it.
fn release_paths(data: &[u8]) -> Result<std::collections::BTreeSet<String>, String> {
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(data));
    let mut paths = std::collections::BTreeSet::new();
    for entry in reader.entries().map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .display()
            .to_string();
        if let Some(name) = path.strip_prefix(PACKAGE_ROOT) {
            paths.insert(name.to_string());
        }
    }
    Ok(paths)
}

/// Checks the files of a plugin release against its plugin.json: no file is under a BINARY_SEGMENT folder, and every module
/// that plugin.json loads is a file of the release.
pub(crate) fn check_release_modules(data: &[u8], manifest: &Value) -> Result<(), String> {
    let paths = release_paths(data)?;
    if let Some(name) = paths
        .iter()
        .find(|name| name.split('/').any(|segment| segment == BINARY_SEGMENT))
    {
        return Err(format!(
            "plugin release holds {name}: the {BINARY_SEGMENT} path is reserved for the binary store"
        ));
    }
    for (what, module) in manifest_modules(manifest) {
        if !paths.contains(&module) {
            return Err(format!(
                "plugin.json: {what} {module} is not in the release"
            ));
        }
    }
    Ok(())
}

/// Checks the files of a sidecar release against its sidecar.json: the executable and the replay executable that it names
/// are files of the release (docs/spec/installation.md#sidecar-release).
pub(crate) fn check_sidecar_release(data: &[u8]) -> Result<(), String> {
    let files = release_files(data, &["sidecar.json"])?;
    let declaration: Value = serde_json::from_slice(&files["sidecar.json"])
        .map_err(|error| format!("sidecar.json is not valid JSON: {error}"))?;
    let paths = release_paths(data)?;
    let mut declared = vec![("executable", &declaration["executable"])];
    if declaration.get("replay").is_some() {
        declared.push(("replay.executable", &declaration["replay"]["executable"]));
    }
    for (what, value) in declared {
        let path = value
            .as_str()
            .ok_or_else(|| format!("sidecar.json: {what} must be a path"))?;
        if !paths.contains(path) {
            return Err(format!("sidecar.json: {what} {path} is not in the release"));
        }
    }
    Ok(())
}

/// Reads the contents of the files of a release that are listed in names, each from `package/<name>`.
pub(crate) fn release_files(
    data: &[u8],
    names: &[&str],
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(data));
    let mut found = BTreeMap::new();
    for entry in reader.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .display()
            .to_string();
        let Some(name) = path.strip_prefix(PACKAGE_ROOT) else {
            continue;
        };
        if names.contains(&name) {
            let mut content = vec![];
            entry
                .read_to_end(&mut content)
                .map_err(|error| error.to_string())?;
            found.insert(name.to_string(), content);
        }
    }
    if let Some(name) = names.iter().find(|name| !found.contains_key(**name)) {
        return Err(format!("the release holds no {name}"));
    }
    Ok(found)
}

/// Reads the body at the address of a release and compares the sha256.
pub(crate) fn read_release(at: &str, release: &Release) -> Result<Vec<u8>, String> {
    let fetcher = crate::fetch::Fetcher::default();
    let data = fetcher
        .read(&release.url, fetcher.release)
        .map_err(|error| format!("{at}: {error}"))?;
    // For file: the error names the path, and for https: it names the URL.
    let shown = if release.url.starts_with("file:") {
        install::file_path(&release.url).map_err(|error| format!("{at}: {error}"))?
    } else {
        release.url.clone()
    };
    let got = hex(&Sha256::digest(&data));
    if got != release.sha256 {
        return Err(format!(
            "{at}: {shown} has sha256 {got}, the entry says {}",
            release.sha256
        ));
    }
    Ok(data)
}

/// Checks that a plugin release holds the plugin.json id and the package.json of its entry, and that the sidecar
/// dependencies of plugin.json equal the sidecars of the entry. It returns the plugin dependencies of plugin.json.
fn check_plugin_release(
    index: &Index,
    plugin: &RegistryPlugin,
    version: &PluginVersion,
) -> Result<BTreeMap<String, String>, String> {
    let at = format!("plugin {} {} package", plugin.id, version.version);
    let data = read_release(&at, &version.release)?;
    let files = release_files(&data, &["package.json", "plugin.json"])
        .map_err(|error| format!("{at}: {error}"))?;
    let manifest: Value = serde_json::from_slice(&files["plugin.json"])
        .map_err(|error| format!("{at}: plugin.json is not valid JSON: {error}"))?;
    if manifest["id"] != plugin.id.as_str() {
        return Err(format!("{at}: plugin.json id is not {}", plugin.id));
    }
    let pkg: Value = serde_json::from_slice(&files["package.json"])
        .map_err(|error| format!("{at}: package.json is not valid JSON: {error}"))?;
    install::validate_package_json(&pkg).map_err(|error| format!("{at}: {error}"))?;
    for (field, got, want) in [
        ("name", &pkg["name"], &plugin.package),
        ("version", &pkg["version"], &version.version),
        (
            "engines.soksak",
            &pkg["engines"]["soksak"],
            &version.engines.soksak,
        ),
    ] {
        let got = got
            .as_str()
            .ok_or_else(|| format!("{at}: package.json {field} is not text"))?;
        if got != want {
            return Err(format!(
                "{at}: package.json {field} is {got}, the entry says {want}"
            ));
        }
    }
    let dependencies =
        install::manifest_dependencies(&manifest).map_err(|error| format!("{at}: {error}"))?;
    let (plugins, sidecars) =
        install::classify_dependencies(index, &plugin.id, &version.version, &dependencies)?;
    if sidecars != version.sidecars {
        return Err(format!(
            "{at}: plugin.json dependencies {} differ from the entry {}",
            json!(sidecars),
            json!(version.sidecars)
        ));
    }
    Ok(plugins)
}

/// Checks the plugin dependencies that a plugin version records in the index: each names a listed plugin, and a listed version
/// of that plugin satisfies its range. A read version and a carried version are judged alike, so a carried version whose
/// dependency has no listed version fails the build.
fn check_plugin_dependencies(
    index: &Index,
    plugin: &RegistryPlugin,
    version: &PluginVersion,
) -> Result<(), String> {
    for (name, range) in &version.plugins {
        let Some(entry) = index.plugins.iter().find(|entry| &entry.package == name) else {
            return Err(format!(
                "{} {}: dependency {name} is neither a plugin nor a sidecar of the registry",
                plugin.id, version.version
            ));
        };
        let satisfied = entry
            .versions
            .iter()
            .any(|candidate| install::satisfies(&candidate.version, range));
        if !satisfied {
            return Err(format!(
                "{} {}: plugin dependency {name} {range} is satisfied by no listed version",
                plugin.id, version.version
            ));
        }
    }
    Ok(())
}

/// Reads the index that a previous publication wrote from location and checks it as a registry index. A failure names
/// location, and the caller writes nothing (docs/spec/registry.md#build).
pub(crate) fn read_previous_index(location: &str) -> Result<Index, String> {
    let fetcher = crate::fetch::Fetcher::default();
    let data = fetcher
        .read_index(location)
        .map_err(|error| format!("previous index {location}: {error}"))?;
    let value: Value = serde_json::from_slice(&data)
        .map_err(|error| format!("previous index {location} is not valid JSON: {error}"))?;
    install::validate_registry_index(&value)
        .map_err(|error| format!("previous index {location}: {error}"))
}

/// Returns the version of the previous index that has the same plugin identity and version record as version, or None when
/// the previous index does not list it. Such a release keeps the hash that the previous build checked, and its recorded
/// plugin dependencies are carried with it.
fn listed_plugin<'a>(
    previous: Option<&'a Index>,
    plugin: &RegistryPlugin,
    version: &PluginVersion,
) -> Option<&'a PluginVersion> {
    let previous = previous?;
    let old = previous
        .plugins
        .iter()
        .find(|entry| entry.id == plugin.id)?;
    if old.package != plugin.package
        || old.name != plugin.name
        || old.repository != plugin.repository
    {
        return None;
    }
    let listed = old
        .versions
        .iter()
        .find(|candidate| candidate.version == version.version)?;
    if listed.release != version.release
        || listed.engines.soksak != version.engines.soksak
        || listed.sidecars != version.sidecars
    {
        return None;
    }
    Some(listed)
}

/// Reports whether the previous index lists the release of one platform of the sidecar version with the same identity,
/// version and protocol.
fn carried_sidecar(
    previous: Option<&Index>,
    sidecar: &RegistrySidecar,
    version: &SidecarVersion,
    platform: &str,
    release: &Release,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    let Some(old) = previous
        .sidecars
        .iter()
        .find(|entry| entry.name == sidecar.name)
    else {
        return false;
    };
    if old.repository != sidecar.repository {
        return false;
    }
    let Some(listed) = old
        .versions
        .iter()
        .find(|candidate| candidate.version == version.version)
    else {
        return false;
    };
    listed.protocol == version.protocol && listed.releases.get(platform) == Some(release)
}

/// Reports whether the previous index lists the release of one key of the core version.
fn carried_core(
    previous: Option<&Index>,
    version: &CoreRelease,
    key: &str,
    release: &Release,
) -> bool {
    let Some(old) = previous.and_then(|previous| previous.core.as_ref()) else {
        return false;
    };
    old.versions
        .iter()
        .find(|candidate| candidate.version == version.version)
        .and_then(|listed| listed.releases.get(key))
        == Some(release)
}

/// Checks the registry folder, writes index.json, and returns its path, the number of entries, and the numbers of releases read
/// and carried. A None previous index is a first build that reads every release (docs/spec/registry.md#build).
pub fn build_registry(dir: &Path, previous: Option<&Index>) -> Result<Value, String> {
    let mut plugins = read_entries(dir, "plugins", install::validate_registry_plugin, |value| {
        value["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "id is required".into())
    })?;
    let sidecars = read_entries(
        dir,
        "sidecars",
        install::validate_registry_sidecar,
        |value| install::sidecar_file_name(value["name"].as_str().ok_or("name is required")?),
    )?;
    let packs = read_entries(dir, "packs", install::validate_registry_pack, |value| {
        value["name"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "name is required".into())
    })?;
    let revoked = read_json_file(dir, "revoked.json")?;
    // Each version records its plugin dependencies in the index, which an entry does not hold. The record is set below, after
    // the index is read: a carried version takes the record of the previous index, and a read version takes the dependencies
    // of its plugin.json. The placeholder only satisfies the index validation.
    for entry in plugins.iter_mut() {
        if let Some(versions) = entry["versions"].as_array_mut() {
            for version in versions {
                version["plugins"] = json!({});
            }
        }
    }
    let mut root = json!({"format": install::REGISTRY_INDEX_FORMAT, "plugins": plugins, "sidecars": sidecars, "packs": packs, "revoked": revoked});
    // A registry without core.json lists no core release.
    if dir.join("core.json").exists() {
        root["core"] = read_json_file(dir, "core.json")?;
    }
    let mut index = install::validate_registry_index(&root)?;
    // File name order differs from the order of @scope names, so the list is sorted again by id and name.
    index.plugins.sort_by(|a, b| a.id.cmp(&b.id));
    index.sidecars.sort_by(|a, b| a.name.cmp(&b.name));
    index.packs.sort_by(|a, b| a.name.cmp(&b.name));
    let (mut read, mut carried) = (0, 0);
    for i in 0..index.plugins.len() {
        for j in 0..index.plugins[i].versions.len() {
            let plugin = index.plugins[i].clone();
            let version = plugin.versions[j].clone();
            let dependencies = match listed_plugin(previous, &plugin, &version) {
                Some(listed) => {
                    carried += 1;
                    listed.plugins.clone()
                }
                None => {
                    read += 1;
                    check_plugin_release(&index, &plugin, &version)?
                }
            };
            index.plugins[i].versions[j].plugins = dependencies;
            check_plugin_dependencies(&index, &plugin, &index.plugins[i].versions[j])?;
        }
    }
    for sidecar in &index.sidecars {
        for version in &sidecar.versions {
            for (platform, release) in &version.releases {
                if carried_sidecar(previous, sidecar, version, platform, release) {
                    carried += 1;
                    continue;
                }
                read += 1;
                read_release(
                    &format!("sidecar {} {} {platform}", sidecar.name, version.version),
                    release,
                )?;
            }
        }
    }
    if let Some(core) = index.core.as_mut() {
        core.versions.sort_by(|a, b| a.version.cmp(&b.version));
    }
    let mut cores = 0;
    if let Some(core) = &index.core {
        for version in &core.versions {
            cores += 1;
            for (key, release) in &version.releases {
                if carried_core(previous, version, key, release) {
                    carried += 1;
                    continue;
                }
                read += 1;
                read_release(&format!("core {} {key}", version.version), release)?;
            }
        }
    }
    let mut out = vec![];
    // The structure is written as it is, so the key order is the declaration order and the bytes match the Go implementation.
    print_json(&mut out, &index)?;
    let path = std::path::absolute(dir.join("index.json")).map_err(|error| error.to_string())?;
    replace_file(&path, &out)?;
    Ok(
        json!({"index": path.display().to_string(), "plugins": index.plugins.len(),
        "sidecars": index.sidecars.len(), "packs": index.packs.len(), "core": cores,
        "read": read, "carried": carried}),
    )
}

/// Runs `sok registry build <directory> [--previous <location>]`.
pub(crate) fn run_registry(
    positionals: &[String],
    values: &std::collections::HashMap<String, String>,
    stdout: &mut dyn Write,
) -> Result<(), Error> {
    let action = positionals
        .get(1)
        .ok_or_else(|| Error::Usage("registry action is required".into()))?;
    if action != "build" {
        return Err(Error::Usage(format!("unknown command: registry {action}")));
    }
    let dir = positionals
        .get(2)
        .ok_or_else(|| Error::Usage("directory is required".into()))?;
    if let Some(extra) = positionals.get(3) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    let previous = match values.get("previous") {
        Some(location) => Some(read_previous_index(location)?),
        None => None,
    };
    let result = build_registry(Path::new(dir), previous.as_ref())?;
    Ok(print_json(stdout, &result)?)
}
