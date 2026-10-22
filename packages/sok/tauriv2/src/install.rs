//! The formats of installable plugins (docs/spec/installation.md): versions and ranges, the plugin file, the
//! registry index, the sidecar release, the installed layout and the installed state. A wrong format returns an
//! error that names what is wrong. Fields are checked in a fixed order, so both implementations return the same error
//! when several fields are wrong.

use std::collections::{BTreeMap, BTreeSet};

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The format number of the registry index.
pub const INSTALL_FORMAT: u64 = 1;

/// The format number of the installation state file. Format 2 records the installation folder as a path relative to the configuration folder.
pub const INSTALLED_FORMAT: u64 = 3;

/// The file in the configuration folder that holds the installation state.
pub const INSTALLED: &str = "plugins/installed.json";
pub const SETTINGS: &str = "settings.json";
pub const PROJECTS: &str = "projects.json";

/// The platform keys (`<os>-<arch>`) of sidecar releases.
pub const PLATFORMS: [&str; 6] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
];

const DESCRIPTION_MAX: usize = 200;

/// The largest part of a version (docs/spec/installation.md: a version part is at most 4294967295).
const MAX_PART: u64 = u32::MAX as u64;

/// Writes a value as JSON text so that an error text shows the received value unchanged.
fn quote(value: &Value) -> String {
    value.to_string()
}

/// Reads an `x.y.z` version with the library. The library accepts forms beyond `x.y.z`, so a pre-release, build
/// metadata, a `v` prefix, a leading zero, another number of parts and a part above 4294967295 are refused here.
pub fn parse_version(text: &str) -> Result<Version, String> {
    let invalid = || {
        format!(
            "invalid version {}: expected x.y.z",
            quote(&Value::from(text))
        )
    };
    let version = Version::parse(text).map_err(|_| invalid())?;
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || version.to_string() != text
        || [version.major, version.minor, version.patch]
            .iter()
            .any(|part| *part > MAX_PART)
    {
        return Err(invalid());
    }
    Ok(version)
}

/// An inclusive lower bound min and an exclusive upper bound below. The bounds are the forms of
/// docs/spec/installation.md, and the versions are compared with the library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Range {
    pub min: Version,
    /// The exclusive upper bound. None means there is no upper bound.
    pub below: Option<Version>,
}

impl Range {
    /// Whether the version is inside the range.
    pub fn contains(&self, version: &Version) -> bool {
        version >= &self.min && self.below.as_ref().is_none_or(|below| version < below)
    }
}

