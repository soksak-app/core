//! Parses deep links and runs them as declared commands (docs/spec/native-host.md#deep-links).

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

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
    let Some(owner) = parsed.host_str().filter(|owner| !owner.is_empty()) else {
        return Err("owner is missing".to_string());
    };
    let Some(command) = parsed
        .path()
        .strip_prefix('/')
        .filter(|command| !command.is_empty())
    else {
        return Err("command is missing".to_string());
    };
    if command.contains('/') {
        return Err("command has more than one segment".to_string());
    }
    Ok(DeepLink {
        owner: owner.to_string(),
        command: command.to_string(),
        params: match parsed.query() {
            Some(query) => parse_params(query)?,
            None => BTreeMap::new(),
        },
    })
}

/// Splits the raw query into its parameters. An empty segment is skipped. A name that is empty or repeats is refused.
fn parse_params(raw: &str) -> Result<BTreeMap<String, String>, String> {
    let mut params = BTreeMap::new();
    for segment in raw.split('&').filter(|segment| !segment.is_empty()) {
        // A segment without `=` is a name with an empty value, as in the query of a form.
        let (raw_name, raw_value) = match segment.split_once('=') {
            Some(pair) => pair,
            None => (segment, ""),
        };
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

/// Holds the deep links that arrive before the first window is ready and runs them in arrival order.
/// A link that arrives after the first window is ready runs at once.
pub struct DeepLinkQueue {
    state: Mutex<QueueState>,
}

struct QueueState {
    pending: VecDeque<String>,
    draining: bool,
    ready: bool,
}

impl DeepLinkQueue {
    /// Creates a queue that holds every link until it is ready.
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(QueueState {
                pending: VecDeque::new(),
                draining: false,
                ready: false,
            }),
        }
    }

    /// Runs the value with `run` at once when the first window is ready. Before that it holds the value.
    pub fn keep(&self, value: String, run: &dyn Fn(&str)) {
        let mut state = self
            .state
            .lock()
            .expect("deep link queue state is not poisoned");
        if state.ready {
            drop(state);
            run(&value);
        } else {
            state.pending.push_back(value);
        }
    }

    /// Runs the held links in arrival order and marks the queue ready. A link that arrives while the held links run is
    /// held too, so it runs after them. A call after the first one does nothing.
    pub fn ready(&self, run: &dyn Fn(&str)) {
        {
            let mut state = self
                .state
                .lock()
                .expect("deep link queue state is not poisoned");
            if state.ready || state.draining {
                return;
            }
            state.draining = true;
        }
        loop {
            let next = {
                let mut state = self
                    .state
                    .lock()
                    .expect("deep link queue state is not poisoned");
                match state.pending.pop_front() {
                    Some(value) => value,
                    None => {
                        state.ready = true;
                        state.draining = false;
                        return;
                    }
                }
            };
            run(&next);
        }
    }
}

impl Default for DeepLinkQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// The deep links of the application: the links that arrive before its first window is ready are held here.
static DEEP_LINKS: DeepLinkQueue = DeepLinkQueue::new();

/// Runs the deep link value once the first window is ready, on a routine. A refusal is written once as the error host deep link.
pub fn open(app: &AppHandle, value: String) {
    let app = app.clone();
    crate::routine::spawn_named("deep-link", move || {
        DEEP_LINKS.keep(value, &|link| run_logged(&app, link));
    });
}

/// Runs the links that arrived before the first window was ready. The host calls it when the first window is ready.
pub fn ready(app: &AppHandle) {
    let app = app.clone();
    crate::routine::spawn_named("deep-link-ready", move || {
        DEEP_LINKS.ready(&|link| run_logged(&app, link));
    });
}

fn run_logged(app: &AppHandle, value: &str) {
    if let Err(reason) = run(app, value) {
        log_error("deep link", format!("{value}: {reason}"));
    }
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
