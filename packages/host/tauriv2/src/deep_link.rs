//! Parses deep links and runs them as declared commands (docs/spec/native-host.md#deep-links).

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use tauri::AppHandle;

use crate::application_log::log_error;
use crate::endpoint::{self, Service};
use crate::exposure::Host;

/// The URL scheme of deep links.
const SCHEME: &str = "soksak";

/// The maximum number of characters of a deep link URL.
const MAX_LENGTH: usize = 8192;

const INVALID_PERCENT: &str = "invalid percent-encoding";

/// A parsed deep link: the declared command `<owner>.<command>` and its string parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLink {
    pub owner: String,
    pub command: String,
    pub params: BTreeMap<String, String>,
}

impl DeepLink {
    /// The declared command name of the link.
    pub fn name(&self) -> String {
        format!("{}.{}", self.owner, self.command)
    }
}

/// Parses the URL value of a deep link. An error text is the reason of the refusal.
pub fn parse_deep_link(value: &str) -> Result<DeepLink, String> {
    if value.chars().count() > MAX_LENGTH {
        return Err(format!("URL is longer than {MAX_LENGTH} characters"));
    }
    let parsed = url::Url::parse(value).map_err(|_| "URL does not parse".to_string())?;
    if parsed.scheme() != SCHEME {
        return Err(format!("scheme {:?} is not soksak", parsed.scheme()));
    }
    let owner = parsed.host_str().unwrap_or_default();
    if owner.is_empty() {
        return Err("owner is missing".to_string());
    }
    let command = parsed.path().strip_prefix('/').unwrap_or(parsed.path());
    if command.is_empty() {
        return Err("command is missing".to_string());
    }
    if command.contains('/') {
        return Err("command has more than one segment".to_string());
    }
    Ok(DeepLink {
        owner: owner.to_string(),
        command: command.to_string(),
        params: parse_params(parsed.query().unwrap_or_default())?,
    })
}

/// Splits the raw query into its parameters. An empty segment is skipped. A name that is empty or repeats is refused.
fn parse_params(raw: &str) -> Result<BTreeMap<String, String>, String> {
    let mut params = BTreeMap::new();
    for segment in raw.split('&').filter(|segment| !segment.is_empty()) {
        let (raw_name, raw_value) = segment.split_once('=').unwrap_or((segment, ""));
        let name = decode_component(raw_name)?;
        if name.is_empty() {
            return Err("parameter name is empty".to_string());
        }
        if params.contains_key(&name) {
            return Err(format!("parameter {name} is repeated"));
        }
        let value = decode_component(raw_value)?;
        params.insert(name, value);
    }
    Ok(params)
}

/// Decodes a query name or value: `+` is a space and each percent sign is followed by two hexadecimal digits. The
/// decoded text must be valid UTF-8.
fn decode_component(raw: &str) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' => {
                let high = bytes.get(index + 1).copied().and_then(hex_value);
                let low = bytes.get(index + 2).copied().and_then(hex_value);
                match (high, low) {
                    (Some(high), Some(low)) => decoded.push(high << 4 | low),
                    _ => return Err(INVALID_PERCENT.to_string()),
                }
                index += 2;
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| INVALID_PERCENT.to_string())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Runs the deep link value on a routine. A refusal is written once as the error host deep link.
pub fn open(app: &AppHandle, value: String) {
    let app = app.clone();
    crate::routine::spawn_named("deep-link", move || {
        if let Err(reason) = run(&app, &value) {
            log_error("deep link", format!("{value}: {reason}"));
        }
    });
}

/// Runs the link as the declared command of the key window, or of the first window when none is key.
fn run(app: &AppHandle, value: &str) -> Result<(), String> {
    let link = parse_deep_link(value)?;
    let service = Host(app.clone());
    let listed = service.windows().map_err(|failure| failure.message)?;
    let entries = listed
        .as_array()
        .ok_or_else(|| "window list is not an array".to_string())?;
    let chosen = entries
        .iter()
        .find(|entry| entry["key"] == Value::Bool(true))
        .or_else(|| entries.first())
        .ok_or_else(|| "no window is open".to_string())?;
    let window = chosen["window"]
        .as_str()
        .ok_or_else(|| "window identifier is not a string".to_string())?;
    let mut arguments = Map::new();
    arguments.insert("name".to_string(), json!(link.name()));
    arguments.insert("params".to_string(), json!(link.params));
    endpoint::name(&arguments).map_err(|failure| failure.message)?;
    service
        .call(window, "command.run", arguments)
        .map_err(|failure| failure.message)?;
    Ok(())
}