/// Reads the ranges `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z` and `>=x.y.z <a.b.c`. `*` is `>=0.0.0`, that is, every version.
/// The forms are matched here before the versions of a form are read by parse_version.
pub fn parse_range(text: &str) -> Result<Range, String> {
    if text == "*" {
        return Ok(Range {
            min: Version::new(0, 0, 0),
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
            // >=x.y.z has only a lower bound and no upper bound.
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
    let min = parse_version(&text[operator.len()..]).map_err(|_| {
        format!(
            "invalid version range {}: expected *, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z or >=x.y.z <a.b.c",
            quote(&Value::from(text))
        )
    })?;
    let (major, minor, patch) = (min.major, min.minor, min.patch);
    let below = match operator {
        "" => Version::new(major, minor, patch + 1),
        "~" => Version::new(major, minor + 1, 0),
        _ if major > 0 => Version::new(major + 1, 0, 0),
        _ if minor > 0 => Version::new(0, minor + 1, 0),
        _ => Version::new(0, 0, patch + 1),
    };
    Ok(Range {
        min,
        below: Some(below),
    })
}

/// Whether the version is inside the range. Both must be values that were already checked.
pub fn satisfies(version: &str, range: &str) -> bool {
    matches!((parse_version(version), parse_range(range)), (Ok(v), Ok(r)) if r.contains(&v))
}

fn is_lower_word(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Whether the name starts with a lowercase letter and uses only lowercase letters, digits and -.
pub(crate) fn is_identifier(text: &str) -> bool {
    text.as_bytes().first().is_some_and(u8::is_ascii_lowercase) && is_lower_word(text)
}

/// Whether the name has the form `name` or `@scope/name`.
fn is_package_json_name(text: &str) -> bool {
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

/// Whether the value is the number 1. serde_json reads `1.0` as a float that has no as_u64, so the code rejects it.
fn is_one(value: Option<&Value>) -> bool {
    value.and_then(Value::as_u64) == Some(1)
}

fn shown(value: Option<&Value>) -> String {
    // default: a missing field appears as JSON null.
    quote(value.unwrap_or(&Value::Null))
}

/// Checks the version and returns its text.
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

/// Checks the name of package.json and returns its text.
pub(crate) fn check_package_json_name<'a>(
    at: &str,
    value: Option<&'a Value>,
) -> Result<&'a str, String> {
    match text(value) {
        Some(name) if is_package_json_name(name) => Ok(name),
        _ => Err(format!("{at}: expected a package.json name")),
    }
}

fn check_sidecar_ranges(at: &str, value: Option<&Value>) -> Result<(), String> {
    let map = object(at, value)?;
    for name in sorted_keys(map) {
        let place = format!("{at} {name}");
        check_package_json_name(&place, Some(&Value::from(name.as_str())))?;
        check_range(&place, map.get(name))?;
    }
    Ok(())
}

/// The local path of an absolute `file:` URL. %XX reads as that byte.
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
            // default: an escape that is not hexadecimal becomes the error "url has an invalid escape" below.
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .filter(|_| bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit())
            .ok_or("url has an invalid escape")?;
        path.push(byte);
        i += 3;
    }
    String::from_utf8(path).map_err(|_| "url is not UTF-8 after unescaping".to_string())
}

fn check_release_entry(at: &str, value: Option<&Value>) -> Result<(), String> {
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
    check_package_json_name("package.json name", pkg.get("name"))?;
    if pkg.contains_key("soksak") {
        return Err("package.json soksak: the sidecars of a plugin and their ranges are the dependencies of plugin.json".into());
    }
    check_version("package.json version", pkg.get("version")).map(|_| ())
}

/// Checks that the id that plugin.json names is the id of the installation record of the plugin. A release whose
/// plugin.json names another plugin is refused at installation and at the reading of the installed state
/// (docs/spec/installation.md#installation-layout).
pub fn check_plugin_id(id: &str, manifest: &Value) -> Result<(), String> {
    match manifest.get("id").and_then(Value::as_str) {
        None => Err("plugin.json id must be a string".to_string()),
        Some(found) if found != id => Err(format!(
            "plugin.json id {found} differs from the installed plugin {id}"
        )),
        Some(_) => Ok(()),
    }
}

/// The keywords that a schema may hold (check_schema of packages/plugin-api).
const SCHEMA_KEYWORDS: [&str; 4] = ["type", "properties", "items", "enum"];

/// The names that a schema type may use (SCHEMA_TYPES of packages/plugin-api).
const SCHEMA_TYPES: [&str; 7] = [
    "string", "number", "integer", "boolean", "object", "array", "null",
];

/// The kinds of an exposes declaration in the order that the reader checks them.
const EXPOSE_KINDS: [&str; 3] = ["status", "commands", "dom"];

/// The largest timeout of a command declaration in milliseconds (COMMAND_TIMEOUT_MAX).
const COMMAND_TIMEOUT_MAX: f64 = 600000.0;

/// The fields that an entry of an exposes kind holds beyond name and description.
fn expose_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "status" => &["schema"],
        "commands" => &["params", "result"],
        _ => &[],
    }
}

/// Whether the name has the form of the NAME rule of packages/plugin-api: lowercase letters and digits joined by
/// single dots or hyphens. The regex crate is not a dependency of this package, so the rule is written as a scan.
fn is_expose_name(name: &str) -> bool {
    let mut separator = true;
    for c in name.chars() {
        match c {
            'a'..='z' | '0'..='9' => separator = false,
            '.' | '-' if !separator => separator = true,
            _ => return false,
        }
    }
    !name.is_empty() && !separator
}

/// The text that the reader's template shows for a value: null as null, arrays joined by commas with null entries
/// empty, and objects as [object Object].
fn js_value_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_value_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// The text that the reader's template shows for a field: undefined when it is absent.
fn js_field_text(map: &Map<String, Value>, key: &str) -> String {
    map.get(key)
        .map_or_else(|| "undefined".to_string(), js_value_text)
}

