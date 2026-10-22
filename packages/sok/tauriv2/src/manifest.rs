//! The plugin.json checks of the page reader (validateManifest of packages/plugin-api/index.js). `validate_manifest`
//! applies the reader's checks in the reader's order with the reader's error texts, so pack and install refuse exactly
//! the manifests that the page refuses (docs/spec/installation.md#plugin-release). The reader checks the members of each
//! object in sorted key order, and so does this file, so the first refused member is the same in both. The checks use
//! the reader's own rules: its version regular expressions and the UTF-16 length that its string checks count.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

/// The limits that the reader names (PLUGIN_DESCRIPTION_MAX, SETTING_LABEL_MAX, SETTING_DESCRIPTION_MAX, ADDRESS_MAX,
/// SET_TITLE_MAX, the menu title limit and COMMAND_TIMEOUT_MAX).
const PLUGIN_DESCRIPTION_MAX: usize = 200;
const SETTING_LABEL_MAX: usize = 40;
const SETTING_DESCRIPTION_MAX: usize = 200;
const ADDRESS_MAX: usize = 2048;
const SET_TITLE_MAX: usize = 40;
const MENU_TITLE_MAX: usize = 40;
const COMMAND_TIMEOUT_MAX: f64 = 600000.0;

/// The members that plugin.json may hold (validateManifest).
const TOP_LEVEL_KEYS: [&str; 19] = [
    "id",
    "name",
    "description",
    "mark",
    "icon",
    "surface",
    "sections",
    "preview",
    "dependencies",
    "background",
    "exposes",
    "settings",
    "data",
    "sidebars",
    "extends",
    "contributes",
    "events",
    "host",
    "hostOperations",
];

/// The keywords that a schema may hold (checkSchema of packages/plugin-api).
const SCHEMA_KEYWORDS: [&str; 4] = ["type", "properties", "items", "enum"];

/// The names that a schema type may use (SCHEMA_TYPES of packages/plugin-api).
const SCHEMA_TYPES: [&str; 7] = [
    "string", "number", "integer", "boolean", "object", "array", "null",
];

/// The kinds of an exposes declaration (EXPOSE_KINDS of packages/plugin-api).
const EXPOSE_KINDS: [&str; 3] = ["status", "commands", "dom"];

/// The sorted keys of an object: the order in which the checks read the members.
fn sorted_keys(map: &Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    keys
}

/// Refuses the first member that is not in keys, in sorted key order (only of the reader).
fn only(at: &str, map: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    match sorted_keys(map)
        .into_iter()
        .find(|key| !keys.contains(&key.as_str()))
    {
        Some(key) => Err(format!("{at}: unknown field {key}")),
        None => Ok(()),
    }
}

/// The length of a string in UTF-16 code units, the length that the reader's string checks count.
fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The text of a value the way the reader's template text shows it: null as null, a list joined by commas with null
/// entries empty, and an object as [object Object].
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

/// The text of a member of an object the way the reader's template text shows it: undefined when it is absent.
fn js_field_text(map: &Map<String, Value>, key: &str) -> String {
    map.get(key)
        .map_or_else(|| "undefined".to_string(), js_value_text)
}

/// The value of a member when it is a number with an integer value.
fn integer_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.fract() == 0.0)
}

/// Whether the member is a non-empty string (isText of the reader).
fn is_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

/// Whether the value is a JavaScript path inside the package (isModulePath of the reader).
fn is_module_path(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|path| {
        !path.is_empty()
            && !path.starts_with('/')
            && !path.split('/').any(|part| part == "..")
            && path.ends_with(".js")
    })
}

/// Whether the text is an identifier of the form `[a-z][a-z0-9-]*` (ID of the reader).
fn is_id(text: &str) -> bool {
    text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Whether the text is a package name `name` or `@scope/name` (PACKAGE of the reader).
fn is_package(text: &str) -> bool {
    let (scope, name) = match text.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((scope, name)) => (Some(scope), name),
            None => return false,
        },
        None => (None, text),
    };
    let lower = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    scope.is_none_or(lower) && lower(name)
}

/// Whether the text is a theme token name `--name` (TOKEN of the reader).
fn is_token(text: &str) -> bool {
    match text.strip_prefix("--") {
        Some(rest) => {
            rest.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }
        None => false,
    }
}

/// Whether the text is a setting name (SETTING of the reader): dot-separated parts that start with a lowercase letter.
fn is_setting_name(text: &str) -> bool {
    text.split('.').all(|part| {
        part.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// Whether the text is a region or overlay name (REGION of the reader): a lowercase letter or digit, then up to 63
/// lowercase letters, digits or hyphens.
fn is_region_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Whether the text is a name of an exposure entry (NAME of the reader): lowercase letters and digits joined by single
/// dots or hyphens.
fn is_expose_name(text: &str) -> bool {
    let mut separator = true;
    for c in text.chars() {
        match c {
            'a'..='z' | '0'..='9' => separator = false,
            '.' | '-' if !separator => separator = true,
            _ => return false,
        }
    }
    !text.is_empty() && !separator
}

/// Whether the text is `x.y.z` with numeric parts and no leading zeros (VERSION of the reader).
fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (*part == "0" || !part.starts_with('0'))
        })
}

/// Compares two versions by their numeric parts, the first differing part deciding (compareVersion of the reader). The
/// parts have no leading zeros (is_version), so a longer part is the larger number and equal lengths compare as text.
fn compare_version(a: &str, b: &str) -> std::cmp::Ordering {
    a.split('.')
        .zip(b.split('.'))
        .map(|(x, y)| x.len().cmp(&y.len()).then_with(|| x.cmp(y)))
        .find(|order| !order.is_eq())
        // default: the versions have equal parts up to the shorter one; a missing part compares as equal.
        .unwrap_or(std::cmp::Ordering::Equal)
}

