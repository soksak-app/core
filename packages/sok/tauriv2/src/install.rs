//! The formats of installable plugins (docs/spec/installation.md): versions and ranges, the plugin file, the
//! registry index, the sidecar release asset, the installed layout and the installed state. A wrong format returns an
//! error that names what is wrong. Fields are checked in a fixed order, so both implementations return the same error
//! when several fields are wrong.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Registry index 의 형식 번호.
pub const INSTALL_FORMAT: u64 = 1;

/// 설치 상태 파일의 형식 번호. 형식 2 는 설치 폴더를 설정 폴더에 대한 상대 경로로 기록한다.
pub const INSTALLED_FORMAT: u64 = 2;

/// 설정 폴더 안에서 설치 상태를 담는 파일.
pub const INSTALLED: &str = "plugins/installed.json";

/// Sidecar release asset 이 쓰는 플랫폼 key(`<os>-<arch>`).
pub const PLATFORMS: [&str; 6] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
];

const DESCRIPTION_MAX: usize = 200;

/// `x.y.z` version. 각 자리는 u32 범위이므로 범위의 상한을 계산할 때 넘치지 않는다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub [u64; 3]);

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0[0], self.0[1], self.0[2])
    }
}

/// 값을 JSON 텍스트로 쓴다. 오류 문구에서 받은 값을 그대로 보이게 한다.
fn quote(value: &Value) -> String {
    value.to_string()
}

/// 숫자 세 자리를 점으로 이은 version 을 읽는다. 앞자리 0 과 u32 를 넘는 수는 거부한다.
pub fn parse_version(text: &str) -> Result<Version, String> {
    let invalid = || {
        format!(
            "invalid version {}: expected x.y.z",
            quote(&Value::from(text))
        )
    };
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let mut version = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty()
            || !part.bytes().all(|b| b.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return Err(invalid());
        }
        version[i] = u64::from(part.parse::<u32>().map_err(|_| invalid())?);
    }
    Ok(Version(version))
}

/// 포함하는 하한 min 과 포함하지 않는 상한 below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub min: Version,
    /// 포함하지 않는 상한. None 이면 상한이 없다.
    pub below: Option<Version>,
}

impl Range {
    /// version 이 범위 안에 있는지.
    pub fn contains(&self, version: Version) -> bool {
        version >= self.min && self.below.is_none_or(|below| version < below)
    }
}

/// `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, `>=x.y.z <a.b.c` 범위를 읽는다. `*` 는 `>=0.0.0`, 곧 모든 version 이다.
pub fn parse_range(text: &str) -> Result<Range, String> {
    if text == "*" {
        return Ok(Range {
            min: Version([0, 0, 0]),
            below: None,
        });
    }
    if let Some(rest) = text.strip_prefix(">=") {
        if let Some((low, high)) = rest.split_once(" <") {
            if !low.is_empty() && !high.is_empty() && !low.contains(' ') && !high.contains(' ') {
                let min = parse_version(low)?;
                let below = parse_version(high)?;
                if min >= below {
                    return Err(format!("invalid version range {text}: empty"));
                }
                return Ok(Range {
                    min,
                    below: Some(below),
                });
            }
        } else if !rest.is_empty() && !rest.contains(' ') {
            // >=x.y.z 는 하한만 있고 상한이 없다.
            if let Ok(min) = parse_version(rest) {
                return Ok(Range { min, below: None });
            }
        }
    }
    let operator = if text.starts_with('^') || text.starts_with('~') {
        &text[..1]
    } else {
        ""
    };
    let Version([major, minor, patch]) = parse_version(&text[operator.len()..]).map_err(|_| {
        format!(
            "invalid version range {}: expected *, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z or >=x.y.z <a.b.c",
            quote(&Value::from(text))
        )
    })?;
    let min = Version([major, minor, patch]);
    let below = match operator {
        "" => [major, minor, patch + 1],
        "~" => [major, minor + 1, 0],
        _ if major > 0 => [major + 1, 0, 0],
        _ if minor > 0 => [0, minor + 1, 0],
        _ => [0, 0, patch + 1],
    };
    Ok(Range {
        min,
        below: Some(Version(below)),
    })
}

/// version 이 범위 안에 있는지. 둘 다 이미 검사한 값이어야 한다.
pub fn satisfies(version: &str, range: &str) -> bool {
    matches!((parse_version(version), parse_range(range)), (Ok(v), Ok(r)) if r.contains(v))
}