/// Whether a schema type is a name of SCHEMA_TYPES or a list of such names. A JSON null is the name null, as the reader
/// reads it.
fn valid_schema_type(raw: &Value) -> bool {
    let names = match raw.as_array() {
        Some(list) => list.as_slice(),
        None => std::slice::from_ref(raw),
    };
    !names.is_empty()
        && names.iter().all(|name| match name {
            Value::Null => true,
            Value::String(text) => SCHEMA_TYPES.contains(&text.as_str()),
            _ => false,
        })
}

/// Whether a timeout is an integer from 1 to COMMAND_TIMEOUT_MAX.
fn valid_timeout(raw: &Value) -> bool {
    raw.as_f64()
        .is_some_and(|f| f.fract() == 0.0 && (1.0..=COMMAND_TIMEOUT_MAX).contains(&f))
}

/// Checks a schema the way the reader does (checkSchema of packages/plugin-api): only the keywords of SCHEMA_KEYWORDS,
/// type names of SCHEMA_TYPES, an object of properties, a schema of items and a non-empty array of enum. `at` names
/// the schema in the error.
pub fn check_schema(at: &str, value: &Value) -> Result<(), String> {
    let schema = value
        .as_object()
        .ok_or_else(|| format!("{at}: schema must be an object"))?;
    only(at, schema, &SCHEMA_KEYWORDS)?;
    if let Some(raw) = schema.get("type")
        && !valid_schema_type(raw)
    {
        return Err(format!("{at}: unknown schema type {}", quote(raw)));
    }
    if let Some(raw) = schema.get("properties") {
        let properties = raw
            .as_object()
            .ok_or_else(|| format!("{at}: properties must be an object"))?;
        for key in sorted_keys(properties) {
            check_schema(&format!("{at}.{key}"), &properties[key.as_str()])?;
        }
    }
    if let Some(raw) = schema.get("items") {
        check_schema(&format!("{at}[]"), raw)?;
    }
    if let Some(raw) = schema.get("enum")
        && !raw.as_array().is_some_and(|list| !list.is_empty())
    {
        return Err(format!("{at}: enum must be a non-empty array"));
    }
    Ok(())
}

/// Checks the exposes declaration of the plugin `owner` the way the reader does (validateExposes of
/// packages/plugin-api): the kinds status, commands and dom, and for each entry a name `<owner>.<name>`, a description,
/// the schemas of its fields, an object params schema of a command, a boolean many of a dom entry and a timeout of a
/// command. A name is declared once per kind.
pub fn check_exposes(owner: &str, exposes: &Value) -> Result<(), String> {
    let at = format!("{owner} exposes");
    let declared = exposes
        .as_object()
        .ok_or_else(|| format!("{at}: expected an object"))?;
    only(&at, declared, &EXPOSE_KINDS)?;
    let mut seen = BTreeSet::new();
    let prefix = format!("{owner}.");
    for kind in EXPOSE_KINDS {
        let Some(raw) = declared.get(kind) else {
            continue;
        };
        let entries = raw
            .as_array()
            .ok_or_else(|| format!("{at}: {kind} must be an array"))?;
        for item in entries {
            let entry = item
                .as_object()
                .ok_or_else(|| format!("{at}: {kind} entry must be an object"))?;
            let name = match entry.get("name").and_then(Value::as_str) {
                Some(name) if name.starts_with(&prefix) && is_expose_name(name) => name,
                _ => {
                    return Err(format!(
                        "{at}: name {} must be {owner}.<name> with lowercase letters, digits, dots, and hyphens",
                        js_field_text(entry, "name")
                    ));
                }
            };
            if !seen.insert(format!("{kind} {name}")) {
                return Err(format!("{at}: duplicate {kind} {name}"));
            }
            let at = format!("{at} {name}");
            let mut allowed = vec!["name", "description"];
            allowed.extend_from_slice(expose_fields(kind));
            if kind == "dom" {
                allowed.push("many");
            }
            if kind == "commands" {
                allowed.push("timeout");
            }
            only(&at, entry, &allowed)?;
            if text(entry.get("description")).is_none() {
                return Err(format!("{at}: description is required"));
            }
            for field in expose_fields(kind) {
                let raw = entry
                    .get(*field)
                    .ok_or_else(|| format!("{at}: {field} is required"))?;
                check_schema(&format!("{at} {field}"), raw)?;
            }
            if kind == "commands"
                && entry
                    .get("params")
                    .and_then(|params| params.get("type"))
                    .and_then(Value::as_str)
                    != Some("object")
            {
                return Err(format!("{at}: params must be an object schema"));
            }
            if entry.get("many").is_some_and(|raw| !raw.is_boolean()) {
                return Err(format!("{at}: many must be a boolean"));
            }
            if entry.get("timeout").is_some_and(|raw| !valid_timeout(raw)) {
                return Err(format!(
                    "{at}: timeout must be an integer from 1 to {COMMAND_TIMEOUT_MAX} milliseconds"
                ));
            }
        }
    }
    Ok(())
}

