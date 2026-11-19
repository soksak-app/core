//! The parts of the exposure that an agent reads, shared by the commands of sok and the tools of `sok mcp`: the window of an agent
//! (docs/spec/cli.md#the-window-of-an-agent), the discovery of entries (docs/spec/cli.md#discovery) and the window description
//! (docs/spec/cli.md#window-description). The Go implementation (packages/sok/go/src/agent_window.go) gives the same JSON text for
//! the same endpoint replies: objects that this module writes have their members in the order of their names, no escape of <, >
//! and &, and the line and paragraph separators as they are; values of the endpoint keep their text without the white space
//! between their tokens.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;

use serde::Serialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::endpoint::{Client, Failure};
use crate::{Arguments, Error, Options, indent, select_window};

/// The variable that names the configuration directory of the application whose surface started the process.
pub const CONFIG_DIR_VARIABLE: &str = "SOKSAK_CONFIG_DIR";

/// The variable that names the surface whose process started the agent.
pub const SURFACE_VARIABLE: &str = "SOKSAK_SURFACE";

/// Sends one endpoint request and returns its result as JSON text.
pub type Requester<'a> = dyn FnMut(&str, Option<Value>) -> Result<String, Failure> + 'a;

/// The raw text of one JSON value.
type Raw = Box<RawValue>;

/// The members of a JSON object, each with the raw text of its value; a later member of the same name replaces an earlier one.
type Members = BTreeMap<String, Raw>;

/// The text of a JSON object whose members are written in the order of their names.
type Object = BTreeMap<String, Raw>;

/// The raw text of a value that this module writes.
fn raw<T: Serialize + ?Sized>(value: &T) -> Result<Raw, Failure> {
    serde_json::value::to_raw_value(value).map_err(|error| Failure::Other(error.to_string()))
}

/// The raw value of a JSON text that this module produced or checked.
fn raw_text(text: String) -> Result<Raw, Failure> {
    RawValue::from_string(text).map_err(|error| Failure::Other(error.to_string()))
}

/// The text `null`.
fn null() -> Raw {
    RawValue::NULL.to_owned()
}

/// Writes an object as compact JSON text, members in the order of their names and the separators as they are.
fn encode(object: &Object) -> Result<String, Failure> {
    let text = serde_json::to_string(object).map_err(|error| Failure::Other(error.to_string()))?;
    Ok(keep_separators(&text))
}

/// Writes a string as JSON text, as `encode` writes a string member.
fn encode_text(text: &str) -> Result<String, Failure> {
    let encoded = serde_json::to_string(text).map_err(|error| Failure::Other(error.to_string()))?;
    Ok(keep_separators(&encoded))
}

/// Replaces each escape ` ` and ` ` of a JSON text with the character itself, so a value that the endpoint wrote with
/// the escape is written as the encoder of this module writes a string. An escape is one when an even number of backslashes
/// precedes it, because `\\u2028` is a backslash followed by the text u2028.
pub fn keep_separators(text: &str) -> String {
    if !text.contains("\\u202") {
        return text.to_string();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 5 < bytes.len()
            && &bytes[i + 1..i + 5] == b"u202"
            && (bytes[i + 5] == b'8' || bytes[i + 5] == b'9')
        {
            let separator = if bytes[i + 5] == b'8' {
                '\u{2028}'
            } else {
                '\u{2029}'
            };
            let mut buffer = [0u8; 4];
            out.extend_from_slice(separator.encode_utf8(&mut buffer).as_bytes());
            i += 6;
            continue;
        }
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            out.push(bytes[i]);
            i += 1;
        }
        out.push(bytes[i]);
        i += 1;
    }
    // The replacement exchanges an ASCII escape for a whole UTF-8 character and copies every other byte, so the text stays UTF-8.
    String::from_utf8(out).expect("a JSON text with separators is UTF-8")
}

/// Removes the white space between the tokens of an endpoint value and keeps everything else of its text.
pub fn compact_raw(text: &str) -> Result<String, Failure> {
    serde_json::from_str::<&RawValue>(text)
        .map_err(|error| Failure::Other(format!("endpoint returned invalid JSON: {error}")))?;
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            ' ' | '\t' | '\n' | '\r' => {}
            '"' => {
                in_string = true;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    Ok(out)
}

/// The compact raw value of a value of the endpoint.
fn compacted(value: &RawValue) -> Result<Raw, Failure> {
    raw_text(compact_raw(value.get())?)
}

/// The JSON text of a value as this module writes it, so the text does not depend on the escapes and the member order with which
/// the endpoint wrote the value; a number keeps its text.
fn canonical_text(value: &RawValue) -> Result<String, String> {
    let mut out = String::new();
    canonical(value, &mut out)?;
    Ok(keep_separators(&out))
}

fn canonical(value: &RawValue, out: &mut String) -> Result<(), String> {
    let text = value.get();
    match text.as_bytes().first() {
        Some(b'{') => {
            let members: Members = serde_json::from_str(text).map_err(|error| error.to_string())?;
            out.push('{');
            for (n, (name, member)) in members.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(name).map_err(|error| error.to_string())?);
                out.push(':');
                canonical(member, out)?;
            }
            out.push('}');
        }
        Some(b'[') => {
            let items: Vec<Raw> = serde_json::from_str(text).map_err(|error| error.to_string())?;
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                canonical(item, out)?;
            }
            out.push(']');
        }
        Some(b'"') => {
            let decoded: String = serde_json::from_str(text).map_err(|error| error.to_string())?;
            out.push_str(&serde_json::to_string(&decoded).map_err(|error| error.to_string())?);
        }
        // A number, true, false or null: the text of the endpoint, which the parse of the whole value checked.
        _ => out.push_str(text),
    }
    Ok(())
}

