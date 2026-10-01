//! registry 폴더를 검사하고 index.json 을 쓴다(docs/spec/cli.md). 모든 검사를 통과할 때만 index.json 을 한 번에
//! 바꾼다.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::install::{self, Archive, PluginVersion, RegistryPlugin};
use crate::release::{hex, print_json, read_json_file, replace_file};
use crate::Error;

type Validate = fn(&Value) -> Result<(), String>;
type FileName = fn(&Value) -> Result<String, String>;

/// registry 의 한 폴더에서 *.json 파일을 이름 순서로 읽고, 항목을 검사한 뒤 파일 이름이 항목과 맞는지 본다.
fn read_entries(
    dir: &Path,
    kind: &str,
    validate: Validate,
    file_name: FileName,
) -> Result<Vec<Value>, String> {
    let folder = dir.join(kind);
    let listing = match std::fs::read_dir(&folder) {
        Ok(listing) => listing,
        // 기본값: 폴더가 없는 registry 는 그 종류의 항목이 없다.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(format!("{}: {error}", folder.display())),
    };
    let mut names = vec![];
    for item in listing {
        let item = item.map_err(|error| format!("{}: {error}", folder.display()))?;
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

/// tar.gz 의 최상위 파일 중 names 의 내용을 읽는다.
fn archive_files(data: &[u8], names: &[&str]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(data));
    let mut found = BTreeMap::new();
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .display()
            .to_string();
        if names.contains(&path.as_str()) {
            let mut content = vec![];
            entry
                .read_to_end(&mut content)
                .map_err(|error| error.to_string())?;
            found.insert(path, content);
        }
    }
    if let Some(name) = names.iter().find(|name| !found.contains_key(**name)) {
        return Err(format!("the archive holds no {name}"));
    }
    Ok(found)
}

/// archive 주소의 파일을 읽고 sha256 을 비교한다.
fn read_archive(at: &str, archive: &Archive) -> Result<Vec<u8>, String> {
    let path = install::file_path(&archive.url).map_err(|error| format!("{at}: {error}"))?;
    let data = std::fs::read(&path).map_err(|error| format!("{at}: {error}"))?;
    let got = hex(&Sha256::digest(&data));
    if got != archive.sha256 {
        return Err(format!(
            "{at}: {path} has sha256 {got}, the entry says {}",
            archive.sha256
        ));
    }
    Ok(data)
}

/// plugin archive 가 항목의 plugin.json id 와 package.json 을 담는지 본다.
fn check_plugin_archive(plugin: &RegistryPlugin, version: &PluginVersion) -> Result<(), String> {
    let at = format!("plugin {} {} package", plugin.id, version.version);
    let data = read_archive(&at, &version.package)?;
    let files = archive_files(&data, &["package.json", "plugin.json"])
        .map_err(|error| format!("{at}: {error}"))?;
    let manifest: Value = serde_json::from_slice(&files["plugin.json"])
        .map_err(|error| format!("{at}: plugin.json is not valid JSON: {error}"))?;
    if manifest["id"] != plugin.id.as_str() {
        return Err(format!("{at}: plugin.json id is not {}", plugin.id));
    }
    let pkg: Value = serde_json::from_slice(&files["package.json"])
        .map_err(|error| format!("{at}: package.json is not valid JSON: {error}"))?;
    install::validate_plugin_package(&pkg).map_err(|error| format!("{at}: {error}"))?;
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
    let sidecars = install::package_sidecars(&pkg);
    if sidecars != version.sidecars {
        return Err(format!(
            "{at}: package.json soksak.sidecars {} differ from the entry {}",
            json!(sidecars),
            json!(version.sidecars)
        ));
    }
    Ok(())
}

/// registry 폴더를 검사하고 index.json 을 쓴 뒤 그 경로와 항목 수를 돌려준다.
pub fn build_registry(dir: &Path) -> Result<Value, String> {
    let plugins = read_entries(dir, "plugins", install::validate_registry_plugin, |value| {
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
    let mut index = install::validate_registry_index(
        &json!({"format": 1, "plugins": plugins, "sidecars": sidecars, "packs": packs, "revoked": revoked}),
    )?;
    // 파일 이름 순서는 @scope 이름의 순서와 다르므로 목록을 id 와 이름으로 다시 정렬한다.
    index.plugins.sort_by(|a, b| a.id.cmp(&b.id));
    index.sidecars.sort_by(|a, b| a.name.cmp(&b.name));
    index.packs.sort_by(|a, b| a.name.cmp(&b.name));
    for plugin in &index.plugins {
        for version in &plugin.versions {
            check_plugin_archive(plugin, version)?;
        }
    }
    for sidecar in &index.sidecars {
        for version in &sidecar.versions {
            for (platform, asset) in &version.assets {
                read_archive(
                    &format!("sidecar {} {} {platform}", sidecar.name, version.version),
                    asset,
                )?;
            }
        }
    }
    let mut out = vec![];
    // 구조체 그대로 쓰므로 key 는 선언 순서이며 Go 구현과 같은 byte 를 쓴다.
    print_json(&mut out, &index)?;
    let path = std::path::absolute(dir.join("index.json")).map_err(|error| error.to_string())?;
    replace_file(&path, &out)?;
    Ok(
        json!({"index": path.display().to_string(), "plugins": index.plugins.len(),
        "sidecars": index.sidecars.len(), "packs": index.packs.len()}),
    )
}

/// `sok registry build <directory>` 를 실행한다.
pub(crate) fn run_registry(positionals: &[String], stdout: &mut dyn Write) -> Result<(), Error> {
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
    let result = build_registry(Path::new(dir))?;
    Ok(print_json(stdout, &result)?)
}