fn is_lower_word(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 소문자로 시작하고 소문자, 숫자, - 만 쓰는 이름인지.
pub(crate) fn is_identifier(text: &str) -> bool {
    text.as_bytes().first().is_some_and(u8::is_ascii_lowercase) && is_lower_word(text)
}

/// `name` 이나 `@scope/name` 형태인지.
fn is_package_name(text: &str) -> bool {
    match text.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, name)| is_lower_word(scope) && is_lower_word(name)),
        None => is_lower_word(text),
    }
}

pub(crate) fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn object<'a>(at: &str, value: Option<&'a Value>) -> Result<&'a Map<String, Value>, String> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{at}: expected an object"))
}

fn array<'a>(at: &str, value: Option<&'a Value>) -> Result<&'a Vec<Value>, String> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{at}: expected an array"))
}

fn sorted_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    keys
}

fn only(at: &str, map: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    match sorted_keys(map)
        .into_iter()
        .find(|key| !keys.contains(&key.as_str()))
    {
        Some(key) => Err(format!("{at}: unknown field {key}")),
        None => Ok(()),
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// 값이 수 1 인지. `1.0` 은 serde_json 이 실수로 읽어 as_u64 가 없으므로 거부한다.
fn is_one(value: Option<&Value>) -> bool {
    value.and_then(Value::as_u64) == Some(1)
}

fn shown(value: Option<&Value>) -> String {
    // 기본값: 없는 필드는 JSON null 로 보인다.
    quote(value.unwrap_or(&Value::Null))
}

/// version 을 검사하고 그 텍스트를 돌려준다.
pub(crate) fn check_version<'a>(at: &str, value: Option<&'a Value>) -> Result<&'a str, String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!(
            "{at}: invalid version {}: expected x.y.z",
            shown(value)
        ));
    };
    parse_version(text)
        .map(|_| text)
        .map_err(|error| format!("{at}: {error}"))
}

fn check_range(at: &str, value: Option<&Value>) -> Result<(), String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!("{at}: invalid version range {}", shown(value)));
    };
    parse_range(text)
        .map(|_| ())
        .map_err(|error| format!("{at}: {error}"))
}

/// package 이름을 검사하고 그 텍스트를 돌려준다.
pub(crate) fn check_package_name<'a>(
    at: &str,
    value: Option<&'a Value>,
) -> Result<&'a str, String> {
    match text(value) {
        Some(name) if is_package_name(name) => Ok(name),
        _ => Err(format!("{at}: expected a package name")),
    }
}

fn check_sidecar_ranges(at: &str, value: Option<&Value>) -> Result<(), String> {
    let map = object(at, value)?;
    for name in sorted_keys(map) {
        let place = format!("{at} {name}");
        check_package_name(&place, Some(&Value::from(name.as_str())))?;
        check_range(&place, map.get(name))?;
    }
    Ok(())
}

/// 절대 `file:` URL 의 local 경로. %XX 는 그 byte 로 읽는다.
pub fn file_path(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("file://")
        .filter(|rest| rest.starts_with('/'))
        .ok_or("url must be an absolute file: URL")?;
    if rest.contains(['?', '#']) {
        return Err("url must be an absolute file: URL without a query or fragment".into());
    }
    let bytes = rest.as_bytes();
    let mut path = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            path.push(bytes[i]);
            i += 1;
            continue;
        }
        let byte = rest
            .get(i + 1..i + 3)
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .filter(|_| bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit())
            .ok_or("url has an invalid escape")?;
        path.push(byte);
        i += 3;
    }
    String::from_utf8(path).map_err(|_| "url is not UTF-8 after unescaping".to_string())
}

fn check_archive(at: &str, value: Option<&Value>) -> Result<(), String> {
    let map = object(at, value)?;
    only(at, map, &["sha256", "url"])?;
    if !map
        .get("sha256")
        .and_then(Value::as_str)
        .is_some_and(is_sha256)
    {
        return Err(format!(
            "{at}: sha256 must be 64 lowercase hexadecimal digits"
        ));
    }
    let Some(url) = map.get("url").and_then(Value::as_str) else {
        return Err(format!("{at}: url must be an https: or absolute file: URL"));
    };
    crate::fetch::check_location(url).map_err(|error| format!("{at}: {error}"))
}