/// Tells whether a JSON text holds a `\u` escape of a UTF-16 surrogate that is not one half of a pair, which names no character.
/// serde_json refuses such an escape and encoding/json decodes it to U+FFFD, so both implementations refuse the value before they
/// decode it.
pub(crate) fn lone_surrogate(text: &str) -> bool {
    let bytes = text.as_bytes();
    let surrogate = |at: usize| -> Option<u32> {
        let escape = bytes.get(at..at + 6)?;
        if escape[0] != b'\\' || escape[1] != b'u' {
            return None;
        }
        // default: six bytes that are not a backslash, a u and four hexadecimal digits are no escape of a surrogate; the parser
        // reports a malformed escape with the whole text.
        u32::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok()
    };
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        match surrogate(at) {
            // Another escape: the escaped character is skipped with the backslash.
            None => at += 2,
            Some(0xD800..=0xDBFF) => match surrogate(at + 6) {
                Some(0xDC00..=0xDFFF) => at += 12,
                _ => return true,
            },
            Some(0xDC00..=0xDFFF) => return true,
            Some(_) => at += 6,
        }
    }
    false
}

/// Reads a JSON object into its members, or None for null. Another value is an error.
fn object_of(text: &str) -> Result<Option<Members>, String> {
    serde_json::from_str(text).map_err(|error| error.to_string())
}

/// The text of a member that a decoded object field holds: an absent member and null are the empty text, and a value that is
/// not a string is an error.
fn field_text(members: &Members, name: &str) -> Result<String, String> {
    match members.get(name) {
        None => Ok(String::new()),
        Some(value) => member_text(value),
    }
}

/// The text of a present member: null is the empty text, and a value that is not a string is an error.
fn member_text(value: &RawValue) -> Result<String, String> {
    serde_json::from_str::<Option<String>>(value.get())
        .map(Option::unwrap_or_default)
        .map_err(|error| error.to_string())
}

/// The members of a JSON object in their order.
struct OrderedMembers(Vec<(String, Raw)>);

impl<'de> serde::Deserialize<'de> for OrderedMembers {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> Visitor<'de> for Members {
            type Value = OrderedMembers;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OrderedMembers, A::Error> {
                let mut members = Vec::new();
                while let Some((name, value)) = map.next_entry::<String, Raw>()? {
                    members.push((name, value));
                }
                Ok(OrderedMembers(members))
            }
        }
        deserializer.deserialize_map(Members)
    }
}

/// The answer of `surface.window` for the surface that `SOKSAK_SURFACE` names: the error of a surface in no window (1012) names
/// the variable, because a request of an agent never falls back to another window.
fn no_window_text(surface: &str) -> String {
    format!("{SURFACE_VARIABLE} names surface {surface}, which is in no window of the application")
}

/// The answer of `surface.window`: the window and the space whose layout holds a surface; the space is None for a section surface
/// that a sidebar of the window draws, which no space holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurfaceHome {
    pub window: String,
    pub space: Option<String>,
}

/// Asks the endpoint for the window and the space whose layout holds the surface (docs/spec/cli.md#the-window-of-an-agent).
pub fn surface_window(request: &mut Requester, surface: &str) -> Result<SurfaceHome, Failure> {
    let result = match request(
        "surface.window",
        Some(serde_json::json!({ "surface": surface })),
    ) {
        Err(Failure::Endpoint { code: 1012, .. }) => {
            return Err(Failure::Other(no_window_text(surface)));
        }
        other => other?,
    };
    let unexpected = || {
        Failure::Other(format!(
            "surface.window returned an unexpected value: {result}"
        ))
    };
    let members = object_of(&result)
        .map_err(|_| unexpected())?
        .ok_or_else(unexpected)?;
    // The window is a text that is not empty; the space is present, a text or null.
    let window = match members.get("window") {
        Some(value) if value.get() != "null" => member_text(value).map_err(|_| unexpected())?,
        _ => return Err(unexpected()),
    };
    if window.is_empty() {
        return Err(unexpected());
    }
    let space = match members.get("space") {
        None => return Err(unexpected()),
        Some(value) => {
            serde_json::from_str::<Option<String>>(value.get()).map_err(|_| unexpected())?
        }
    };
    Ok(SurfaceHome { window, space })
}

/// One window of `windows.list`.
pub struct WindowEntry {
    pub window: String,
    pub project: Option<String>,
    pub key: bool,
}

/// Reads `windows.list`.
pub fn read_windows(request: &mut Requester) -> Result<Vec<WindowEntry>, Failure> {
    let result = request("windows.list", None)?;
    let unexpected = |error: String| {
        Failure::Other(format!(
            "windows.list returned an unexpected value: {error}"
        ))
    };
    let list: Option<Vec<Raw>> =
        serde_json::from_str(&result).map_err(|error| unexpected(error.to_string()))?;
    let mut windows = Vec::new();
    // default: a null list decodes as no windows, as the Go reader decodes it into a slice.
    for raw in list.unwrap_or_default() {
        let members = object_of(raw.get())
            .map_err(unexpected)?
            // default: a null entry has no members, so its missing window is reported below.
            .unwrap_or_default();
        let project = match members.get("project") {
            None => None,
            Some(value) => serde_json::from_str::<Option<String>>(value.get())
                .map_err(|error| unexpected(error.to_string()))?,
        };
        let key = match members.get("key") {
            None => false,
            Some(value) => serde_json::from_str::<Option<bool>>(value.get())
                .map_err(|error| unexpected(error.to_string()))?
                // default: a key of null is false, the value that the Go reader leaves for null.
                .unwrap_or_default(),
        };
        windows.push(WindowEntry {
            window: field_text(&members, "window").map_err(unexpected)?,
            project,
            key,
        });
    }
    Ok(windows)
}

/// The names of the windows in the order of their text.
pub fn window_names(windows: &[WindowEntry]) -> Vec<String> {
    let mut names: Vec<String> = windows.iter().map(|entry| entry.window.clone()).collect();
    names.sort();
    names
}