/// Checks the surface params schema and the exposes declaration of plugin.json in the order that the reader checks
/// them (validateManifest of packages/plugin-api). A surface that is not an object is not checked here.
pub fn check_plugin_schemas(id: &str, manifest: &Value) -> Result<(), String> {
    let at = format!("plugin {id}");
    if let Some(surface) = manifest.get("surface").and_then(Value::as_object)
        && let Some(params) = surface.get("params")
    {
        if !params.is_object() || params.get("type").and_then(Value::as_str) != Some("object") {
            return Err(format!(
                "{at}: surface params must be a schema of type object"
            ));
        }
        check_schema(&format!("{at} surface params"), params)?;
    }
    if let Some(exposes) = manifest.get("exposes") {
        if manifest.get("surface").is_none() && manifest.get("host").is_none() {
            return Err(format!("{at}: exposes require a surface or a plugin host"));
        }
        return check_exposes(id, exposes);
    }
    Ok(())
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

/// The file name of a plugin release.
pub fn release_name(id: &str, version: &str) -> String {
    format!("{id}-{version}.tgz")
}

/// Converts a sidecar name to the form used for file names and folder names. `@scope/name` becomes `scope-name`.
pub fn sidecar_file_name(name: &str) -> Result<String, String> {
    check_package_json_name("sidecar", Some(&Value::from(name)))?;
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

/// The file name of a sidecar release.
pub fn sidecar_release_name(name: &str, version: &str, platform: &str) -> Result<String, String> {
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

/// The folder in the configuration folder that unpacks one plugin version.
pub fn plugin_install_path(id: &str, version: &str) -> Result<String, String> {
    if !is_identifier(id) {
        return Err(format!("invalid plugin id {id}"));
    }
    // The core root is the reserved host `core` (docs/spec/plugin-processes.md rule 4), so no plugin may be installed under that id.
    if id == "core" {
        return Err(format!("plugin id {id} is reserved for the core root"));
    }
    check_version(&format!("plugin {id} version"), Some(&Value::from(version)))?;
    Ok(format!("plugins/{id}/{version}"))
}

/// The folder in the configuration directory that the release of one sidecar version and platform is extracted into.
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

/// The address and hash of a release.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Release {
    pub url: String,
    pub sha256: String,
}

/// The core range that a plugin version supports.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Engines {
    pub soksak: String,
}

/// One plugin version of the registry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginVersion {
    pub version: String,
    pub release: Release,
    pub engines: Engines,
    pub sidecars: BTreeMap<String, String>,
}

/// A plugin entry of the registry.
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

/// One sidecar version of the registry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SidecarVersion {
    pub version: String,
    pub protocol: u64,
    pub releases: BTreeMap<String, Release>,
}

/// A sidecar entry of the registry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistrySidecar {
    pub name: String,
    pub repository: String,
    pub versions: Vec<SidecarVersion>,
}

/// A bundle of plugins that are installed together.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryPack {
    pub name: String,
    pub description: String,
    pub plugins: Vec<String>,
}

/// A plugin version that must not be installed.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RevokedPlugin {
    pub id: String,
    pub version: String,
    pub reason: String,
}

/// A sidecar version that must not be installed or run.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RevokedSidecar {
    pub name: String,
    pub version: String,
    pub reason: String,
}

/// A core version that an application must not update to.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RevokedCore {
    pub version: String,
    pub reason: String,
}

/// A version that must not be installed or run.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Revoked {
    pub plugins: Vec<RevokedPlugin>,
    pub sidecars: Vec<RevokedSidecar>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub core: Vec<RevokedCore>,
}

/// The hosts of an application release.
pub const CORE_HOSTS: [&str; 2] = ["tauriv2", "wailsv3"];

/// One core release of the registry: the zip of the application bundle for each platform and host.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoreRelease {
    pub version: String,
    pub releases: BTreeMap<String, Release>,
}