/// Whether the member is a version range with the reader's forms: `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, and
/// `>=x.y.z <a.b.c` whose lower bound is below the upper bound (isRange of the reader).
fn is_range(value: Option<&Value>) -> bool {
    let Some(text) = value.and_then(Value::as_str) else {
        return false;
    };
    if text == "*" {
        return true;
    }
    if let Some(rest) = text.strip_prefix(">=") {
        if let Some((low, high)) = rest.split_once(" <")
            && !low.contains(' ')
            && !high.contains(' ')
        {
            return is_version(low)
                && is_version(high)
                && compare_version(low, high) == std::cmp::Ordering::Less;
        }
        if !rest.contains(' ') {
            return is_version(rest);
        }
        return false;
    }
    let bare = text
        .strip_prefix('^')
        .or_else(|| text.strip_prefix('~'))
        // default: a range without an operator is the exact version.
        .unwrap_or(text);
    is_version(bare)
}

/// Whether two JSON values are equal as the reader compares them: objects have the same members in any order, lists have
/// equal items in order, and numbers have the same value.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_json(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| same_json(value, other)))
        }
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// Whether a value satisfies a type name (the matchers of SCHEMA_TYPES).
fn schema_type_matches(name: &str, value: &Value) -> bool {
    match name {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => integer_value(Some(value)).is_some(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        _ => false,
    }
}

/// Whether a value satisfies a schema that check_schema accepted (matchesSchema of the reader). Properties check only the
/// members that the value has.
fn matches_schema(schema: &Map<String, Value>, value: &Value) -> bool {
    if let Some(list) = schema.get("enum").and_then(Value::as_array)
        && !list.iter().any(|item| same_json(item, value))
    {
        return false;
    }
    if let Some(raw) = schema.get("type") {
        let names: Vec<&Value> = match raw.as_array() {
            Some(list) => list.iter().collect(),
            None => vec![raw],
        };
        if !names
            .iter()
            .any(|name| name.as_str().is_some_and(|n| schema_type_matches(n, value)))
        {
            return false;
        }
    }
    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) {
        for key in sorted_keys(properties) {
            if let Some(sub) = object.get(key)
                && let Some(sub_schema) = properties[key.as_str()].as_object()
                && !matches_schema(sub_schema, sub)
            {
                return false;
            }
        }
    }
    if let (Some(items), Some(list)) = (schema.get("items"), value.as_array()) {
        let item_schema = items.as_object();
        for item in list {
            if let Some(item_schema) = item_schema
                && !matches_schema(item_schema, item)
            {
                return false;
            }
        }
    }
    true
}

/// Whether a type of a schema is a name of SCHEMA_TYPES or a non-empty list of such names (a JSON null is refused).
fn valid_schema_type(raw: &Value) -> bool {
    let names: &[Value] = match raw.as_array() {
        Some(list) => list.as_slice(),
        None => std::slice::from_ref(raw),
    };
    !names.is_empty()
        && names.iter().all(|name| {
            name.as_str()
                .is_some_and(|text| SCHEMA_TYPES.contains(&text))
        })
}

/// Checks a schema the way the reader does (checkSchema of packages/plugin-api). `at` names the schema in the error.
fn check_schema(at: &str, value: Option<&Value>) -> Result<(), String> {
    let schema = value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{at}: schema must be an object"))?;
    only(at, schema, &SCHEMA_KEYWORDS)?;
    if let Some(raw) = schema.get("type")
        && !valid_schema_type(raw)
    {
        return Err(format!("{at}: unknown schema type {}", value_text(raw)));
    }
    if let Some(raw) = schema.get("properties") {
        let properties = raw
            .as_object()
            .ok_or_else(|| format!("{at}: properties must be an object"))?;
        for key in sorted_keys(properties) {
            check_schema(&format!("{at}.{key}"), properties.get(key))?;
        }
    }
    if let Some(raw) = schema.get("items") {
        check_schema(&format!("{at}[]"), Some(raw))?;
    }
    if let Some(raw) = schema.get("enum")
        && !raw.as_array().is_some_and(|list| !list.is_empty())
    {
        return Err(format!("{at}: enum must be a non-empty array"));
    }
    Ok(())
}

/// The JSON text of a value, as JSON.stringify writes it.
fn value_text(value: &Value) -> String {
    value.to_string()
}

/// Checks the exposes declaration of the plugin `owner` (validateExposes of the reader): the kinds status, commands and
/// dom, and for each entry a name `<owner>.<name>`, a description, the schemas of its fields, an object params schema of
/// a command, a boolean many of a dom entry and a timeout of a command. A name is declared once per kind.
fn check_exposes(owner: &str, exposes: &Value) -> Result<(), String> {
    let at = format!("{owner} exposes");
    let declared = exposes
        .as_object()
        .ok_or_else(|| format!("{at}: expected an object"))?;
    only(&at, declared, &EXPOSE_KINDS)?;
    let mut seen = BTreeSet::new();
    let prefix = format!("{owner}.");
    for kind in sorted_keys(declared) {
        let entries = declared[kind.as_str()]
            .as_array()
            .ok_or_else(|| format!("{at}: {kind} must be an array"))?;
        let fields: &[&str] = match kind.as_str() {
            "status" => &["schema"],
            "commands" => &["params", "result"],
            _ => &[],
        };
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
            let at_entry = format!("{at} {name}");
            let mut allowed = vec!["name", "description"];
            allowed.extend_from_slice(fields);
            if kind == "dom" {
                allowed.push("many");
            }
            if kind == "commands" {
                allowed.push("timeout");
            }
            only(&at_entry, entry, &allowed)?;
            if !is_text(entry.get("description")) {
                return Err(format!("{at_entry}: description is required"));
            }
            for field in fields {
                let raw = entry
                    .get(*field)
                    .ok_or_else(|| format!("{at_entry}: {field} is required"))?;
                check_schema(&format!("{at_entry} {field}"), Some(raw))?;
            }
            if kind == "commands"
                && entry
                    .get("params")
                    .and_then(|params| params.get("type"))
                    .and_then(Value::as_str)
                    != Some("object")
            {
                return Err(format!("{at_entry}: params must be an object schema"));
            }
            if entry.get("many").is_some_and(|raw| !raw.is_boolean()) {
                return Err(format!("{at_entry}: many must be a boolean"));
            }
            if entry.get("timeout").is_some_and(|raw| {
                !integer_value(Some(raw)).is_some_and(|f| (1.0..=COMMAND_TIMEOUT_MAX).contains(&f))
            }) {
                return Err(format!(
                    "{at_entry}: timeout must be an integer from 1 to 600000 milliseconds"
                ));
            }
        }
    }
    Ok(())
}