fn check_description(at: &str, value: Option<&Value>) -> Result<(), String> {
    match text(value) {
        Some(text) if text.chars().count() <= DESCRIPTION_MAX => Ok(()),
        _ => Err(format!(
            "{at}: description must be 1 to {DESCRIPTION_MAX} characters"
        )),
    }
}

/// Checks the fields of the package.json of a plugin that installation uses. Other npm fields belong to the
/// package tools and are not read.
pub fn validate_package_json(value: &Value) -> Result<(), String> {
    let pkg = object("package.json", Some(value))?;
    let engines = object("package.json engines", pkg.get("engines"))?;
    check_range("package.json engines.soksak", engines.get("soksak"))?;
    let files = array("package.json files", pkg.get("files"))?;
    let mut listed = false;
    for file in files {
        match text(Some(file)) {
            Some(path) if !path.starts_with('/') && !path.split('/').any(|part| part == "..") => {
                listed |= path == "plugin.json";
            }
            _ => return Err("package.json files: expected paths inside the package".into()),
        }
    }
    if !listed {
        return Err("package.json files: plugin.json is not listed".into());
    }
    check_package_name("package.json name", pkg.get("name"))?;
    if pkg.contains_key("soksak") {
        return Err("package.json soksak: the sidecars of a plugin and their ranges are the dependencies of plugin.json".into());
    }
    check_version("package.json version", pkg.get("version")).map(|_| ())
}

/// Checks the dependencies of plugin.json and returns the version range of each package. A plugin that needs no other
/// package has no dependencies.
pub fn manifest_dependencies(manifest: &Value) -> Result<BTreeMap<String, String>, String> {
    let Some(raw) = manifest.get("dependencies") else {
        return Ok(BTreeMap::new());
    };
    check_sidecar_ranges("plugin.json dependencies", Some(raw))?;
    Ok(raw
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, range)| {
            range
                .as_str()
                .map(|range| (name.clone(), range.to_string()))
        })
        .collect())
}

/// The file name of a packed plugin.
pub fn plugin_archive_name(id: &str, version: &str) -> String {
    format!("{id}-{version}.tgz")
}

/// Sidecar 이름을 파일 이름과 폴더 이름에 쓰는 형태로 바꾼다. `@scope/name` 은 `scope-name` 이다.
pub fn sidecar_file_name(name: &str) -> Result<String, String> {
    check_package_name("sidecar", Some(&Value::from(name)))?;
    Ok(match name.strip_prefix('@') {
        Some(scoped) => scoped.replacen('/', "-", 1),
        None => name.to_string(),
    })
}

pub(crate) fn check_platform(platform: &str) -> Result<(), String> {
    if PLATFORMS.contains(&platform) {
        Ok(())
    } else {
        Err(format!("unknown platform {platform}"))
    }
}

/// Sidecar release asset 의 파일 이름.
pub fn sidecar_asset_name(name: &str, version: &str, platform: &str) -> Result<String, String> {
    check_version(
        &format!("sidecar {name} version"),
        Some(&Value::from(version)),
    )?;
    check_platform(platform)?;
    Ok(format!(
        "{}-{version}-{platform}.tar.gz",
        sidecar_file_name(name)?
    ))
}

/// 설정 폴더 안에서 plugin version 하나를 푸는 폴더.
pub fn plugin_install_path(id: &str, version: &str) -> Result<String, String> {
    if !is_identifier(id) {
        return Err(format!("invalid plugin id {id}"));
    }
    check_version(&format!("plugin {id} version"), Some(&Value::from(version)))?;
    Ok(format!("plugins/{id}/{version}"))
}

/// 설정 폴더 안에서 sidecar version 하나의 플랫폼 asset 을 푸는 폴더.
pub fn sidecar_install_path(name: &str, version: &str, platform: &str) -> Result<String, String> {
    check_version(
        &format!("sidecar {name} version"),
        Some(&Value::from(version)),
    )?;
    check_platform(platform)?;
    Ok(format!(
        "sidecars/{}/{version}/{platform}",
        sidecar_file_name(name)?
    ))
}

/// Release archive 의 주소와 hash.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Archive {
    pub url: String,
    pub sha256: String,
}

/// Plugin version 이 지원하는 core 범위.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Engines {
    pub soksak: String,
}

/// Registry 의 plugin version 하나.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginVersion {
    pub version: String,
    pub package: Archive,
    pub engines: Engines,
    pub sidecars: BTreeMap<String, String>,
}