/// The core releases of the registry.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RegistryCore {
    pub versions: Vec<CoreRelease>,
}

/// The checked registry index.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Index {
    pub format: u64,
    pub plugins: Vec<RegistryPlugin>,
    pub sidecars: Vec<RegistrySidecar>,
    /// The core releases; an index without them lists none (docs/spec/installation.md#application-update).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core: Option<RegistryCore>,
    pub packs: Vec<RegistryPack>,
    pub revoked: Revoked,
}

/// The location with the entry name appended when the name is a string.
fn entry_at(kind: &str, map: &Map<String, Value>, key: &str) -> String {
    match map.get(key).and_then(Value::as_str) {
        Some(name) => format!("{kind} {name}"),
        None => kind.to_string(),
    }
}

/// Checks one plugin entry of the registry (`plugins/<id>.json`).
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
    check_package_json_name(&format!("{at} package"), entry.get("package"))?;
    if text(entry.get("repository")).is_none() {
        return Err(format!("{at}: repository is required"));
    }
    let mut seen = BTreeSet::new();
    for raw in array(&format!("{at} versions"), entry.get("versions"))? {
        let item = object(&format!("{at} version"), Some(raw))?;
        only(
            &format!("{at} version"),
            item,
            &["engines", "release", "sidecars", "version"],
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
        check_release_entry(&format!("{at} {version} release"), item.get("release"))?;
        check_sidecar_ranges(&format!("{at} {version} sidecars"), item.get("sidecars"))?;
    }
    if seen.is_empty() {
        return Err(format!("{at}: versions is empty"));
    }
    Ok(())
}