/// The command names that exposes declares (`exposes.commands` when it is a list, else none).
fn declared_commands(manifest: &Map<String, Value>) -> Vec<&str> {
    manifest
        .get("exposes")
        .and_then(|exposes| exposes.get("commands"))
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| command.get("name").and_then(Value::as_str))
                .collect()
        })
        // default: names that are not text declare no command; the menu, save and drop checks then refuse the name.
        .unwrap_or_default()
}

/// The status names that exposes declares (`exposes.status` when it is a list, else none).
fn declared_statuses(manifest: &Map<String, Value>) -> Vec<&str> {
    manifest
        .get("exposes")
        .and_then(|exposes| exposes.get("status"))
        .and_then(Value::as_array)
        .map(|statuses| {
            statuses
                .iter()
                .filter_map(|status| status.get("name").and_then(Value::as_str))
                .collect()
        })
        // default: names that are not text declare no status; the section check then refuses the status.
        .unwrap_or_default()
}

/// Checks the dependencies of plugin.json and returns the names with their ranges (checkDependencies of the reader).
fn check_dependencies(where_: &str, raw: &Value) -> Result<Map<String, Value>, String> {
    let deps = raw.as_object().ok_or_else(|| {
        format!("{where_}: dependencies must map sidecars and plugins to version ranges")
    })?;
    for name in sorted_keys(deps) {
        if !is_package(name) {
            return Err(format!(
                "{where_}: dependencies: {name} is not a sidecar or plugin name"
            ));
        }
        if !is_range(deps.get(name)) {
            return Err(format!(
                "{where_}: dependencies {name}: invalid range {}",
                js_value_text(&deps[name.as_str()])
            ));
        }
    }
    Ok(deps.clone())
}

/// Checks the plugin host declaration (checkHost of the reader).
fn check_host(where_: &str, raw: &Value) -> Result<(), String> {
    let host = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: host must be an object"))?;
    only(&format!("{where_} host"), host, &["page", "state"])?;
    let page = host.get("page").and_then(Value::as_str);
    if !page
        .is_some_and(|p| !p.is_empty() && !p.starts_with('/') && !p.split('/').any(|s| s == ".."))
    {
        return Err(format!(
            "{where_}: host page must be a path inside the package"
        ));
    }
    let Some(state_raw) = host.get("state") else {
        return Ok(());
    };
    let state = state_raw
        .as_object()
        .ok_or_else(|| format!("{where_}: host state must be an object"))?;
    only(
        &format!("{where_} host state"),
        state,
        &["format", "maxBytes"],
    )?;
    for key in ["format", "maxBytes"] {
        if !integer_value(state.get(key)).is_some_and(|f| f >= 1.0) {
            return Err(format!(
                "{where_}: host state {key} must be a positive integer"
            ));
        }
    }
    Ok(())
}

/// Checks the plugin host operations: each name is a dependency and each value is a list of distinct operation names
/// (checkHostOperationsDeclaration of the reader).
fn check_host_operations(
    where_: &str,
    raw: &Value,
    dependencies: &Map<String, Value>,
) -> Result<(), String> {
    let operations = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: hostOperations must map sidecars to operations"))?;
    for name in sorted_keys(operations) {
        if !dependencies.contains_key(name.as_str()) {
            return Err(format!(
                "{where_}: hostOperations {name} is not a dependency"
            ));
        }
        let shape =
            format!("{where_}: hostOperations {name} must be a list of distinct operation names");
        let list = operations[name.as_str()]
            .as_array()
            .ok_or_else(|| shape.clone())?;
        if list.is_empty() {
            return Err(shape);
        }
        let mut seen = BTreeSet::new();
        for item in list {
            match item.as_str() {
                Some(operation) if !operation.is_empty() && seen.insert(operation) => {}
                _ => return Err(shape),
            }
        }
    }
    Ok(())
}