/// The window whose open project folder is the directory project, both resolved to canonical paths.
pub fn project_window(windows: &[WindowEntry], project: &str) -> Result<String, Failure> {
    let target = std::fs::canonicalize(project)
        .map_err(|error| Failure::Other(format!("project directory {project}: {error}")))?;
    for entry in windows {
        let Some(open) = &entry.project else {
            continue;
        };
        // default: a window whose project path cannot be resolved cannot be the target; no match returns the error that lists the windows.
        if std::fs::canonicalize(open).ok().as_deref() == Some(target.as_path()) {
            return Ok(entry.window.clone());
        }
    }
    Err(Failure::Other(format!(
        "no window shows the project {}; windows: {}",
        target.display(),
        window_names(windows).join(", ")
    )))
}

/// The key window of `windows.list`, else its first window.
pub fn key_window(request: &mut Requester) -> Result<String, Failure> {
    let windows = read_windows(request)?;
    if let Some(entry) = windows.iter().find(|entry| entry.key) {
        return Ok(entry.window.clone());
    }
    windows
        .first()
        .map(|entry| entry.window.clone())
        .ok_or_else(|| Failure::Other("the application has no window".into()))
}

/// `{configDirectory, surface, window}` of the tool agent_context: the surface of `SOKSAK_SURFACE` and its window, or null for both
/// without it. Without the surface it sends no request.
pub fn agent_context(
    request: &mut Requester,
    config_dir: &str,
    surface: Option<&str>,
) -> Result<String, Failure> {
    let mut context = Object::new();
    context.insert("configDirectory".into(), raw(config_dir)?);
    context.insert("surface".into(), null());
    context.insert("window".into(), null());
    if let Some(surface) = surface {
        let home = surface_window(request, surface)?;
        context.insert("surface".into(), raw(surface)?);
        context.insert("window".into(), raw(&home.window)?);
    }
    encode(&context)
}

/// Tells whether each word of query is a part of name or of description. Words are separated by spaces, tabs and line breaks;
/// the letters A-Z and a-z match regardless of case and every other character only itself (docs/spec/cli.md#discovery).
pub fn query_matches(query: &str, name: &str, description: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let description = description.to_ascii_lowercase();
    query
        .split([' ', '\t', '\n', '\r'])
        .filter(|word| !word.is_empty())
        .all(|word| {
            let word = word.to_ascii_lowercase();
            name.contains(&word) || description.contains(&word)
        })
}

/// The kinds of entries in the order of exposure.list, with the member of each list.
const EXPOSURE_KINDS: [(&str, &str); 3] = [
    ("status", "status"),
    ("command", "commands"),
    ("element", "element"),
];

/// The kinds that discovery accepts.
pub fn is_kind(kind: &str) -> bool {
    EXPOSURE_KINDS.iter().any(|(k, _)| *k == kind)
}

/// One declared entry of exposure.list with its declaration as the endpoint gave it.
pub struct ExposureEntry {
    kind: &'static str,
    name: String,
    description: String,
    registered: Option<Raw>,
    /// The compact text of the declaration.
    raw: String,
}

/// The result of exposure.list: the members in their order and the entries of each kind.
pub struct Exposure {
    order: Vec<String>,
    members: HashMap<String, Raw>,
    entries: HashMap<&'static str, Vec<ExposureEntry>>,
}

/// Reads the result of exposure.list. A result without one of the three lists, or with a command without params, is no list of
/// the exposure (docs/spec/exposure.md#entry-fields) and is refused instead of completed.
pub fn read_exposure(result: &str) -> Result<Exposure, Failure> {
    let ordered: OrderedMembers = serde_json::from_str(result).map_err(|error| {
        Failure::Other(format!(
            "exposure.list returned an unexpected value: {error}"
        ))
    })?;
    let mut read = Exposure {
        order: Vec::new(),
        members: HashMap::new(),
        entries: HashMap::new(),
    };
    for (name, value) in ordered.0 {
        if !read.members.contains_key(&name) {
            read.order.push(name.clone());
        }
        read.members.insert(name, value);
    }
    for (kind, member) in EXPOSURE_KINDS {
        let list = read
            .members
            .get(member)
            .and_then(|raw| {
                serde_json::from_str::<Option<Vec<Raw>>>(raw.get())
                    // default: a member that is no list is reported below as `exposure.list has no <member> list`.
                    .ok()
                    .flatten()
            })
            .ok_or_else(|| Failure::Other(format!("exposure.list has no {member} list")))?;
        let mut entries = Vec::new();
        for raw in list {
            // default: an entry that is no object is reported here as an entry that is not an object.
            let fields = object_of(raw.get()).ok().flatten().ok_or_else(|| {
                Failure::Other(format!(
                    "exposure.list has an entry that is not an object in its {member} list"
                ))
            })?;
            let name = fields
                .get("name")
                // default: a name that is no text is reported below as an entry without a name.
                .and_then(|value| member_text(value).ok())
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    Failure::Other(format!(
                        "exposure.list has an entry without a name in its {member} list"
                    ))
                })?;
            let description = fields
                .get("description")
                // default: a description that is no text is reported below as a missing description.
                .and_then(|value| member_text(value).ok())
                .ok_or_else(|| Failure::Other(format!("{kind} {name} has no description")))?;
            if kind == "command" && !fields.contains_key("params") {
                return Err(Failure::Other(format!(
                    "command {name} declares no params schema"
                )));
            }
            entries.push(ExposureEntry {
                kind,
                name,
                description,
                registered: fields.get("registered").cloned(),
                raw: compact_raw(raw.get())?,
            });
        }
        read.entries.insert(kind, entries);
    }
    Ok(read)
}