/// Registry 의 plugin 항목.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryPlugin {
    pub id: String,
    pub package: String,
    pub name: String,
    pub description: String,
    pub license: String,
    pub repository: String,
    pub versions: Vec<PluginVersion>,
}

/// Registry 의 sidecar version 하나.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SidecarVersion {
    pub version: String,
    pub protocol: u64,
    pub assets: BTreeMap<String, Archive>,
}

/// Registry 의 sidecar 항목.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistrySidecar {
    pub name: String,
    pub repository: String,
    pub versions: Vec<SidecarVersion>,
}

/// 함께 설치하는 plugin 묶음.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryPack {
    pub name: String,
    pub description: String,
    pub plugins: Vec<String>,
}

/// 설치하면 안 되는 plugin version.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RevokedPlugin {
    pub id: String,
    pub version: String,
    pub reason: String,
}

/// 설치하거나 실행하면 안 되는 sidecar version.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RevokedSidecar {
    pub name: String,
    pub version: String,
    pub reason: String,
}

/// 설치하거나 실행하면 안 되는 version.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Revoked {
    pub plugins: Vec<RevokedPlugin>,
    pub sidecars: Vec<RevokedSidecar>,
}

/// 검사한 registry index.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Index {
    pub format: u64,
    pub plugins: Vec<RegistryPlugin>,
    pub sidecars: Vec<RegistrySidecar>,
    pub packs: Vec<RegistryPack>,
    pub revoked: Revoked,
}

/// 항목의 이름이 문자열이면 그것을 붙인 위치.
fn entry_at(kind: &str, map: &Map<String, Value>, key: &str) -> String {
    match map.get(key).and_then(Value::as_str) {
        Some(name) => format!("{kind} {name}"),
        None => kind.to_string(),
    }
}

/// Registry 의 plugin 항목 하나(`plugins/<id>.json`)를 검사한다.
pub fn validate_registry_plugin(value: &Value) -> Result<(), String> {
    let entry = object("registry plugin", Some(value))?;
    let at = entry_at("registry plugin", entry, "id");
    only(
        &at,
        entry,
        &[
            "description",
            "id",
            "license",
            "name",
            "package",
            "repository",
            "versions",
        ],
    )?;
    check_description(&at, entry.get("description"))?;
    if !text(entry.get("id")).is_some_and(is_identifier) {
        return Err(format!("{at}: id must be a lowercase identifier"));
    }
    if text(entry.get("license")).is_none() {
        return Err(format!("{at}: license is required"));
    }
    if text(entry.get("name")).is_none() {
        return Err(format!("{at}: name is required"));
    }
    check_package_name(&format!("{at} package"), entry.get("package"))?;
    if text(entry.get("repository")).is_none() {
        return Err(format!("{at}: repository is required"));
    }
    let mut seen = BTreeSet::new();
    for raw in array(&format!("{at} versions"), entry.get("versions"))? {
        let item = object(&format!("{at} version"), Some(raw))?;
        only(
            &format!("{at} version"),
            item,
            &["engines", "package", "sidecars", "version"],
        )?;
        let version = check_version(&format!("{at} version"), item.get("version"))?;
        if !seen.insert(version.to_string()) {
            return Err(format!("{at}: version {version} appears twice"));
        }
        let engines_at = format!("{at} {version} engines");
        let engines = object(&engines_at, item.get("engines"))?;
        only(&engines_at, engines, &["soksak"])?;
        check_range(
            &format!("{at} {version} engines.soksak"),
            engines.get("soksak"),
        )?;
        check_archive(&format!("{at} {version} package"), item.get("package"))?;
        check_sidecar_ranges(&format!("{at} {version} sidecars"), item.get("sidecars"))?;
    }
    if seen.is_empty() {
        return Err(format!("{at}: versions is empty"));
    }
    Ok(())
}