/// Checks one sidecar entry of the registry (`sidecars/<file name>.json`).
pub fn validate_registry_sidecar(value: &Value) -> Result<(), String> {
    let entry = object("registry sidecar", Some(value))?;
    let at = entry_at("registry sidecar", entry, "name");
    only(&at, entry, &["name", "repository", "versions"])?;
    check_package_json_name(&format!("{at} name"), entry.get("name"))?;
    if text(entry.get("repository")).is_none() {
        return Err(format!("{at}: repository is required"));
    }
    let mut seen = BTreeSet::new();
    for raw in array(&format!("{at} versions"), entry.get("versions"))? {
        let item = object(&format!("{at} version"), Some(raw))?;
        only(
            &format!("{at} version"),
            item,
            &["protocol", "releases", "version"],
        )?;
        let version = check_version(&format!("{at} version"), item.get("version"))?;
        if !seen.insert(version.to_string()) {
            return Err(format!("{at}: version {version} appears twice"));
        }
        let releases = object(&format!("{at} {version} releases"), item.get("releases"))?;
        if releases.is_empty() {
            return Err(format!("{at} {version}: releases is empty"));
        }
        for platform in sorted_keys(releases) {
            check_platform(platform).map_err(|error| format!("{at} {version}: {error}"))?;
            check_release_entry(
                &format!("{at} {version} {platform}"),
                releases.get(platform),
            )?;
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

/// Splits the key of a core release into its platform and host.
fn split_core_key(key: &str) -> Result<(&str, &str), String> {
    let Some((platform, host)) = key.rsplit_once('-') else {
        return Err(format!("{key} is not <platform>-<host>"));
    };
    // The last part of a platform key is an architecture, so it is not a host: the key lacks the host.
    if PLATFORMS.contains(&key) {
        return Err(format!("{key} is not <platform>-<host>"));
    }
    check_platform(platform)?;
    if !CORE_HOSTS.contains(&host) {
        return Err(format!("unknown host {host}"));
    }
    Ok((platform, host))
}

/// Checks the core list of the registry (`core.json`): each version has releases of platform and host keys.
pub fn validate_registry_core(value: &Value) -> Result<(), String> {
    let core = object("registry core", Some(value))?;
    only("registry core", core, &["versions"])?;
    let mut seen = BTreeSet::new();
    for raw in array("registry core versions", core.get("versions"))? {
        let item = object("registry core version", Some(raw))?;
        only("registry core version", item, &["releases", "version"])?;
        let version = check_version("registry core version", item.get("version"))?;
        if !seen.insert(version.to_string()) {
            return Err(format!("registry core: version {version} appears twice"));
        }
        let releases = object(
            &format!("registry core {version} releases"),
            item.get("releases"),
        )?;
        if releases.is_empty() {
            return Err(format!("registry core {version}: releases is empty"));
        }
        for key in sorted_keys(releases) {
            split_core_key(key).map_err(|error| format!("registry core {version}: {error}"))?;
            check_release_entry(&format!("registry core {version} {key}"), releases.get(key))?;
        }
    }
    Ok(())
}

/// Checks one pack entry of the registry (`packs/<name>.json`).
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

/// Checks the revoked list of the registry (`revoked.json`).
pub fn validate_revoked(value: &Value) -> Result<(), String> {
    let revoked = object("registry revoked", Some(value))?;
    only(
        "registry revoked",
        revoked,
        &["core", "plugins", "sidecars"],
    )?;
    // A revoked list without core withdraws no core version.
    if let Some(raw) = revoked.get("core") {
        let at = "registry revoked core";
        for raw in array(at, Some(raw))? {
            let item = object(at, Some(raw))?;
            only(at, item, &["reason", "version"])?;
            let version = check_version(at, item.get("version"))?;
            if text(item.get("reason")).is_none() {
                return Err(format!("{at} {version}: reason is required"));
            }
        }
    }
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

/// Moves the checked values to the format structures.
fn typed<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

/// Checks the registry index. For each entry it checks the format, that names do not overlap, that packs and revoked entries refer to existing plugins and
/// sidecars, and that each plugin version has sidecar versions that satisfy the sidecar ranges it requires.
pub fn validate_registry_index(value: &Value) -> Result<Index, String> {
    let root = object("registry index", Some(value))?;
    only(
        "registry index",
        root,
        &["core", "format", "packs", "plugins", "revoked", "sidecars"],
    )?;
    if let Some(core) = root.get("core") {
        validate_registry_core(core)?;
    }
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
    for item in &index.revoked.core {
        let listed = index.core.as_ref().is_some_and(|core| {
            core.versions
                .iter()
                .any(|candidate| candidate.version == item.version)
        });
        if !listed {
            return Err(format!(
                "registry index: revoked core {} is not listed",
                item.version
            ));
        }
    }
    Ok(index)
}

/// One installed plugin.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct InstalledPlugin {
    pub version: String,
    /// The absolute folder in which the version that the installation uses is unpacked.
    pub path: String,
    pub enabled: bool,
    pub sidecars: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

/// One installed sidecar. path is the absolute folder that installation extracted its platform release into.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct InstalledSidecar {
    pub version: String,
    pub path: String,
}

/// The installation state file (`plugins/installed.json`). For each plugin id it holds the package.json name, the version in use, the unpacked folder, whether the plugin is enabled, the
/// sidecar ranges of that version and the previous version to restore. For each sidecar it holds the one version that all plugins share and its
/// folder. The installation records the folder, and the host reads only recorded folders.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct InstalledState {
    pub format: u64,
    pub plugins: BTreeMap<String, InstalledPlugin>,
    pub sidecars: BTreeMap<String, InstalledSidecar>,
}

/// Checks that the path of a plugin is the folder plugins/<id>/<version> of the installation rule.
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

/// Checks that the path of a sidecar is the folder sidecars/<file name>/<version>/<platform> of the installation rule.
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
    /// The state in which nothing is installed.
    pub fn empty() -> Self {
        InstalledState {
            format: INSTALLED_FORMAT,
            plugins: BTreeMap::new(),
            sidecars: BTreeMap::new(),
        }
    }
}

/// Checks the installation state file.
pub fn validate_installed(value: &Value) -> Result<InstalledState, String> {
    let root = object(INSTALLED, Some(value))?;
    only(INSTALLED, root, &["format", "plugins", "sidecars"])?;
    if root.get("format").and_then(Value::as_u64) != Some(INSTALLED_FORMAT) {
        return Err(format!("{INSTALLED}: format must be {INSTALLED_FORMAT}"));
    }
    let plugins = object(&format!("{INSTALLED} plugins"), root.get("plugins"))?;
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
            &["enabled", "path", "previous", "sidecars", "version"],
        )?;
        if !item.get("enabled").is_some_and(Value::is_boolean) {
            return Err(format!("{at}: enabled must be true or false"));
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

/// One sidecar version to install with its platform release.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectedSidecar {
    pub name: String,
    pub version: String,
    pub release: Release,
}

/// The plugin version to install and its sidecar versions.
#[derive(Clone, Debug)]
pub struct Selection<'a> {
    pub plugin: &'a RegistryPlugin,
    pub version: &'a PluginVersion,
    pub sidecars: Vec<SelectedSidecar>,
}