/// Checks the extension point declarations of a provider (checkExtends of the reader).
fn check_extends(where_: &str, raw: &Value) -> Result<(), String> {
    let points = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: extends must be an object"))?;
    for name in sorted_keys(points) {
        if !is_id(name) {
            return Err(format!("{where_}: invalid extension point {name}"));
        }
        let at = format!("{where_} extension point {name}");
        let point = points[name.as_str()]
            .as_object()
            .ok_or_else(|| format!("{at}: must be an object"))?;
        only(&at, point, &["version", "schema", "modules"])?;
        let version = point.get("version").and_then(Value::as_str);
        if !version.is_some_and(is_version) {
            return Err(format!("{at} version must be x.y.z"));
        }
        check_schema(&format!("{at} schema"), point.get("schema"))?;
        if let Some(modules_raw) = point.get("modules") {
            let modules = modules_raw
                .as_object()
                .ok_or_else(|| format!("{at}: modules must be an object"))?;
            for specifier in sorted_keys(modules) {
                if !is_bare_specifier(specifier) {
                    return Err(format!("{at} module {specifier} is not a bare specifier"));
                }
                if !is_module_path(modules.get(specifier)) {
                    return Err(format!(
                        "{at} module {specifier} must be a JavaScript path inside the package"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Whether the text is a bare specifier (BARE of the reader): a package name or a name with a subpath.
fn is_bare_specifier(text: &str) -> bool {
    let (package, subpath) = match text.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((scope, tail)) => {
                if !scope
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    || scope.is_empty()
                {
                    return false;
                }
                match tail.split_once('/') {
                    Some((name, sub)) => (name, Some(sub)),
                    None => (tail, None),
                }
            }
            None => return false,
        },
        None => match text.split_once('/') {
            Some((name, sub)) => (name, Some(sub)),
            None => (text, None),
        },
    };
    let package_ok = package
        .as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && package.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-'
        });
    let subpath_ok = subpath.is_none_or(|sub| {
        !sub.is_empty()
            && sub.split('/').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
            })
    });
    package_ok && subpath_ok
}

/// Checks the contributions of a contributor (checkContributes of the reader).
fn check_contributes(where_: &str, id: &str, raw: &Value) -> Result<(), String> {
    let contributes = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: contributes must be an object"))?;
    for name in sorted_keys(contributes) {
        let dot = name.find('.');
        let Some(dot) = dot.filter(|&dot| is_id(&name[..dot]) && is_id(&name[dot + 1..])) else {
            return Err(format!(
                "{where_}: contributes {name} must be <plugin id>.<point>"
            ));
        };
        if &name[..dot] == id {
            return Err(format!(
                "{where_}: contributes to its own extension point {name}"
            ));
        }
        let items = contributes[name.as_str()]
            .as_array()
            .filter(|items| !items.is_empty())
            .ok_or_else(|| format!("{where_}: contributes {name} must be a non-empty array"))?;
        for (index, item) in items.iter().enumerate() {
            let at = format!("{where_}: contributes {name} item {}", index + 1);
            let entry = item
                .as_object()
                .ok_or_else(|| format!("{at} must be an object"))?;
            if !is_range(entry.get("range")) {
                return Err(format!(
                    "{at} range {} is invalid",
                    js_field_text(entry, "range")
                ));
            }
            if !is_module_path(entry.get("module")) {
                return Err(format!(
                    "{at} module must be a JavaScript path inside the package"
                ));
            }
        }
    }
    Ok(())
}

/// Checks the background declaration (checkBackground of the reader). `sidecars` are the dependency names.
fn check_background(
    where_: &str,
    raw: &Value,
    sidecars: &[&str],
    settings: Option<&Value>,
) -> Result<(), String> {
    let background = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: background must be an object"))?;
    only(
        &format!("{where_} background"),
        background,
        &["sidecar", "operation", "settings"],
    )?;
    if let Some(fields_raw) = background.get("settings") {
        let fields = fields_raw.as_object().ok_or_else(|| {
            format!("{where_} background: settings must map request fields to setting names")
        })?;
        let declared = settings.and_then(Value::as_object);
        for field in sorted_keys(fields) {
            if field == "operation" {
                return Err(format!(
                    "{where_} background: a setting cannot replace operation"
                ));
            }
            let setting = fields[field.as_str()].as_str();
            let is_declared = setting.is_some_and(|s| declared.is_some_and(|d| d.contains_key(s)));
            if !is_declared {
                return Err(format!(
                    "{where_} background: setting {} is not declared by the plugin",
                    js_value_text(&fields[field.as_str()])
                ));
            }
        }
    }
    let sidecar = background.get("sidecar").and_then(Value::as_str);
    if !sidecar.is_some_and(|s| sidecars.contains(&s)) {
        return Err(format!(
            "{where_} background: sidecar must be declared by the plugin"
        ));
    }
    if !background
        .get("operation")
        .and_then(Value::as_str)
        .is_some_and(|op| !op.is_empty())
    {
        return Err(format!(
            "{where_} background: operation must be a non-empty string"
        ));
    }
    Ok(())
}

/// Whether the value is the page of a view: a path inside the release that ends in .html, with no empty, `.`, `..` or
/// `.binary` segment (isViewPage of the reader).
fn is_view_page(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|page| {
        !page.is_empty()
            && page.ends_with(".html")
            && page
                .split('/')
                .all(|segment| !matches!(segment, "" | "." | ".." | ".binary"))
    })
}

/// Checks the regions and the overlays of a view (checkRegions of the reader).
fn check_regions(
    where_: &str,
    regions: &[Value],
    overlays: &[Value],
    sidecars: &[&str],
) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for item in regions {
        let region = item
            .as_object()
            .ok_or_else(|| format!("{where_} composition region: expected an object"))?;
        let name = match region.get("name").and_then(Value::as_str) {
            Some(name) if is_region_name(name) => name,
            _ => {
                return Err(format!(
                    "{where_} composition: invalid region name {}",
                    js_field_text(region, "name")
                ));
            }
        };
        if !names.insert(name) {
            return Err(format!("{where_} composition: duplicate name {name}"));
        }
        let region_where = format!("{where_} composition region {name}");
        match region.get("kind").and_then(Value::as_str) {
            Some("document") => {
                only(&region_where, region, &["name", "kind", "input"])?;
                if region.get("input").and_then(Value::as_str) != Some("native") {
                    return Err(format!("{region_where}: document input must be native"));
                }
            }
            Some("image") => {
                only(&region_where, region, &["name", "kind", "sidecar", "input"])?;
                if region.get("input").and_then(Value::as_str) != Some("dom") {
                    return Err(format!("{region_where}: image input must be dom"));
                }
                let sidecar = region.get("sidecar").and_then(Value::as_str);
                if !sidecar.is_some_and(|s| sidecars.contains(&s)) {
                    return Err(format!(
                        "{region_where}: sidecar must be declared by the plugin"
                    ));
                }
            }
            _ => return Err(format!("{region_where}: kind must be document or image")),
        }
    }
    for item in overlays {
        match item.as_str() {
            Some(overlay) if is_region_name(overlay) => {
                if !names.insert(overlay) {
                    return Err(format!("{where_} composition: duplicate name {overlay}"));
                }
            }
            _ => {
                return Err(format!(
                    "{where_} composition: invalid overlay name {}",
                    js_value_text(item)
                ));
            }
        }
    }
    Ok(())
}