/// Registry 의 sidecar 항목 하나(`sidecars/<file name>.json`)를 검사한다.
pub fn validate_registry_sidecar(value: &Value) -> Result<(), String> {
    let entry = object("registry sidecar", Some(value))?;
    let at = entry_at("registry sidecar", entry, "name");
    only(&at, entry, &["name", "repository", "versions"])?;
    check_package_name(&format!("{at} name"), entry.get("name"))?;
    if text(entry.get("repository")).is_none() {
        return Err(format!("{at}: repository is required"));
    }
    let mut seen = BTreeSet::new();
    for raw in array(&format!("{at} versions"), entry.get("versions"))? {
        let item = object(&format!("{at} version"), Some(raw))?;
        only(
            &format!("{at} version"),
            item,
            &["assets", "protocol", "version"],
        )?;
        let version = check_version(&format!("{at} version"), item.get("version"))?;
        if !seen.insert(version.to_string()) {
            return Err(format!("{at}: version {version} appears twice"));
        }
        let assets = object(&format!("{at} {version} assets"), item.get("assets"))?;
        if assets.is_empty() {
            return Err(format!("{at} {version}: assets is empty"));
        }
        for platform in sorted_keys(assets) {
            check_platform(platform).map_err(|error| format!("{at} {version}: {error}"))?;
            check_archive(&format!("{at} {version} {platform}"), assets.get(platform))?;
        }
        if !is_one(item.get("protocol")) {
            return Err(format!("{at} {version}: protocol must be 1"));
        }
    }
    if seen.is_empty() {
        return Err(format!("{at}: versions is empty"));
    }
    Ok(())
}

/// Registry 의 pack 항목 하나(`packs/<name>.json`)를 검사한다.
pub fn validate_registry_pack(value: &Value) -> Result<(), String> {
    let entry = object("registry pack", Some(value))?;
    let at = entry_at("registry pack", entry, "name");
    only(&at, entry, &["description", "name", "plugins"])?;
    check_description(&at, entry.get("description"))?;
    if !text(entry.get("name")).is_some_and(is_identifier) {
        return Err(format!("{at}: name must be a lowercase identifier"));
    }
    let ids = array(&format!("{at} plugins"), entry.get("plugins"))?;
    let mut seen = BTreeSet::new();
    for raw in ids {
        let Some(id) = text(Some(raw)).filter(|id| is_identifier(id)) else {
            return Err(format!("{at}: plugins must be plugin ids"));
        };
        if !seen.insert(id) {
            return Err(format!("{at}: duplicate plugin"));
        }
    }
    if ids.is_empty() {
        return Err(format!("{at}: plugins must be plugin ids"));
    }
    Ok(())
}

/// Registry 의 revoked 목록(`revoked.json`)을 검사한다.
pub fn validate_revoked(value: &Value) -> Result<(), String> {
    let revoked = object("registry revoked", Some(value))?;
    only("registry revoked", revoked, &["plugins", "sidecars"])?;
    for (kind, key) in [("plugins", "id"), ("sidecars", "name")] {
        let at = format!("registry revoked {kind}");
        for raw in array(&at, revoked.get(kind))? {
            let item = object(&at, Some(raw))?;
            only(&at, item, &[key, "reason", "version"])?;
            let Some(name) = text(item.get(key)) else {
                return Err(format!("{at}: {key} is required"));
            };
            if text(item.get("reason")).is_none() {
                return Err(format!("{at} {name}: reason is required"));
            }
            check_version(&format!("{at} {name}"), item.get("version"))?;
        }
    }
    Ok(())
}

/// 검사한 값을 형식 구조체로 옮긴다.
fn typed<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