pub(crate) fn newer(a: &str, b: &str) -> bool {
    matches!((parse_version(a), parse_version(b)), (Ok(x), Ok(y)) if x > y)
}

/// Selects the plugin version to install and its sidecar versions. The plugin version is the newest one whose
/// engines.soksak contains core, that is not revoked, and that satisfies every range of needs, the ranges of the
/// installed plugins that name the plugin. An installation has one version of a sidecar, so it satisfies the range of
/// the selected version and the ranges that the other installed plugins name. The version in use is kept when it
/// satisfies every range, is not revoked and has a release for the platform; otherwise the newest such version is
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
            if !item.releases.contains_key(platform) || !fits || revoked {
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
            release: version.releases[platform].clone(),
        });
    }
    Ok(Selection {
        plugin,
        version: chosen,
        sidecars,
    })
}

/// The declarations of an installed plugin that the granted item rule reads: the name of its package (package.json) and
/// the content of its plugin.json.
pub struct PluginFiles {
    pub package: String,
    pub manifest: Value,
}

/// An extension point that a plugin declares in extends. version is None when the point has no version.
struct GrantedPoint {
    version: Option<Version>,
    modules: BTreeMap<String, String>,
}

/// An item that a plugin contributes to the point `point` of the plugin `provider`.
struct GrantedItem {
    provider: String,
    point: String,
    range: Range,
    module: String,
}

/// The declarations that the granted item rule reads from one plugin.
struct GrantedPlugin {
    package: String,
    points: BTreeMap<String, GrantedPoint>,
    items: Vec<GrantedItem>,
}

/// Checks that a module path names a file inside the package: a relative path whose segments are neither empty, `.`
/// nor `..`. It returns the path.
fn check_module_path(at: &str, value: Option<&Value>) -> Result<String, String> {
    match value.and_then(Value::as_str) {
        Some(path)
            if !path.is_empty()
                && !path.starts_with('/')
                && !path
                    .split('/')
                    .any(|segment| segment.is_empty() || segment == "." || segment == "..") =>
        {
            Ok(path.to_string())
        }
        _ => Err(format!(
            "{at}: module must be a relative path inside the package, got {}",
            shown(value)
        )),
    }
}

/// Reads the extends and contributes declarations of plugin id and checks each one that the granted item rule uses. A
/// malformed declaration is an error, not a missing grant.
fn granted_declarations(id: &str, files: &PluginFiles) -> Result<GrantedPlugin, String> {
    let at = format!("{id} plugin.json");
    if files.package.is_empty() {
        return Err(format!("installed plugin {id} has no package name"));
    }
    let manifest = object(&at, Some(&files.manifest))?;
    let mut plugin = GrantedPlugin {
        package: files.package.clone(),
        points: BTreeMap::new(),
        items: vec![],
    };
    if let Some(extends) = manifest.get("extends") {
        let extends = object(&format!("{at} extends"), Some(extends))?;
        for name in sorted_keys(extends) {
            let point_at = format!("{at} extends {name}");
            let point = object(&point_at, extends.get(name))?;
            let mut entry = GrantedPoint {
                version: None,
                modules: BTreeMap::new(),
            };
            if let Some(value) = point.get("version") {
                let text = check_version(&format!("{point_at} version"), Some(value))?;
                entry.version = Some(
                    parse_version(text).map_err(|error| format!("{point_at} version: {error}"))?,
                );
            }
            if let Some(value) = point.get("modules") {
                let modules = object(&format!("{point_at} modules"), Some(value))?;
                for specifier in sorted_keys(modules) {
                    let path = check_module_path(
                        &format!("{point_at} modules {specifier}"),
                        modules.get(specifier),
                    )?;
                    entry.modules.insert(specifier.clone(), path);
                }
            }
            plugin.points.insert(name.clone(), entry);
        }
    }
    if let Some(contributes) = manifest.get("contributes") {
        let contributes = object(&format!("{at} contributes"), Some(contributes))?;
        for key in sorted_keys(contributes) {
            let Some((provider, point)) = key.split_once('.') else {
                return Err(format!(
                    "{at} contributes {key}: the key must be <plugin id>.<point>"
                ));
            };
            if provider.is_empty() || point.is_empty() {
                return Err(format!(
                    "{at} contributes {key}: the key must be <plugin id>.<point>"
                ));
            }
            let key_at = format!("{at} contributes {key}");
            for raw in array(&key_at, contributes.get(key))? {
                let item = object(&format!("{key_at} item"), Some(raw))?;
                let range = match item.get("range").and_then(Value::as_str) {
                    Some(text) => {
                        parse_range(text).map_err(|error| format!("{key_at} range: {error}"))?
                    }
                    None => {
                        return Err(format!(
                            "{key_at} range: invalid version range {}",
                            shown(item.get("range"))
                        ));
                    }
                };
                let module = check_module_path(&format!("{key_at} module"), item.get("module"))?;
                plugin.items.push(GrantedItem {
                    provider: provider.to_string(),
                    point: point.to_string(),
                    range,
                    module,
                });
            }
        }
    }
    Ok(plugin)
}