/// Checks the composition of a surface (checkComposition of the reader). `sidecars` are the dependency names.
fn check_composition(where_: &str, raw: &Value, sidecars: &[&str]) -> Result<(), String> {
    let composition = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: composition must be an object"))?;
    match composition.get("kind").and_then(Value::as_str) {
        Some("dom") => Err(format!(
            "{where_} composition: kind dom is removed; the composition takes kind view"
        )),
        Some("view") => {
            only(
                &format!("{where_} composition"),
                composition,
                &["kind", "page", "regions", "overlays"],
            )?;
            if !composition.contains_key("page") {
                return Err(format!(
                    "{where_} composition: view composition requires page"
                ));
            }
            if !is_view_page(composition.get("page")) {
                return Err(format!(
                    "{where_} composition: page must be a path inside the plugin release that ends in .html"
                ));
            }
            let regions: &[Value] = match composition.get("regions") {
                None => &[],
                Some(raw) => raw
                    .as_array()
                    .filter(|list| !list.is_empty())
                    .map(Vec::as_slice)
                    .ok_or_else(|| {
                        format!("{where_} composition: regions must be a non-empty array")
                    })?,
            };
            let overlays: &[Value] = match composition.get("overlays") {
                None => &[],
                Some(raw) => raw
                    .as_array()
                    .map(Vec::as_slice)
                    .ok_or_else(|| format!("{where_} composition: overlays must be an array"))?,
            };
            check_regions(where_, regions, overlays, sidecars)
        }
        Some("hybrid") => Err(format!(
            "{where_} composition: kind hybrid is removed; the composition takes kind view"
        )),
        _ => Err(format!(
            "{where_} composition: composition kind must be view"
        )),
    }
}

/// Checks the menu of a surface (checkMenu of the reader).
fn check_menu(where_: &str, raw: &Value, commands: &[&str]) -> Result<(), String> {
    let menu = raw
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= 16)
        .ok_or_else(|| format!("{where_}: surface menu must be an array of 1 to 16 items"))?;
    let mut seen = BTreeSet::new();
    for item in menu {
        let entry = item
            .as_object()
            .ok_or_else(|| format!("{where_}: a surface menu item must be an object"))?;
        only(
            &format!("{where_} surface menu item"),
            entry,
            &["command", "title"],
        )?;
        let command = entry.get("command").and_then(Value::as_str);
        let Some(command) = command.filter(|c| !c.is_empty() && commands.contains(c)) else {
            return Err(format!(
                "{where_}: surface menu command {} must name a command declared in exposes",
                js_field_text(entry, "command")
            ));
        };
        if !seen.insert(command) {
            return Err(format!(
                "{where_}: surface menu command {command} is repeated"
            ));
        }
        let title = entry.get("title").and_then(Value::as_str);
        if !title.is_some_and(|t| (1..=MENU_TITLE_MAX).contains(&utf16_length(t))) {
            return Err(format!(
                "{where_}: surface menu title of {command} must be 1 to {MENU_TITLE_MAX} characters"
            ));
        }
    }
    Ok(())
}

/// Checks the files that a surface opens (checkOpens of the reader). `params` is the surface params schema.
fn check_opens(where_: &str, raw: &Value, params: Option<&Value>) -> Result<(), String> {
    let opens = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: surface opens must be an object"))?;
    only(&format!("{where_} surface opens"), opens, &["extensions"])?;
    let path_type = params
        .and_then(|p| p.get("properties"))
        .and_then(|p| p.get("path"))
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str);
    if path_type != Some("string") {
        return Err(format!(
            "{where_}: surface opens requires surface params with a string property path"
        ));
    }
    let extensions = opens
        .get("extensions")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| format!("{where_}: surface opens extensions must be a non-empty array"))?;
    let mut seen = BTreeSet::new();
    for item in extensions {
        let extension = item.as_str();
        match extension {
            Some(e)
                if e == "*"
                    || (!e.is_empty()
                        && e.bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())) => {}
            _ => {
                return Err(format!(
                    "{where_}: surface opens extension {} must be * or lowercase letters and digits",
                    js_value_text(item)
                ));
            }
        }
        // default: a non-text extension was refused above, so this key is never empty.
        if !seen.insert(extension.unwrap_or_default()) {
            return Err(format!(
                "{where_}: surface opens extension {} is repeated",
                js_value_text(item)
            ));
        }
    }
    Ok(())
}

/// Checks the surface declaration (validateManifest of the reader).
fn check_surface(
    where_: &str,
    manifest: &Map<String, Value>,
    raw: &Value,
    sidecars: &[&str],
) -> Result<(), String> {
    let surface = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: surface must be an object"))?;
    only(
        &format!("{where_} surface"),
        surface,
        &[
            "module",
            "composition",
            "drop",
            "params",
            "opens",
            "save",
            "menu",
            "unload",
        ],
    )?;
    let commands = declared_commands(manifest);
    if let Some(raw) = surface.get("menu") {
        check_menu(where_, raw, &commands)?;
    }
    if let Some(raw) = surface.get("save")
        && !raw.as_str().is_some_and(|name| commands.contains(&name))
    {
        return Err(format!(
            "{where_}: surface save must name a command declared in exposes"
        ));
    }
    if let Some(raw) = surface.get("params") {
        let is_object_schema = raw
            .as_object()
            .is_some_and(|schema| schema.get("type").and_then(Value::as_str) == Some("object"));
        if !is_object_schema {
            return Err(format!(
                "{where_}: surface params must be a schema of type object"
            ));
        }
        check_schema(&format!("{where_} surface params"), Some(raw))?;
    }
    if let Some(raw) = surface.get("opens") {
        check_opens(where_, raw, surface.get("params"))?;
    }
    if let Some(raw) = surface.get("drop")
        && !raw.as_str().is_some_and(|name| commands.contains(&name))
    {
        return Err(format!(
            "{where_}: surface drop must name a command declared in exposes"
        ));
    }
    if surface.contains_key("module") {
        return Err(format!(
            "{where_}: surface module is removed; a surface is a view (docs/spec/plugins.md#view-surfaces)"
        ));
    }
    let composition = surface
        .get("composition")
        .ok_or_else(|| format!("{where_}: surface requires a composition"))?;
    check_composition(&format!("{where_} surface"), composition, sidecars)?;
    if let Some(raw) = surface.get("unload") {
        if manifest.contains_key("background") {
            return Err(format!(
                "{where_}: surface unload is forbidden beside background"
            ));
        }
        let unload = raw.as_object();
        let valid = unload.is_some_and(|u| {
            integer_value(u.get("format")).is_some_and(|f| f >= 1.0)
                && integer_value(u.get("maxBytes")).is_some_and(|m| m >= 1.0)
        });
        let unload = match (valid, unload) {
            (true, Some(unload)) => unload,
            _ => {
                return Err(format!(
                    "{where_}: surface unload must be {{format, maxBytes}} with positive integers"
                ));
            }
        };
        only(
            &format!("{where_} surface unload"),
            unload,
            &["format", "maxBytes"],
        )?;
    }
    if !is_text(manifest.get("mark")) {
        return Err(format!("{where_}: mark is required with a surface"));
    }
    if !is_text(manifest.get("icon")) {
        return Err(format!("{where_}: icon is required with a surface"));
    }
    Ok(())
}