/// Registry index 를 검사한다. 항목마다 형식을 보고, 이름이 겹치지 않는지, pack 과 revoked 가 있는 plugin 과
/// sidecar 를 가리키는지, plugin version 마다 필요한 sidecar 범위를 채우는 sidecar version 이 있는지 본다.
pub fn validate_registry_index(value: &Value) -> Result<Index, String> {
    let root = object("registry index", Some(value))?;
    only(
        "registry index",
        root,
        &["format", "packs", "plugins", "revoked", "sidecars"],
    )?;
    if !is_one(root.get("format")) {
        return Err(format!("registry index: format must be {INSTALL_FORMAT}"));
    }
    type Validate = fn(&Value) -> Result<(), String>;
    let lists: [(&str, Validate); 3] = [
        ("packs", validate_registry_pack),
        ("plugins", validate_registry_plugin),
        ("sidecars", validate_registry_sidecar),
    ];
    for (name, validate) in lists {
        for item in array(&format!("registry index {name}"), root.get(name))? {
            validate(item)?;
        }
    }
    validate_revoked(&root["revoked"])?;
    let index: Index = typed(value)?;
    let mut plugins: BTreeMap<&str, &RegistryPlugin> = BTreeMap::new();
    let mut packages = BTreeSet::new();
    for entry in &index.plugins {
        if plugins.insert(&entry.id, entry).is_some() {
            return Err(format!("registry index: plugin {} appears twice", entry.id));
        }
        if !packages.insert(&entry.package) {
            return Err(format!(
                "registry index: package {} appears twice",
                entry.package
            ));
        }
    }
    let mut sidecars: BTreeMap<&str, &RegistrySidecar> = BTreeMap::new();
    for entry in &index.sidecars {
        if sidecars.insert(&entry.name, entry).is_some() {
            return Err(format!(
                "registry index: sidecar {} appears twice",
                entry.name
            ));
        }
    }
    let mut packs = BTreeSet::new();
    for entry in &index.packs {
        if !packs.insert(&entry.name) {
            return Err(format!("registry index: pack {} appears twice", entry.name));
        }
        if let Some(id) = entry
            .plugins
            .iter()
            .find(|id| !plugins.contains_key(id.as_str()))
        {
            return Err(format!(
                "registry index: pack {} names unknown plugin {id}",
                entry.name
            ));
        }
    }
    for plugin in &index.plugins {
        for item in &plugin.versions {
            for (name, range) in &item.sidecars {
                let Some(sidecar) = sidecars.get(name.as_str()) else {
                    return Err(format!(
                        "registry index: plugin {} {} needs unknown sidecar {name}",
                        plugin.id, item.version
                    ));
                };
                if !sidecar
                    .versions
                    .iter()
                    .any(|candidate| satisfies(&candidate.version, range))
                {
                    return Err(format!(
                        "registry index: plugin {} {} needs {name} {range}, which no version satisfies",
                        plugin.id, item.version
                    ));
                }
            }
        }
    }
    for item in &index.revoked.plugins {
        let listed = plugins.get(item.id.as_str()).is_some_and(|plugin| {
            plugin
                .versions
                .iter()
                .any(|candidate| candidate.version == item.version)
        });
        if !listed {
            return Err(format!(
                "registry index: revoked plugin {} {} is not listed",
                item.id, item.version
            ));
        }
    }
    for item in &index.revoked.sidecars {
        let listed = sidecars.get(item.name.as_str()).is_some_and(|sidecar| {
            sidecar
                .versions
                .iter()
                .any(|candidate| candidate.version == item.version)
        });
        if !listed {
            return Err(format!(
                "registry index: revoked sidecar {} {} is not listed",
                item.name, item.version
            ));
        }
    }
    Ok(index)
}

/// 설치한 plugin 하나.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct InstalledPlugin {
    pub package: String,
    pub version: String,
    /// 설치가 쓰는 version 을 푼 절대 폴더.
    pub path: String,
    pub enabled: bool,
    pub sidecars: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

/// 설치한 sidecar 하나. path 는 설치가 그 플랫폼 asset 을 푼 절대 폴더다.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct InstalledSidecar {
    pub version: String,
    pub path: String,
}

/// 설치 상태 파일(`plugins/installed.json`). plugin id 마다 package 이름, 쓰는 version, 푼 폴더, 켜짐 여부, 그
/// version 의 sidecar 범위, 되돌릴 이전 version 을 담고, sidecar 마다 모든 plugin 이 함께 쓰는 version 하나와 그
/// 폴더를 담는다. 폴더는 설치가 기록하며 host 는 기록된 폴더만 읽는다.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct InstalledState {
    pub format: u64,
    pub plugins: BTreeMap<String, InstalledPlugin>,
    pub sidecars: BTreeMap<String, InstalledSidecar>,
}

/// plugin 의 path 가 설치 규칙의 폴더 plugins/<id>/<version> 인지 검사한다.
fn check_plugin_folder(
    at: &str,
    id: &str,
    version: &str,
    value: Option<&Value>,
) -> Result<(), String> {
    let folder = plugin_install_path(id, version)?;
    match text(value) {
        Some(path) if path == folder => Ok(()),
        _ => Err(format!("{at}: path must be {folder}")),
    }
}

/// sidecar 의 path 가 설치 규칙의 폴더 sidecars/<file name>/<version>/<platform> 인지 검사한다.
fn check_sidecar_folder(
    at: &str,
    name: &str,
    version: &str,
    value: Option<&Value>,
) -> Result<(), String> {
    let prefix = format!("sidecars/{}/{version}/", sidecar_file_name(name)?);
    match text(value).and_then(|path| path.strip_prefix(&prefix)) {
        Some(platform) if check_platform(platform).is_ok() => Ok(()),
        _ => Err(format!("{at}: path must be {prefix}<platform>")),
    }
}