/// The text of a member name as the default encoder of Go writes it: with the escapes of <, >, &, and the line and paragraph
/// separators.
fn member_name(name: &str) -> Result<String, Failure> {
    let text = serde_json::to_string(name).map_err(|error| Failure::Other(error.to_string()))?;
    Ok(text
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029"))
}

/// Keeps the entries of kind (every kind when it is empty) that query matches, in the order of exposure.list, and writes the object
/// of exposure.list with the kept lists and the members in their order (`sok exposures`).
pub fn filter_exposure(read: &Exposure, kind: &str, query: &str) -> Result<String, Failure> {
    let mut out = String::from("{");
    let mut first = true;
    for name in &read.order {
        let listed = EXPOSURE_KINDS
            .iter()
            .find(|(_, member)| member == name)
            .map(|(k, _)| *k);
        if let Some(listed) = listed
            && !kind.is_empty()
            && listed != kind
        {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&member_name(name)?);
        out.push(':');
        let Some(listed) = listed else {
            out.push_str(&compact_raw(read.members[name].get())?);
            continue;
        };
        out.push('[');
        let kept: Vec<&str> = read.entries[listed]
            .iter()
            .filter(|entry| query_matches(query, &entry.name, &entry.description))
            .map(|entry| entry.raw.as_str())
            .collect();
        out.push_str(&kept.join(","));
        out.push(']');
    }
    out.push('}');
    Ok(out)
}

/// The commands list of exposure.list with the commands that query matches (`sok commands`).
pub fn matching_commands(read: &Exposure, query: &str) -> String {
    let kept: Vec<&str> = read.entries["command"]
        .iter()
        .filter(|entry| query_matches(query, &entry.name, &entry.description))
        .map(|entry| entry.raw.as_str())
        .collect();
    format!("[{}]", kept.join(","))
}

/// The result of exposure_search: the entries of kind that query matches, as {kind, name, description, registered}, after the
/// entry whose key is after, at most limit of them, with their number and the key of the last entry of the page when more follow.
pub fn search_exposure(
    read: &Exposure,
    kind: &str,
    query: &str,
    after: &str,
    limit: usize,
) -> Result<String, Failure> {
    let matched: Vec<&ExposureEntry> = EXPOSURE_KINDS
        .iter()
        .filter(|(k, _)| kind.is_empty() || *k == kind)
        .flat_map(|(k, _)| read.entries[k].iter())
        .filter(|entry| query_matches(query, &entry.name, &entry.description))
        .collect();
    let mut start = 0;
    if !after.is_empty() {
        start = matched
            .iter()
            .rposition(|entry| format!("{} {}", entry.kind, entry.name) == after)
            .map(|n| n + 1)
            .ok_or_else(|| Failure::Other(format!("after {after} names no entry of the search")))?;
    }
    let end = (start + limit).min(matched.len());
    let mut entries = Vec::new();
    for entry in &matched[start..end] {
        let registered = entry.registered.as_ref().ok_or_else(|| {
            Failure::Other(format!("{} {} has no registered", entry.kind, entry.name))
        })?;
        let mut found = Object::new();
        found.insert("kind".into(), raw(entry.kind)?);
        found.insert("name".into(), raw(&entry.name)?);
        found.insert("description".into(), raw(&entry.description)?);
        found.insert("registered".into(), compacted(registered)?);
        entries.push(found);
    }
    let mut page = Object::new();
    page.insert("entries".into(), raw(&entries)?);
    page.insert("total".into(), raw(&matched.len())?);
    page.insert(
        "next".into(),
        if end < matched.len() {
            raw(&format!(
                "{} {}",
                matched[end - 1].kind,
                matched[end - 1].name
            ))?
        } else {
            null()
        },
    );
    encode(&page)
}

/// The declaration of one entry of exposure.list, with registered, for exposure_describe.
pub fn describe_entry(read: &Exposure, kind: &str, name: &str) -> Result<String, Failure> {
    read.entries
        .get(kind)
        .and_then(|entries| entries.iter().find(|entry| entry.name == name))
        .map(|entry| entry.raw.clone())
        .ok_or_else(|| Failure::Other(format!("{kind} {name} is not declared")))
}

/// Bounds of the window description (docs/spec/cli.md#window-description).
const DESCRIBE_PAGE_BYTES: usize = 40000;
const DESCRIBE_VALUE_CHARS: usize = 200;
const DESCRIBE_COMPACT_ITEMS: usize = 20;
pub const DESCRIBE_DEFAULT_LIMIT: usize = 200;
pub const DESCRIBE_MAX_LIMIT: usize = 500;

/// One entry of the description with the members of its row.
struct Row {
    key: String,
    kind: String,
    fields: Object,
    /// The JSON text of the value of a status.
    cut_text: String,
    /// The items of an element, None for null.
    items: Option<Vec<Raw>>,
}

impl Row {
    fn encode(&self) -> Result<String, Failure> {
        encode(&self.fields)
    }

    /// Writes the JSON text of the status value cut to chars Unicode scalar values, with cut when it was cut.
    fn set_value_text(&mut self, chars: usize) -> Result<(), Failure> {
        let count = self.cut_text.chars().count();
        if count > chars {
            let cut: String = self.cut_text.chars().take(chars).collect();
            self.fields.insert("value".into(), raw(&cut)?);
            self.fields.insert("cut".into(), raw(&true)?);
            return Ok(());
        }
        let value = raw(&self.cut_text)?;
        self.fields.insert("value".into(), value);
        self.fields.remove("cut");
        Ok(())
    }

    /// Keeps the first count items, with cut and itemsTotal when it left items out.
    fn set_items(&mut self, count: usize) -> Result<(), Failure> {
        let total = self.items.as_ref().map_or(0, Vec::len);
        if total > count {
            let items = &self.items.as_ref().expect("items are counted above")[..count];
            self.fields.insert("items".into(), raw(items)?);
            self.fields.insert("cut".into(), raw(&true)?);
            self.fields.insert("itemsTotal".into(), raw(&total)?);
            return Ok(());
        }
        let items = match &self.items {
            Some(items) => raw(items)?,
            None => null(),
        };
        self.fields.insert("items".into(), items);
        self.fields.remove("cut");
        self.fields.remove("itemsTotal");
        Ok(())
    }

    /// Cuts the value or the items of a row that alone passes the bound of a page to the longest part with which its text has at
    /// most room bytes. A row that has no value or items to cut stays whole.
    fn cut_to_fit(&mut self, room: isize) -> Result<String, Failure> {
        let status = self.kind == "status" && self.fields.contains_key("value");
        let element = self.kind == "element" && self.items.is_some();
        // The full form gives the value whole, so a cut value is its JSON text as in the compact form.
        let total = if status {
            self.cut_text.chars().count()
        } else if element {
            self.items.as_ref().map_or(0, Vec::len)
        } else {
            return self.encode();
        };
        let set = |row: &mut Row, count: usize| {
            if status {
                row.set_value_text(count)
            } else {
                row.set_items(count)
            }
        };
        let fits = |row: &mut Row, count: usize| -> Result<bool, Failure> {
            set(row, count)?;
            row.fields.insert("cut".into(), raw(&true)?);
            Ok(row.encode()?.len() as isize <= room)
        };
        // The longest part that fits: fits(low) holds or low is 0, and fits(high) does not hold.
        let (mut low, mut high) = (0, total);
        while low + 1 < high {
            let middle = (low + high) / 2;
            if fits(self, middle)? {
                low = middle;
            } else {
                high = middle;
            }
        }
        set(self, low)?;
        self.fields.insert("cut".into(), raw(&true)?);
        if self.kind == "element" {
            let total = self.items.as_ref().map_or(0, Vec::len);
            self.fields.insert("itemsTotal".into(), raw(&total)?);
        }
        self.encode()
    }
}

/// The text up to the end of its first sentence: the first period that a white space or the end follows.
fn first_sentence(text: &str) -> &str {
    let bytes = text.as_bytes();
    for n in 0..bytes.len() {
        if bytes[n] == b'.'
            && (n + 1 == bytes.len() || matches!(bytes[n + 1], b' ' | b'\t' | b'\n' | b'\r'))
        {
            return &text[..=n];
        }
    }
    text
}

/// Writes the parameters of a command schema as `<name>: <type>` in the order of their names. A type list is joined with |, and
/// a parameter without a type is any.
fn parameter_list(schema: Option<&RawValue>) -> Result<Vec<String>, String> {
    let not_object = || "its params schema is not an object".to_string();
    let schema = schema.ok_or_else(not_object)?;
    let fields = object_of(schema.get())
        .map_err(|_| not_object())?
        // default: a null schema has no properties, as the Go reader decodes null into its fields.
        .unwrap_or_default();
    let properties: BTreeMap<String, Option<Members>> = match fields.get("properties") {
        None => BTreeMap::new(),
        Some(raw) => serde_json::from_str::<Option<BTreeMap<String, Option<Members>>>>(raw.get())
            .map_err(|_| not_object())?
            // default: null properties are no parameters, as the Go reader decodes null into a map.
            .unwrap_or_default(),
    };
    let mut params = Vec::new();
    for (name, property) in properties {
        let kind = match property.as_ref().and_then(|members| members.get("type")) {
            None => "any".to_string(),
            Some(raw) => match serde_json::from_str::<Option<String>>(raw.get()) {
                // default: a type of null is the empty text, which the Go reader leaves for null.
                Ok(single) => single.unwrap_or_default(),
                Err(_) => match serde_json::from_str::<Vec<String>>(raw.get()) {
                    Ok(several) if !several.is_empty() => several.join("|"),
                    _ => "any".to_string(),
                },
            },
        };
        params.push(format!("{name}: {kind}"));
    }
    Ok(params)
}

/// An element item of the compact form: index, role, text, inert and command.
fn brief_item(item: &RawValue) -> Result<Raw, Failure> {
    let fields = object_of(item.get())
        // default: an item that is no object is reported below as an item that is not an object.
        .ok()
        .flatten()
        .ok_or_else(|| Failure::Other("an item is not an object".into()))?;
    let mut brief = Object::new();
    for member in ["index", "role", "text", "inert", "command"] {
        if let Some(value) = fields.get(member) {
            brief.insert(member.into(), compacted(value)?);
        }
    }
    raw_text(encode(&brief)?)
}

/// One group of exposure.snapshot.
struct SnapshotGroup {
    owner: String,
    surface: String,
    plugin: Option<Raw>,
    lists: [(&'static str, Vec<Raw>); 3],
}

/// Reads one group of exposure.snapshot; null is a group without members.
fn read_group(raw: &RawValue) -> Result<SnapshotGroup, String> {
    // default: null is a group without members.
    let members = object_of(raw.get())?.unwrap_or_default();
    let list = |name: &str| -> Result<Vec<Raw>, String> {
        match members.get(name) {
            None => Ok(Vec::new()),
            Some(raw) => serde_json::from_str::<Option<Vec<Raw>>>(raw.get())
                .map(Option::unwrap_or_default)
                .map_err(|error| error.to_string()),
        }
    };
    Ok(SnapshotGroup {
        owner: field_text(&members, "owner")?,
        surface: field_text(&members, "surface")?,
        plugin: members.get("plugin").cloned(),
        lists: [
            ("status", list("status")?),
            ("command", list("commands")?),
            ("element", list("element")?),
        ],
    })
}

/// The row of one entry of a group.
fn entry_row(
    group: &str,
    owner: &SnapshotGroup,
    kind: &str,
    raw_entry: &RawValue,
    full: bool,
) -> Result<Row, Failure> {
    // default: an entry that is no object is reported here as an entry that is not an object.
    let entry = object_of(raw_entry.get()).ok().flatten().ok_or_else(|| {
        Failure::Other(format!(
            "exposure.snapshot has an entry that is not an object in group {group}"
        ))
    })?;
    let name = entry
        .get("name")
        // default: a name that is no text is reported below as an entry without a name.
        .and_then(|value| member_text(value).ok())
        .ok_or_else(|| {
            Failure::Other(format!(
                "exposure.snapshot has an entry without a name in group {group}"
            ))
        })?;
    let description = entry
        .get("description")
        // default: a description that is no text is reported below as a missing description.
        .and_then(|value| member_text(value).ok())
        .ok_or_else(|| {
            Failure::Other(format!("{kind} {name} of group {group} has no description"))
        })?;
    let key = format!("{group} {kind} {name}");
    let mut row = Row {
        key: key.clone(),
        kind: kind.to_string(),
        fields: Object::new(),
        cut_text: String::new(),
        items: None,
    };
    if full {
        for (member, value) in &entry {
            row.fields.insert(member.clone(), compacted(value)?);
        }
    } else {
        row.fields.insert("name".into(), raw(&name)?);
        row.fields
            .insert("description".into(), raw(first_sentence(&description))?);
    }
    row.fields.insert("key".into(), raw(&key)?);
    row.fields.insert("group".into(), raw(group)?);
    row.fields.insert("kind".into(), raw(kind)?);
    if owner.owner == "surface" {
        let plugin = match &owner.plugin {
            Some(plugin) => compacted(plugin)?,
            None => null(),
        };
        row.fields.insert("plugin".into(), plugin);
    }
    match kind {
        "status" => {
            if let Some(value) = entry.get("value") {
                if lone_surrogate(value.get()) {
                    return Err(Failure::Other(format!(
                        "status {name} of group {group}: the value holds a lone surrogate escape"
                    )));
                }
                row.cut_text = canonical_text(value).map_err(|error| {
                    Failure::Other(format!(
                        "status {name} of group {group}: the value is no JSON: {error}"
                    ))
                })?;
                if !full {
                    row.set_value_text(DESCRIBE_VALUE_CHARS)?;
                }
            } else if let Some(failure) = entry.get("error") {
                row.fields.insert("error".into(), compacted(failure)?);
            }
        }
        "command" => {
            if !full {
                let params =
                    parameter_list(entry.get("params").map(AsRef::as_ref)).map_err(|error| {
                        Failure::Other(format!("command {name} of group {group}: {error}"))
                    })?;
                row.fields.insert("params".into(), raw(&params)?);
            }
        }
        "element" => {
            let no_items =
                || Failure::Other(format!("element {name} of group {group} has no items"));
            let items = entry.get("items").ok_or_else(no_items)?;
            let items =
                serde_json::from_str::<Option<Vec<Raw>>>(items.get()).map_err(|_| no_items())?;
            row.items = match items {
                None => None,
                Some(items) => {
                    let mut kept = Vec::with_capacity(items.len());
                    for item in &items {
                        kept.push(if full {
                            compacted(item)?
                        } else {
                            brief_item(item).map_err(|error| {
                                Failure::Other(format!("element {name} of group {group}: {error}"))
                            })?
                        });
                    }
                    Some(kept)
                }
            };
            if !full {
                row.set_items(DESCRIBE_COMPACT_ITEMS)?;
            }
        }
        _ => {}
    }
    Ok(row)
}

/// Finds the card whose tabs hold tab in a node of the layout tree, or None.
fn card_of_tab(node: Option<&RawValue>, tab: &str) -> Result<Option<Raw>, Failure> {
    let unexpected = |error: String| {
        Failure::Other(format!(
            "exposure.snapshot has an unexpected layout: {error}"
        ))
    };
    let Some(node) = node.filter(|node| node.get() != "null") else {
        return Ok(None);
    };
    let fields = object_of(node.get())
        .map_err(unexpected)?
        // default: a null node has no members, as the Go reader decodes null into a map; its lists are then empty.
        .unwrap_or_default();
    let list = |name: &str| -> Result<Vec<Raw>, Failure> {
        match fields.get(name) {
            None => Ok(Vec::new()),
            Some(raw) => serde_json::from_str::<Option<Vec<Raw>>>(raw.get())
                .map(Option::unwrap_or_default)
                .map_err(|error| unexpected(error.to_string())),
        }
    };
    for entry in list("tabs")? {
        let members = object_of(entry.get())
            .map_err(unexpected)?
            // default: a null tab entry has no members, so its missing tab is reported below.
            .unwrap_or_default();
        if field_text(&members, "tab").map_err(unexpected)? == tab {
            return Ok(fields.get("card").cloned());
        }
    }
    for child in list("children")? {
        if let Some(card) = card_of_tab(Some(&child), tab)? {
            return Ok(Some(card));
        }
    }
    Ok(None)
}

/// `agent` of the description: the surface of the agent, its space that `surface.window` answered (null for a section surface),
/// and the card of its tab when that space is the active space whose layout the snapshot holds, else null.
fn agent_place(
    layout: Option<&RawValue>,
    surface: &str,
    space: Option<&str>,
) -> Result<Raw, Failure> {
    let unexpected = |error: String| {
        Failure::Other(format!(
            "exposure.snapshot has an unexpected layout: {error}"
        ))
    };
    let layout = layout.ok_or_else(|| unexpected("the snapshot has no layout".into()))?;
    let tree = object_of(layout.get())
        .map_err(unexpected)?
        // default: a null layout has no members, as the Go reader decodes null into a map, so it holds no space.
        .unwrap_or_default();
    let mut place = Object::new();
    place.insert("surface".into(), raw(surface)?);
    place.insert(
        "space".into(),
        match space {
            Some(space) => raw(space)?,
            None => null(),
        },
    );
    place.insert("card".into(), null());
    let active = match tree.get("space") {
        Some(shown) if shown.get() != "null" => Some(member_text(shown).map_err(unexpected)?),
        _ => None,
    };
    if space.is_some()
        && active.as_deref() == space
        && let Some(card) = card_of_tab(tree.get("root").map(AsRef::as_ref), surface)?
    {
        place.insert("card".into(), compacted(&card)?);
    }
    raw_text(encode(&place)?)
}

/// Whether a status entry is a summary status: its summary member, false when absent or null, and an error when not a boolean.
fn summary_status(raw: &RawValue) -> Result<bool, Failure> {
    let unexpected = || {
        Failure::Other(format!(
            "exposure.snapshot has a status whose summary is not a boolean: {}",
            raw.get()
        ))
    };
    let entry: serde_json::Value = serde_json::from_str(raw.get()).map_err(|_| unexpected())?;
    match entry.get("summary") {
        None | Some(serde_json::Value::Null) => Ok(false),
        Some(serde_json::Value::Bool(summary)) => Ok(*summary),
        Some(_) => Err(unexpected()),
    }
}

/// One page of the description of a window from the result of exposure.snapshot. agent is `agent` of the description, None for
/// null. full gives the rows as the snapshot gives them; after and limit select the page.
fn describe_window(
    snapshot: &str,
    agent: Option<Raw>,
    full: bool,
    after: &str,
    limit: usize,
) -> Result<String, Failure> {
    let unexpected = || {
        Failure::Other(format!(
            "exposure.snapshot returned an unexpected value: {snapshot}"
        ))
    };
    let parts = object_of(snapshot)
        .map_err(|_| unexpected())?
        .ok_or_else(unexpected)?;
    let (Some(window), Some(layout), Some(plugins)) = (
        parts.get("window"),
        parts.get("layout"),
        parts.get("plugins"),
    ) else {
        return Err(unexpected());
    };
    let list = |name: &str| -> Result<Vec<Raw>, Failure> {
        parts
            .get(name)
            .and_then(|raw| {
                serde_json::from_str::<Option<Vec<Raw>>>(raw.get())
                    // default: a member that is no list is reported below as an unexpected snapshot.
                    .ok()
                    .flatten()
            })
            .ok_or_else(unexpected)
    };
    let mut groups = Vec::new();
    for raw in list("groups")? {
        groups.push(read_group(&raw).map_err(|_| unexpected())?);
    }
    let unregistered = list("unregistered")?;
    let mut rows = Vec::new();
    for group in &groups {
        let name = if group.owner == "surface" {
            &group.surface
        } else {
            &group.owner
        };
        for (kind, entries) in &group.lists {
            for entry in entries {
                // Without full, a tab holds only its summary statuses (docs/spec/cli.md#window-description).
                if !full && *kind == "status" && group.owner == "surface" && !summary_status(entry)?
                {
                    continue;
                }
                rows.push(entry_row(name, group, kind, entry, full)?);
            }
        }
    }
    for raw_entry in &unregistered {
        let wrong = || {
            Failure::Other(format!(
                "exposure.snapshot has an unexpected unregistered entry: {}",
                raw_entry.get()
            ))
        };
        let entry = object_of(raw_entry.get())
            .map_err(|_| wrong())?
            // default: a null entry has no members, so its missing kind is reported below as an unexpected entry.
            .unwrap_or_default();
        let kind = field_text(&entry, "kind").map_err(|_| wrong())?;
        let name = field_text(&entry, "name").map_err(|_| wrong())?;
        let key = format!("unregistered {kind} {name}");
        let mut fields = Object::new();
        fields.insert("key".into(), raw(&key)?);
        fields.insert("group".into(), raw("unregistered")?);
        fields.insert("kind".into(), raw(&kind)?);
        fields.insert("name".into(), raw(&name)?);
        rows.push(Row {
            key,
            kind,
            fields,
            cut_text: String::new(),
            items: None,
        });
    }
    let mut start = 0;
    if !after.is_empty() {
        start = rows
            .iter()
            .rposition(|row| row.key == after)
            .map(|n| n + 1)
            .ok_or_else(|| {
                Failure::Other(format!("after {after} names no row of the description"))
            })?;
    }
    let mut page = Object::new();
    page.insert("rows".into(), raw_text("[]".into())?);
    page.insert("total".into(), raw(&rows.len())?);
    page.insert("next".into(), null());
    if after.is_empty() {
        page.insert("window".into(), compacted(window)?);
        page.insert("layout".into(), compacted(layout)?);
        page.insert("plugins".into(), compacted(plugins)?);
        // default: a run outside the window of an agent has no agent place, which the page states as null.
        page.insert("agent".into(), agent.unwrap_or_else(null));
    }
    let base = encode(&page)?;
    // The number of bytes by which `next` grows when the page ends with row n: the key of that row instead of null when rows
    // follow it.
    let next_growth = |rows: &[Row], n: usize| -> Result<usize, Failure> {
        if n + 1 >= rows.len() {
            return Ok(0);
        }
        Ok(encode_text(&rows[n].key)?.len() - "null".len())
    };
    let mut kept: Vec<String> = Vec::new();
    let mut size = base.len();
    let mut n = start;
    while n < rows.len() && kept.len() < limit {
        let mut text = rows[n].encode()?;
        let mut grown = size + text.len() + usize::from(!kept.is_empty());
        let growth = next_growth(&rows, n)?;
        if grown + growth > DESCRIBE_PAGE_BYTES {
            if !kept.is_empty() {
                break;
            }
            text = rows[n]
                .cut_to_fit(DESCRIBE_PAGE_BYTES as isize - size as isize - growth as isize)?;
            grown = size + text.len();
        }
        kept.push(text);
        size = grown;
        n += 1;
    }
    page.insert("rows".into(), raw_text(format!("[{}]", kept.join(",")))?);
    let last = start + kept.len();
    if last < rows.len() {
        page.insert("next".into(), raw(&rows[last - 1].key)?);
    }
    encode(&page)
}

/// Asks for the window and the space of the agent's surface when they are not known yet, then for the snapshot, and writes the page.
/// own is the surface of `SOKSAK_SURFACE`; home is its window and space when the caller asked for them already.
#[allow(clippy::too_many_arguments)]
pub fn describe_request(
    request: &mut Requester,
    window: &str,
    home: Option<SurfaceHome>,
    own: Option<&str>,
    surface: &str,
    full: bool,
    after: &str,
    limit: usize,
) -> Result<String, Failure> {
    let mut agent = None;
    if let Some(own) = own {
        let mut home = home;
        if home.is_none() {
            match surface_window(request, own) {
                Ok(found) => home = Some(found),
                Err(Failure::Other(text)) if text == no_window_text(own) => {}
                Err(failure) => return Err(failure),
            }
        }
        if let Some(home) = home.filter(|home| home.window == window) {
            agent = Some((own, home.space));
        }
    }
    let mut params = serde_json::json!({ "window": window });
    if !surface.is_empty() {
        params["surface"] = Value::String(surface.to_string());
    }
    let snapshot = request("exposure.snapshot", Some(params))?;
    let place = match agent {
        None => None,
        Some((own, space)) => {
            let parts = object_of(&snapshot)
                .map_err(|error| {
                    Failure::Other(format!(
                        "exposure.snapshot returned an unexpected value: {error}"
                    ))
                })?
                // default: a null snapshot has no members, as the Go reader decodes null into a map, so it has no layout.
                .unwrap_or_default();
            Some(agent_place(
                parts.get("layout").map(AsRef::as_ref),
                own,
                space.as_deref(),
            )?)
        }
    };
    describe_window(&snapshot, place, full, after, limit)
}

/// Runs `sok describe`, and `sok commands` and `sok exposures` with --kind or --query. It returns None when the command is none of
/// them, so the command runs as before.
pub(crate) fn run_agent_view(
    a: &Arguments,
    stdout: &mut dyn Write,
    options: &Options,
    connect: &mut dyn FnMut() -> Result<Client, Error>,
) -> Option<Result<(), Error>> {
    // default: a run without a positional names no view command and continues to the command dispatch, which reports it.
    let command = a.positionals.first().map(String::as_str).unwrap_or("");
    let by_kind = a.values.contains_key("kind");
    let by_query = a.values.contains_key("query");
    let viewed = command == "describe"
        || (command == "exposures" && (by_kind || by_query))
        || (command == "commands" && by_query && !by_kind);
    if !viewed {
        // `sok context` checks its own options.
        if command != "context" && (by_kind || by_query || a.flag("full")) {
            return Some(Err(Error::Usage(
                "--kind, --query and --full belong to describe, exposures and commands".into(),
            )));
        }
        return None;
    }
    Some(view(command, a, stdout, options, connect))
}

fn view(
    command: &str,
    a: &Arguments,
    stdout: &mut dyn Write,
    options: &Options,
    connect: &mut dyn FnMut() -> Result<Client, Error>,
) -> Result<(), Error> {
    if a.positionals.len() > 1 {
        return Err(Error::Usage(format!(
            "{command} takes no argument besides [window]"
        )));
    }
    // default: a run without --kind lists every kind.
    let kind = a.values.get("kind").map(String::as_str).unwrap_or("");
    if a.values.contains_key("kind") && !is_kind(kind) {
        return Err(Error::Usage(
            "--kind must be status, command or element".into(),
        ));
    }
    let mut limit = DESCRIBE_DEFAULT_LIMIT;
    if let Some(text) = a.values.get("limit") {
        limit = text
            .parse::<i64>()
            // default: a limit that is no integer is reported below with the range of the limit.
            .ok()
            .filter(|limit| (1..=DESCRIBE_MAX_LIMIT as i64).contains(limit))
            .ok_or_else(|| {
                Error::Usage(format!(
                    "--limit must be an integer from 1 to {DESCRIBE_MAX_LIMIT}"
                ))
            })? as usize;
    }
    let mut client = connect()?;
    let outcome = view_with(command, a, kind, limit, options, &mut client);
    // When the command succeeded, the code also reports the result of closing the connection. When it failed, that failure is the result.
    let closed = client.close();
    let out = outcome?;
    closed.map_err(Error::Failed)?;
    let text = indent(&out)?;
    stdout
        .write_all(text.as_bytes())
        .map_err(|error| Error::Failed(error.to_string()))
}

fn view_with(
    command: &str,
    a: &Arguments,
    kind: &str,
    limit: usize,
    options: &Options,
    client: &mut Client,
) -> Result<String, Error> {
    // The window of the agent's surface is asked once for a description, and its answer gives the space of the agent too.
    let home = match options.surface() {
        Some(own)
            if command == "describe"
                && !a.values.contains_key("window")
                && !a.values.contains_key("project") =>
        {
            Some(crate::surface_window(client, own)?)
        }
        _ => None,
    };
    let window = match &home {
        Some(home) => home.window.clone(),
        None => select_window(a, client, options.surface())?,
    };
    let mut request = |method: &str, params: Option<Value>| {
        client.request(method, params, &mut |_: &str, _: &RawValue| Ok(()))
    };
    // default: an option that the run does not give is the empty text: no surface, the first page and no query.
    let text = |name: &str| a.values.get(name).map(String::as_str).unwrap_or("");
    if command == "describe" {
        return Ok(describe_request(
            &mut request,
            &window,
            home,
            options.surface(),
            text("surface"),
            a.flag("full"),
            text("after"),
            limit,
        )?);
    }
    let result = request(
        "exposure.list",
        Some(serde_json::json!({ "window": window })),
    )?;
    let read = read_exposure(&result)?;
    if command == "commands" {
        return Ok(matching_commands(&read, text("query")));
    }
    Ok(filter_exposure(&read, kind, text("query"))?)
}