/// Checks the sections of plugin.json (validateManifest of the reader).
fn check_sections(
    where_: &str,
    id: &str,
    manifest: &Map<String, Value>,
    raw: &Value,
) -> Result<(), String> {
    let sections = raw
        .as_array()
        .ok_or_else(|| format!("{where_}: sections must be an array"))?;
    let statuses = declared_statuses(manifest);
    let mut seen = BTreeSet::new();
    let mut backing: Vec<(&str, &str)> = Vec::new();
    for item in sections {
        let section = item
            .as_object()
            .ok_or_else(|| format!("{where_}: section must be an object"))?;
        if section.contains_key("module") {
            return Err(format!(
                "{where_}: section {} module is removed; a section takes status (docs/spec/declared-ui.md)",
                js_field_text(section, "id")
            ));
        }
        only(
            &format!("{where_} section"),
            section,
            &["id", "name", "fill", "status"],
        )?;
        let section_id = section.get("id").and_then(Value::as_str);
        let section_id = match section_id {
            Some(s) if s.starts_with(&format!("{id}.")) && is_id(&s[id.len() + 1..]) => s,
            _ => {
                return Err(format!(
                    "{where_}: section id {} must be {id}.<name>",
                    js_field_text(section, "id")
                ));
            }
        };
        if !seen.insert(section_id) {
            return Err(format!("{where_}: duplicate section {section_id}"));
        }
        if !is_text(section.get("name")) {
            return Err(format!("{where_}: section {section_id} requires a name"));
        }
        let status = section
            .get("status")
            .ok_or_else(|| format!("{where_}: section {section_id} requires a status"))?;
        let name = status.as_str().filter(|name| statuses.contains(name));
        let Some(name) = name else {
            return Err(format!(
                "{where_}: section {section_id} status {} is not a status of plugin {id}",
                js_value_text(status)
            ));
        };
        if let Some((_, other)) = backing.iter().find(|(status, _)| *status == name) {
            return Err(format!(
                "{where_}: status {name} backs section {other} and section {section_id}"
            ));
        }
        backing.push((name, section_id));
        if let Some(fill) = section.get("fill")
            && !fill.is_boolean()
        {
            return Err(format!(
                "{where_}: section {section_id} fill must be a boolean"
            ));
        }
    }
    Ok(())
}

/// Checks the preview colors (validateManifest of the reader).
fn check_preview(where_: &str, raw: &Value) -> Result<(), String> {
    let preview = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: preview must be an object"))?;
    only(&format!("{where_} preview"), preview, &["ink"])?;
    if !preview
        .get("ink")
        .and_then(Value::as_str)
        .is_some_and(is_token)
    {
        return Err(format!("{where_}: preview.ink must be a theme token name"));
    }
    Ok(())
}

/// Whether an address setting value is empty or an http or https address of at most 2048 characters.
fn is_setting_address(value: &Value) -> bool {
    match value.as_str() {
        Some("") => true,
        Some(text) => {
            utf16_length(text) <= ADDRESS_MAX
                && ["http://", "https://"].iter().any(|scheme| {
                    text.get(..scheme.len())
                        .is_some_and(|head| head.eq_ignore_ascii_case(scheme))
                        && text[scheme.len()..]
                            .chars()
                            .next()
                            .is_some_and(|c| c != '/')
                })
        }
        None => false,
    }
}