impl InstalledState {
    /// 아무것도 설치하지 않은 상태.
    pub fn empty() -> Self {
        InstalledState {
            format: INSTALLED_FORMAT,
            plugins: BTreeMap::new(),
            sidecars: BTreeMap::new(),
        }
    }
}

/// 설치 상태 파일을 검사한다.
pub fn validate_installed(value: &Value) -> Result<InstalledState, String> {
    let root = object(INSTALLED, Some(value))?;
    only(INSTALLED, root, &["format", "plugins", "sidecars"])?;
    if root.get("format").and_then(Value::as_u64) != Some(INSTALLED_FORMAT) {
        return Err(format!("{INSTALLED}: format must be {INSTALLED_FORMAT}"));
    }
    let plugins = object(&format!("{INSTALLED} plugins"), root.get("plugins"))?;
    let mut packages = BTreeSet::new();
    let mut named = BTreeSet::new();
    for id in sorted_keys(plugins) {
        let at = format!("{INSTALLED} {id}");
        if !is_identifier(id) {
            return Err(format!("{at}: id must be a lowercase identifier"));
        }
        let item = object(&at, plugins.get(id))?;
        only(
            &at,
            item,
            &[
                "enabled", "package", "path", "previous", "sidecars", "version",
            ],
        )?;
        if !item.get("enabled").is_some_and(Value::is_boolean) {
            return Err(format!("{at}: enabled must be true or false"));
        }
        let name = check_package_name(&format!("{at} package"), item.get("package"))?;
        if !packages.insert(name) {
            return Err(format!("{at}: package {name} is installed twice"));
        }
        if let Some(previous) = item.get("previous") {
            check_version(&format!("{at} previous"), Some(previous))?;
        }
        check_sidecar_ranges(&format!("{at} sidecars"), item.get("sidecars"))?;
        let version = check_version(&format!("{at} version"), item.get("version"))?;
        check_plugin_folder(&at, id, version, item.get("path"))?;
        named.extend(
            item["sidecars"]
                .as_object()
                .into_iter()
                .flat_map(|map| map.keys()),
        );
    }
    let sidecars = object(&format!("{INSTALLED} sidecars"), root.get("sidecars"))?;
    for name in sorted_keys(sidecars) {
        let at = format!("{INSTALLED} sidecar {name}");
        let item = object(&at, sidecars.get(name))?;
        only(&at, item, &["path", "version"])?;
        let version = check_version(&format!("{at} version"), item.get("version"))?;
        check_sidecar_folder(&at, name, version, item.get("path"))?;
        if !named.contains(name) {
            return Err(format!(
                "{INSTALLED}: sidecar {name} is named by no installed plugin"
            ));
        }
    }
    let state: InstalledState = typed(value)?;
    for (id, item) in &state.plugins {
        for (name, range) in &item.sidecars {
            let Some(version) = state.sidecars.get(name).map(|sidecar| &sidecar.version) else {
                return Err(format!(
                    "{INSTALLED} {id}: sidecar {name} has no version in use"
                ));
            };
            if !satisfies(version, range) {
                return Err(format!(
                    "{INSTALLED} {id}: sidecar {name} {version} does not satisfy {range}"
                ));
            }
        }
    }
    Ok(state)
}

/// The plugin dependencies and the sidecar dependencies of a plugin version, each a range per package.
pub type Dependencies = (BTreeMap<String, String>, BTreeMap<String, String>);

/// Splits the dependencies of a plugin version into plugin dependencies, which name the package of a plugin of the
/// registry index, and sidecar dependencies, which name a sidecar of the index. A dependency that is neither is an
/// error.
pub fn classify_dependencies(
    index: &Index,
    id: &str,
    version: &str,
    dependencies: &BTreeMap<String, String>,
) -> Result<Dependencies, String> {
    let (mut plugins, mut sidecars) = (BTreeMap::new(), BTreeMap::new());
    for (name, range) in dependencies {
        if index.plugins.iter().any(|entry| &entry.package == name) {
            plugins.insert(name.clone(), range.clone());
        } else if index.sidecars.iter().any(|entry| &entry.name == name) {
            sidecars.insert(name.clone(), range.clone());
        } else {
            return Err(format!(
                "{id} {version}: dependency {name} is neither a plugin nor a sidecar of the registry"
            ));
        }
    }
    Ok((plugins, sidecars))
}