/// Whether a point declares a version and the range of an item contains it.
fn granted_by(point: &GrantedPoint, range: &Range) -> bool {
    point
        .version
        .as_ref()
        .is_some_and(|version| range.contains(version))
}

/// Adds the core root path of each shared module of the point `id.point`.
fn add_shared(paths: &mut BTreeSet<String>, id: &str, point: &str, entry: &GrantedPoint) {
    for specifier in entry.modules.keys() {
        paths.insert(format!("/shared/{id}.{point}/{specifier}.js"));
    }
}

/// Returns the files that a view of the requester may read, in the core root form (docs/spec/installation.md):
/// `/modules/<package>/<module>` for the module of each granted item that another plugin contributes to a point of the
/// requester, and `/shared/<plugin id>.<point>/<specifier>.js` for each shared module of a point that has a granted item
/// of another plugin, whether the requester provides the point or contributes to it. An item is granted when its
/// contributor and its provider are installed and the provider is enabled, the point declares a version, and the range
/// of the item contains that version. The requester must be installed; its own enabled state is not checked. Every
/// enabled plugin and the requester must have files, and each declaration that the rule reads must be well formed, or
/// an error names it. The result is sorted and has no repeated path.
pub fn granted_files(
    state: &InstalledState,
    files: &BTreeMap<String, PluginFiles>,
    requester: &str,
) -> Result<Vec<String>, String> {
    if !state.plugins.contains_key(requester) {
        return Err(format!("plugin {requester} is not installed"));
    }
    let mut plugins = BTreeMap::new();
    for (id, plugin) in &state.plugins {
        if !plugin.enabled && id.as_str() != requester {
            continue;
        }
        let entry = files
            .get(id)
            .ok_or_else(|| format!("installed plugin {id} has no package.json and plugin.json"))?;
        plugins.insert(id.clone(), granted_declarations(id, entry)?);
    }
    let me = &plugins[requester];
    let mut paths = BTreeSet::new();
    // The requester provides the points. A granted item of another plugin adds its module and the shared modules of its point.
    let mut provided: BTreeMap<&str, &GrantedPoint> = BTreeMap::new();
    for (id, contributor) in &plugins {
        if id.as_str() == requester {
            continue;
        }
        for item in &contributor.items {
            let Some(point) = me.points.get(&item.point) else {
                continue;
            };
            if item.provider != requester || !granted_by(point, &item.range) {
                continue;
            }
            paths.insert(format!("/modules/{}/{}", contributor.package, item.module));
            provided.insert(&item.point, point);
        }
    }
    for (point, entry) in provided {
        add_shared(&mut paths, requester, point, entry);
    }
    // The requester contributes to the points of other plugins. Each point with a granted item adds its shared modules.
    let mut contributed: BTreeMap<(&str, &str), &GrantedPoint> = BTreeMap::new();
    for item in &me.items {
        if item.provider == requester {
            continue;
        }
        let Some(provider) = plugins.get(&item.provider) else {
            continue;
        };
        let Some(point) = provider.points.get(&item.point) else {
            continue;
        };
        if granted_by(point, &item.range) {
            contributed.insert((&item.provider, &item.point), point);
        }
    }
    for ((provider, point), entry) in contributed {
        add_shared(&mut paths, provider, point, entry);
    }
    Ok(paths.into_iter().collect())
}