/// Checks one setting declaration (checkSettingDeclaration of the reader).
fn check_setting_declaration(where_: &str, raw: &Value) -> Result<(), String> {
    let full = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: setting must be an object"))?;
    let label = full.get("label").and_then(Value::as_str);
    if !label.is_some_and(|l| (1..=SETTING_LABEL_MAX).contains(&utf16_length(l))) {
        return Err(format!(
            "{where_}: label must be 1 to {SETTING_LABEL_MAX} characters"
        ));
    }
    if let Some(description) = full.get("description") {
        let ok = description
            .as_str()
            .is_some_and(|d| (1..=SETTING_DESCRIPTION_MAX).contains(&utf16_length(d)));
        if !ok {
            return Err(format!(
                "{where_}: description must be 1 to {SETTING_DESCRIPTION_MAX} characters"
            ));
        }
    }
    let mut declaration = full.clone();
    declaration.remove("label");
    declaration.remove("description");
    match declaration.get("type").and_then(Value::as_str) {
        Some("enum") => {
            only(where_, &declaration, &["type", "default", "values"])?;
            let values = declaration
                .get("values")
                .and_then(Value::as_array)
                .filter(|list| !list.is_empty())
                .ok_or_else(|| {
                    format!("{where_}: enum values must be distinct non-empty strings")
                })?;
            let mut seen = BTreeSet::new();
            for item in values {
                match item.as_str() {
                    Some(value) if !value.is_empty() && seen.insert(value) => {}
                    _ => {
                        return Err(format!(
                            "{where_}: enum values must be distinct non-empty strings"
                        ));
                    }
                }
            }
            let default = declaration.get("default").and_then(Value::as_str);
            if !default.is_some_and(|d| seen.contains(d)) {
                return Err(format!("{where_}: default must be one of values"));
            }
            Ok(())
        }
        Some("integer") => {
            only(
                where_,
                &declaration,
                &["type", "default", "minimum", "maximum"],
            )?;
            let default = integer_value(declaration.get("default"));
            let minimum = integer_value(declaration.get("minimum"));
            let maximum = integer_value(declaration.get("maximum"));
            match (default, minimum, maximum) {
                (Some(d), Some(lo), Some(hi)) if lo <= hi && d >= lo && d <= hi => Ok(()),
                _ => Err(format!("{where_}: integer default and bounds are invalid")),
            }
        }
        Some("string") => {
            only(where_, &declaration, &["type", "default", "maxLength"])?;
            let max_length = integer_value(declaration.get("maxLength"));
            let default = declaration.get("default").and_then(Value::as_str);
            let valid = match (max_length, default) {
                (Some(max), Some(text)) => {
                    max >= 1.0 && !text.is_empty() && utf16_length(text) as f64 <= max
                }
                _ => false,
            };
            if valid {
                Ok(())
            } else {
                Err(format!(
                    "{where_}: string default and maxLength are invalid"
                ))
            }
        }
        Some("address") => {
            only(where_, &declaration, &["type", "default"])?;
            // default: a missing default is refused like null, which is not an address.
            let default = declaration.get("default").unwrap_or(&Value::Null);
            if !is_setting_address(default) {
                return Err(format!(
                    "{where_}: address default must be empty or an http or https address"
                ));
            }
            Ok(())
        }
        _ => Err(format!(
            "{where_}: setting type must be enum, integer, string, or address"
        )),
    }
}

/// Checks the setting declarations (checkSettings of the reader).
fn check_settings(where_: &str, raw: &Value) -> Result<(), String> {
    let settings = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: settings must be an object"))?;
    for key in sorted_keys(settings) {
        if !is_setting_name(key) {
            return Err(format!("{where_}: invalid setting name {key}"));
        }
        check_setting_declaration(&format!("{where_}.{key}"), &settings[key.as_str()])?;
    }
    Ok(())
}

/// Checks the data declarations (validateManifest of the reader): a plugin host is required, and each key holds a schema
/// and a default that matches it, with a positive integer format.
fn check_data(where_: &str, manifest: &Map<String, Value>, raw: &Value) -> Result<(), String> {
    if !manifest.contains_key("host") {
        return Err(format!("{where_}: data requires a plugin host"));
    }
    let data = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: data must be an object"))?;
    for key in sorted_keys(data) {
        if !is_id(key) {
            return Err(format!("{where_}: invalid data key {key}"));
        }
        let entry = data[key.as_str()].as_object();
        let schema = entry
            .and_then(|e| e.get("schema"))
            .and_then(Value::as_object);
        let entry = match (entry, schema) {
            (Some(entry), Some(_)) if entry.contains_key("default") => entry,
            _ => return Err(format!("{where_}: data {key} requires schema and default")),
        };
        let at = format!("{where_} data {key}");
        only(&at, entry, &["schema", "default", "format"])?;
        check_schema(&format!("{at} schema"), entry.get("schema"))?;
        // default: check_data refused an entry without a schema object before this point.
        if !matches_schema(schema.unwrap_or(&Map::new()), &entry["default"]) {
            return Err(format!(
                "{where_}: data {key} default does not match its schema"
            ));
        }
        if let Some(format) = entry.get("format")
            && !integer_value(Some(format)).is_some_and(|f| f >= 1.0)
        {
            return Err(format!(
                "{where_}: data {key} format must be a positive integer"
            ));
        }
    }
    Ok(())
}

/// Checks the sidebar sets and the card and window defaults of plugin.json (validatePluginSidebarDefaults and
/// validateSidebars of the reader).
fn check_sidebar_defaults(
    where_: &str,
    manifest: &Map<String, Value>,
    raw: &Value,
) -> Result<(), String> {
    let sidebars = raw
        .as_object()
        .ok_or_else(|| format!("{where_}: sidebars must be an object"))?;
    only(
        &format!("{where_} sidebars"),
        sidebars,
        &["sets", "card", "window"],
    )?;
    let sets = sidebars
        .get("sets")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{where_}: sidebars requires sets and links"))?;
    let mut set_ids: BTreeSet<&str> = BTreeSet::new();
    for item in sets {
        let every_set = format!("{where_}: every set requires id, title, and sections");
        let set = item.as_object().ok_or_else(|| every_set.clone())?;
        let set_id = match set.get("id").and_then(Value::as_str) {
            Some(id)
                if !id.is_empty()
                    && is_text(set.get("title"))
                    && set.get("sections").is_some_and(Value::is_array) =>
            {
                id
            }
            _ => return Err(every_set),
        };
        only(
            &format!("{where_} set {set_id}"),
            set,
            &["id", "title", "sections", "layout"],
        )?;
        // default: the set title was checked as text above.
        let title = set.get("title").and_then(Value::as_str).unwrap_or_default();
        if !(1..=SET_TITLE_MAX).contains(&utf16_length(title)) {
            return Err(format!(
                "{where_}: set {set_id} title must be 1 to {SET_TITLE_MAX} characters"
            ));
        }
        let mut listed = BTreeSet::new();
        for section in set
            .get("sections")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match section.as_str() {
                Some(section_id) if !section_id.is_empty() => {
                    if !listed.insert(section_id) {
                        return Err(format!(
                            "{where_}: set {set_id} lists section {section_id} twice"
                        ));
                    }
                }
                _ => {
                    return Err(format!(
                        "{where_}: set {set_id} sections must be section ids"
                    ));
                }
            }
        }
        if !matches!(
            set.get("layout").and_then(Value::as_str),
            Some("list" | "tabs")
        ) {
            return Err(format!(
                "{where_}: set {set_id} layout must be list or tabs"
            ));
        }
        if matches!(set_id, "off" | "inherit") {
            return Err(format!("{where_}: set id {set_id} is reserved"));
        }
        if !set_ids.insert(set_id) {
            return Err(format!("{where_}: duplicate set {set_id}"));
        }
    }
    for item in sets {
        // default: the set id was checked as text above.
        let set_id = item["id"].as_str().unwrap_or_default();
        if !is_id(set_id) {
            return Err(format!("{where_}: invalid local set id {set_id}"));
        }
    }
    for (kind, sides) in [
        ("card", &["top", "bottom", "left", "right"][..]),
        ("window", &["left", "right"][..]),
    ] {
        let Some(mapping_raw) = sidebars.get(kind) else {
            continue;
        };
        if kind == "card" && !manifest.contains_key("surface") {
            return Err(format!("{where_}: card defaults require a surface"));
        }
        let mapping = mapping_raw
            .as_object()
            .ok_or_else(|| format!("{where_}: sidebar {kind} defaults must be an object"))?;
        only(&format!("{where_} sidebar {kind}"), mapping, sides)?;
        for side in sorted_keys(mapping) {
            let target = mapping[side.as_str()].as_str();
            if !target.is_some_and(|t| set_ids.contains(t)) {
                return Err(format!(
                    "{where_}: {kind} {side} names unknown set {}",
                    js_value_text(&mapping[side.as_str()])
                ));
            }
        }
    }
    Ok(())
}