/// The range that one installed plugin requires of a plugin or a sidecar. who is `<id> <version>`.
#[derive(Clone, Debug, PartialEq)]
pub struct Need {
    pub who: String,
    pub range: String,
}

pub fn needs_text(needs: &[Need]) -> String {
    needs
        .iter()
        .map(|need| format!("{} needs {}", need.who, need.range))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 설치할 sidecar version 하나와 그 플랫폼 asset.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectedSidecar {
    pub name: String,
    pub version: String,
    pub asset: Archive,
}

/// 설치할 plugin version 과 그 sidecar version.
#[derive(Clone, Debug)]
pub struct Selection<'a> {
    pub plugin: &'a RegistryPlugin,
    pub version: &'a PluginVersion,
    pub sidecars: Vec<SelectedSidecar>,
}

fn newer(a: &str, b: &str) -> bool {
    matches!((parse_version(a), parse_version(b)), (Ok(x), Ok(y)) if x > y)
}

/// Selects the plugin version to install and its sidecar versions. The plugin version is the newest one whose
/// engines.soksak contains core, that is not revoked, and that satisfies every range of needs, the ranges of the
/// installed plugins that name the plugin. An installation has one version of a sidecar, so it satisfies the range of
/// the selected version and the ranges that the other installed plugins name. The version in use is kept when it
/// satisfies every range, is not revoked and has an asset for the platform; otherwise the newest such version is
/// selected.
pub fn resolve_install<'a>(
    index: &'a Index,
    id: &str,
    core: &str,
    platform: &str,
    installed: &InstalledState,
    needs: &[Need],
) -> Result<Selection<'a>, String> {
    let plugin = index
        .plugins
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("plugin {id} is not in the registry"))?;
    let revoked_plugin = |version: &str| {
        index
            .revoked
            .plugins
            .iter()
            .any(|item| item.id == id && item.version == version)
    };
    let chosen = plugin
        .versions
        .iter()
        .filter(|item| {
            satisfies(core, &item.engines.soksak)
                && !revoked_plugin(&item.version)
                && needs.iter().all(|need| satisfies(&item.version, &need.range))
        })
        .fold(None::<&PluginVersion>, |best, item| match best {
            Some(best) if !newer(&item.version, &best.version) => Some(best),
            _ => Some(item),
        })
        .ok_or_else(|| {
            if needs.is_empty() {
                format!("plugin {id} has no version for core {core}")
            } else {
                format!(
                    "plugin {id} has no version for core {core} that satisfies every installed plugin: {}",
                    needs_text(needs)
                )
            }
        })?;
    let mut sidecars = vec![];
    for (name, range) in &chosen.sidecars {
        let mut needs = vec![Need {
            who: format!("{id} {}", chosen.version),
            range: range.clone(),
        }];
        for (other, item) in &installed.plugins {
            if let Some(range) = item.sidecars.get(name).filter(|_| other != id) {
                needs.push(Need {
                    who: format!("{other} {}", item.version),
                    range: range.clone(),
                });
            }
        }
        let entry = index.sidecars.iter().find(|item| &item.name == name);
        let mut best: Option<&SidecarVersion> = None;
        let mut kept: Option<&SidecarVersion> = None;
        for item in entry.into_iter().flat_map(|entry| &entry.versions) {
            let fits = needs
                .iter()
                .all(|need| satisfies(&item.version, &need.range));
            let revoked = index
                .revoked
                .sidecars
                .iter()
                .any(|r| &r.name == name && r.version == item.version);
            if !item.assets.contains_key(platform) || !fits || revoked {
                continue;
            }
            if installed.sidecars.get(name).map(|sidecar| &sidecar.version) == Some(&item.version) {
                kept = Some(item);
            }
            if best.is_none_or(|best| newer(&item.version, &best.version)) {
                best = Some(item);
            }
        }
        let Some(version) = kept.or(best) else {
            return Err(format!(
                "sidecar {name} has no version for {platform} that satisfies every installed plugin: {}",
                needs_text(&needs)
            ));
        };
        sidecars.push(SelectedSidecar {
            name: name.clone(),
            version: version.version.clone(),
            asset: version.assets[platform].clone(),
        });
    }
    Ok(Selection {
        plugin,
        version: chosen,
        sidecars,
    })
}