/// Validates a parsed plugin.json with the rules of the page reader and returns the first refused member as the reader's
/// error text (validateManifest of packages/plugin-api/index.js).
pub fn validate_manifest(value: &Value) -> Result<(), String> {
    let manifest = value
        .as_object()
        .ok_or_else(|| "plugin.json: expected an object".to_string())?;
    if manifest.contains_key("state") {
        return Err(format!(
            "plugin {}: state is removed; a plugin keeps project data through its host (docs/spec/plugins.md#project-data)",
            js_field_text(manifest, "id")
        ));
    }
    only("plugin.json", manifest, &TOP_LEVEL_KEYS)?;
    if let Some(events) = manifest.get("events") {
        let valid = events.as_str().is_some_and(|path| {
            !path.is_empty() && !path.starts_with('/') && !path.split('/').any(|part| part == "..")
        });
        if !valid {
            return Err("plugin.json: events must be a path inside the package".to_string());
        }
    }
    let id = match manifest.get("id").and_then(Value::as_str) {
        Some(id) if is_id(id) => id,
        _ => {
            return Err(format!(
                "plugin.json: invalid id {}",
                js_field_text(manifest, "id")
            ));
        }
    };
    if id == "core" {
        return Err("plugin.json: plugin id core is reserved for the core root".to_string());
    }
    let where_ = format!("plugin {id}");
    if !is_text(manifest.get("name")) {
        return Err(format!("{where_}: name is required"));
    }
    let description_ok = manifest
        .get("description")
        .and_then(Value::as_str)
        .is_some_and(|d| (1..=PLUGIN_DESCRIPTION_MAX).contains(&utf16_length(d)));
    if !description_ok {
        return Err(format!(
            "{where_}: description must be 1 to {PLUGIN_DESCRIPTION_MAX} characters"
        ));
    }
    let has = |key: &str| manifest.contains_key(key);
    if let Some(raw) = manifest.get("data") {
        check_data(&where_, manifest, raw)?;
    }
    let mut dependencies = Map::new();
    if let Some(raw) = manifest.get("dependencies") {
        if !has("surface") && !has("host") && !has("contributes") {
            return Err(format!(
                "{where_}: dependencies require a surface, a plugin host or contributes"
            ));
        }
        dependencies = check_dependencies(&where_, raw)?;
    }
    let sidecars: Vec<&str> = sorted_keys(&dependencies)
        .into_iter()
        .map(String::as_str)
        .collect();
    if let Some(raw) = manifest.get("host") {
        check_host(&where_, raw)?;
    }
    if let Some(raw) = manifest.get("hostOperations") {
        if !has("host") {
            return Err(format!("{where_}: hostOperations requires host"));
        }
        check_host_operations(&where_, raw, &dependencies)?;
    }
    if let Some(raw) = manifest.get("extends") {
        if !has("surface") {
            return Err(format!("{where_}: extends requires a surface"));
        }
        check_extends(&where_, raw)?;
    }
    if let Some(raw) = manifest.get("contributes") {
        check_contributes(&where_, id, raw)?;
    }
    if let Some(raw) = manifest.get("background") {
        if !has("surface") {
            return Err(format!("{where_}: background requires a surface"));
        }
        check_background(&where_, raw, &sidecars, manifest.get("settings"))?;
    }
    if let Some(raw) = manifest.get("surface") {
        check_surface(&where_, manifest, raw, &sidecars)?;
    }
    if let Some(raw) = manifest.get("sections") {
        check_sections(&where_, id, manifest, raw)?;
    }
    if let Some(raw) = manifest.get("preview") {
        if !has("surface") {
            return Err(format!("{where_}: preview requires a surface"));
        }
        check_preview(&where_, raw)?;
    }
    if let Some(raw) = manifest.get("exposes") {
        if !has("surface") && !has("host") {
            return Err(format!(
                "{where_}: exposes require a surface or a plugin host"
            ));
        }
        check_exposes(id, raw)?;
    }
    if let Some(raw) = manifest.get("settings") {
        check_settings(&where_, raw)?;
    }
    if !has("surface") && !has("sections") && !has("contributes") {
        return Err(format!(
            "{where_}: a plugin requires a surface, sections or contributes"
        ));
    }
    if let Some(raw) = manifest.get("sidebars") {
        check_sidebar_defaults(&where_, manifest, raw)?;
    }
    Ok(())
}
