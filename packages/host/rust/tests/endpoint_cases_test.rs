//! Replays the endpoint contract cases that the endpoint answers without a window and without a page (docs/spec/endpoint.md#checks)
//! against the real endpoint. The client frames of a case are sent in order, and each frame of the host must equal the frame of the
//! case: a variable binds the value of the host and must have its declared type and keys, as e2e/endpoint-contract.test.mjs checks a
//! running application. The client reads and writes its frames with its own code, not with the framing of the host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/platform/platform.rs"]
mod endpoint_client;

use endpoint_client::Connection;

use std::collections::BTreeSet;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{Map, Value};
use soksak_host::endpoint::{Endpoint, Failure, ReplyScope, Service};

/// The largest frame of the framing (docs/spec/endpoint.md#framing).
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// The code of the internal error, which the service uses for the requests that the tier does not play.
const INTERNAL_ERROR: i64 = -32603;

/// The longest wait for the frames of one case. A case that does not finish in it fails.
const CASE_LIMIT: Duration = Duration::from_secs(10);

/// The window state of a host with no page attached: the endpoint reads the window names for the window lookup. A request that needs
/// the page returns an error, so a frame that reaches the page does not match its case.
struct TierService {
    windows: Vec<String>,
}

impl Service for TierService {
    fn windows(&self) -> Result<Value, Failure> {
        Err(Failure::new(
            INTERNAL_ERROR,
            "windows.list is not played by the endpoint tier",
        ))
    }

    fn exists(&self, window: &str) -> bool {
        self.windows.iter().any(|name| name == window)
    }

    fn call(
        &self,
        _window: &str,
        method: &str,
        _params: Map<String, Value>,
        _reply: Option<ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        Err(Failure::new(
            INTERNAL_ERROR,
            format!("{method}: no page is attached in the endpoint tier"),
        ))
    }

    /// No case of the tier watches a status, so no watch ends here.
    fn unwatched(&self, _window: &str, _name: &str) {}
}

/// Opens the endpoint in the sockets directory inside config with the windows of the tier. It does not write endpoint.json.
fn start(config: &Path, windows: &[&str]) -> Endpoint {
    let service = Arc::new(TierService {
        windows: windows.iter().map(|window| window.to_string()).collect(),
    });
    Endpoint::start(&config.join("sockets"), config, "endpoint-tier", service).unwrap()
}

/// The directory of the endpoint cases, found by walking up from the manifest directory of this package.
fn case_directory() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .map(|dir| dir.join("docs/spec/cases/endpoint"))
        .find(|candidate| candidate.is_dir())
        .unwrap_or_else(|| panic!("no docs/spec/cases/endpoint above {}", manifest.display()))
}

/// Reads one case file. The name of the case is the name of its file.
fn read_case(path: &Path) -> Result<Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let case: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not a readable case: {error}", path.display()))?;
    let stem = path.file_stem().and_then(|stem| stem.to_str());
    if case["name"].as_str() != stem {
        return Err(format!(
            "{}: name does not match the file name",
            path.display()
        ));
    }
    Ok(case)
}

/// Writes one client frame of a send step: the bytes of raw_hex, or the length prefix and the JSON body of the step.
fn write_send(connection: &mut Connection, send: &Value) -> Result<(), String> {
    if let Some(hex) = send.get("raw_hex").and_then(Value::as_str) {
        let bytes = hex::decode(hex).map_err(|error| format!("raw_hex {hex:?}: {error}"))?;
        return connection
            .write_all(&bytes)
            .map_err(|error| error.to_string());
    }
    let body = serde_json::to_vec(send).map_err(|error| error.to_string())?;
    let length = u32::try_from(body.len()).map_err(|error| error.to_string())?;
    connection
        .write_all(&length.to_be_bytes())
        .and_then(|()| connection.write_all(&body))
        .map_err(|error| error.to_string())
}

/// Reads one frame of the host. The end of the connection at a frame boundary is Ok(None), and so is a reset at a frame boundary.
fn read_host_frame(connection: &mut Connection) -> Result<Option<Value>, String> {
    let mut prefix = [0u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match connection.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err("connection closed inside a length prefix".into()),
            Ok(count) => filled += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if filled == 0 && error.kind() == ErrorKind::ConnectionReset => {
                return Ok(None);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_FRAME {
        return Err(format!(
            "host frame of {length} bytes exceeds the limit of {MAX_FRAME}"
        ));
    }
    let mut body = vec![0u8; length];
    connection
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("host frame is not JSON: {error}"))
}

/// The name of a variable of a case: `$` and a name that starts with a lowercase letter and continues with lowercase letters, digits
/// and hyphens.
fn variable_name(text: &str) -> Option<&str> {
    let name = text.strip_prefix('$')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    (first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    .then_some(name)
}

/// The type names of a variable, which are one name or a list of names.
fn type_names(value: &Value) -> Result<Vec<String>, String> {
    if let Some(name) = value.as_str() {
        return Ok(vec![name.to_string()]);
    }
    let names = value
        .as_array()
        .ok_or_else(|| format!("type {value} is neither a name nor a list of names"))?;
    names
        .iter()
        .map(|name| {
            name.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("type {name} is not a name"))
        })
        .collect()
}

/// Whether actual has one of the types. An unknown type name is an error of the case.
fn has_type(types: &[String], actual: &Value) -> Result<bool, String> {
    for name in types {
        let matched = match name.as_str() {
            "any" => true,
            "null" => actual.is_null(),
            "string" => actual.is_string(),
            "boolean" => actual.is_boolean(),
            "number" => actual.is_number(),
            "integer" => actual.as_f64().is_some_and(|number| number.fract() == 0.0),
            "array" => actual.is_array(),
            "object" => actual.is_object(),
            other => return Err(format!("type {other:?} is not a JSON type")),
        };
        if matched {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether actual is an object that has every declared key.
fn has_keys(actual: &Value, keys: &[Value]) -> bool {
    actual.as_object().is_some_and(|object| {
        keys.iter()
            .all(|key| key.as_str().is_some_and(|key| object.contains_key(key)))
    })
}

/// Compares a part of a host frame with the same part of the case. A variable binds the first value that it meets and must equal
/// that value wherever it appears again; the first value must have the declared type, and the declared keys when the variable names
/// them. A difference is a problem; a case that is not valid is an error.
fn match_value(
    expected: &Value,
    actual: &Value,
    variables: &Map<String, Value>,
    bound: &mut Map<String, Value>,
    path: &str,
    problems: &mut Vec<String>,
) -> Result<(), String> {
    if let Some(name) = expected.as_str().and_then(variable_name) {
        let Some(spec) = variables.get(name) else {
            problems.push(format!("{path}: variable ${name} is not declared"));
            return Ok(());
        };
        if let Some(value) = bound.get(name) {
            if value != actual {
                problems.push(format!(
                    "{path}: {name} is {actual}, bound earlier to {value}"
                ));
            }
            return Ok(());
        }
        let type_value = spec
            .get("type")
            .ok_or_else(|| format!("variable ${name} has no type"))?;
        let types = type_names(type_value)?;
        if !has_type(&types, actual)? {
            problems.push(format!(
                "{path}: {actual} is not of type {}",
                types.join(" or ")
            ));
        } else if let Some(keys) = spec.get("keys") {
            let keys = keys
                .as_array()
                .ok_or_else(|| format!("variable ${name} has keys that are not a list"))?;
            if !has_keys(actual, keys) {
                problems.push(format!("{path}: {actual} does not have the keys {keys:?}"));
            }
        }
        bound.insert(name.to_string(), actual.clone());
        return Ok(());
    }
    match expected {
        Value::Array(want) => {
            let Some(got) = actual.as_array().filter(|got| got.len() == want.len()) else {
                problems.push(format!(
                    "{path}: expected an array of {}, got {actual}",
                    want.len()
                ));
                return Ok(());
            };
            for (index, (want, got)) in want.iter().zip(got).enumerate() {
                match_value(
                    want,
                    got,
                    variables,
                    bound,
                    &format!("{path}[{index}]"),
                    problems,
                )?;
            }
        }
        Value::Object(want) => {
            let Some(got) = actual.as_object() else {
                problems.push(format!("{path}: expected an object, got {actual}"));
                return Ok(());
            };
            let keys: BTreeSet<&str> = want.keys().map(String::as_str).collect();
            let actual_keys: BTreeSet<&str> = got.keys().map(String::as_str).collect();
            if keys != actual_keys {
                problems.push(format!("{path}: keys {actual_keys:?} are not {keys:?}"));
                return Ok(());
            }
            for (key, want) in want {
                match_value(
                    want,
                    &got[key.as_str()],
                    variables,
                    bound,
                    &format!("{path}.{key}"),
                    problems,
                )?;
            }
        }
        _ => {
            if expected != actual {
                problems.push(format!("{path}: {actual} is not {expected}"));
            }
        }
    }
    Ok(())
}

/// Reads the replies and the close of a case from the host and returns the problems found. The steps are the ones after the sends,
/// which the caller wrote before.
fn read_steps(
    mut connection: Connection,
    steps: Vec<Value>,
    variables: Map<String, Value>,
) -> Vec<String> {
    let mut problems = Vec::new();
    let mut bound = Map::new();
    for (index, step) in steps.iter().enumerate() {
        let at = format!("step {index}");
        if let Some(expected) = step.get("reply").or_else(|| step.get("notify")) {
            let message = match read_host_frame(&mut connection) {
                Ok(Some(message)) => message,
                Ok(None) => {
                    problems.push(format!(
                        "{at}: the connection closed where the case has {expected}"
                    ));
                    return problems;
                }
                Err(error) => {
                    problems.push(format!(
                        "{at}: no frame of the host ({error}) where the case has {expected}"
                    ));
                    return problems;
                }
            };
            if let Err(error) = match_value(
                expected,
                &message,
                &variables,
                &mut bound,
                &at,
                &mut problems,
            ) {
                problems.push(format!("{at}: {error}"));
                return problems;
            }
        } else if let Some(close) = step.get("close") {
            match close.as_str() {
                Some("client") => return problems,
                Some("host") => {
                    match read_host_frame(&mut connection) {
                        Ok(None) => {}
                        Ok(Some(message)) => {
                            problems.push(format!(
                                "{at}: the host sent {message} where the case has its close"
                            ));
                        }
                        Err(error) => {
                            problems.push(format!(
                                "{at}: the host did not close the connection: {error}"
                            ));
                        }
                    }
                    return problems;
                }
                _ => {
                    problems.push(format!("{at}: close must be host or client, is {close}"));
                    return problems;
                }
            }
        } else if step.get("send").is_some() {
            problems.push(format!(
                "{at}: this runner plays the sends before the replies only"
            ));
            return problems;
        } else {
            problems.push(format!(
                "{at}: the step has no reply, notify, send or close"
            ));
            return problems;
        }
    }
    problems
}

/// Sends the leading send steps of the case, then checks the rest of its steps on the connection of the host. The reading runs on a
/// thread so that the case has a time limit; a case that does not finish in the limit is a problem.
fn replay(case: &Value, address: &str) -> Vec<String> {
    let mut connection = endpoint_client::connect(address);
    let steps = case
        .get("steps")
        .and_then(Value::as_array)
        .expect("a case has a list of steps")
        .clone();
    let variables = case
        .get("variables")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut index = 0;
    while let Some(send) = steps.get(index).and_then(|step| step.get("send")) {
        if let Err(error) = write_send(&mut connection, send) {
            return vec![format!("step {index}: the client cannot send: {error}")];
        }
        index += 1;
    }
    let rest = steps[index..].to_vec();
    if rest.is_empty() {
        return Vec::new();
    }
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        // A receiver that ended by its limit has reported that limit already, so the send error is not reported again.
        let _ = sender.send(read_steps(connection, rest, variables));
    });
    receiver
        .recv_timeout(CASE_LIMIT)
        .unwrap_or_else(|error| vec![format!("no result within {CASE_LIMIT:?}: {error}")])
}

/// Plays the case of the name on an endpoint with the windows, and asserts that the frames of the host match the case.
fn play(name: &str, windows: &[&str]) {
    let case = read_case(&case_directory().join(format!("{name}.json"))).unwrap();
    assert_eq!(
        case["replay"],
        Value::Bool(true),
        "{name} is played by this runner but its case has replay false"
    );
    let config = folder::Folder::new();
    let endpoint = start(config.path(), windows);
    let problems = replay(&case, endpoint.address());
    endpoint.stop();
    assert!(problems.is_empty(), "{name}:\n{}", problems.join("\n"));
}

// contract: endpoint.transport.http-request-line-closes
#[test]
fn framing_http_request_line() {
    play("framing-http-request-line", &[]);
}

// contract: endpoint.transport.invalid-json-closes
#[test]
fn framing_invalid_json() {
    play("framing-invalid-json", &[]);
}

// contract: endpoint.transport.length-over-limit-closes
#[test]
fn framing_length_over_limit() {
    play("framing-length-over-limit", &[]);
}

// contract: endpoint.transport.non-jsonrpc-object-closes
#[test]
fn framing_not_object() {
    play("framing-not-object", &[]);
}

// contract: endpoint.transport.non-jsonrpc-object-closes
#[test]
fn framing_version_not_2() {
    play("framing-version-not-2", &[]);
}

// contract: endpoint.transport.undeclared-method-closes
#[test]
fn undeclared_method() {
    play("undeclared-method", &[]);
}

// contract: endpoint.names.owner-form-required, endpoint.rpc.target-params-are-checked-in-order
#[test]
fn error_invalid_params() {
    play("error-invalid-params", &[]);
}

// contract: endpoint.rpc.unknown-window-1003
#[test]
fn error_window_missing() {
    play("error-window-missing", &[]);
}

// contract: endpoint.rpc.unknown-window-1003, endpoint.rpc.target-params-are-checked-in-order
#[test]
fn command_window_missing() {
    play("command-window-missing", &[]);
}

// contract: endpoint.names.unknown-host-name-1001, endpoint.errors.unknown-name-text
#[test]
fn command_unknown_host() {
    play("command-unknown-host", &["main"]);
}

/// The cases that this runner plays.
const PLAYED: &[&str] = &[
    "framing-http-request-line",
    "framing-invalid-json",
    "framing-length-over-limit",
    "framing-not-object",
    "framing-version-not-2",
    "undeclared-method",
    "error-invalid-params",
    "error-window-missing",
    "command-window-missing",
    "command-unknown-host",
];

/// The cases with replay true that this runner does not play, with the reason.
const OUTSIDE: &[(&str, &str)] = &[
    (
        "capture-still",
        "diagnostics.capture.still answers the path of a captured window, which needs a registered window and a diagnostic build",
    ),
    (
        "closed-by-client-pending",
        "the case has no host frame: its outcome is the client rejecting a pending request, which the client tests check",
    ),
    (
        "exposure-list",
        "exposure.list answers the entries that the page declares",
    ),
    (
        "hello",
        "windows.list answers the entry of the main window with the ready state that the page reports",
    ),
    (
        "mcp-tools-list",
        "the MCP client reads exposure.list of a window, which needs a page",
    ),
    (
        "no-request",
        "the case has no host frame: it checks the reading of endpoint.json by the client, which the client tests check",
    ),
    (
        "sok-capture-still",
        "the sok client captures a registered window, which needs a page",
    ),
    (
        "sok-commands",
        "the sok client reads exposure.list of a window, which needs a page",
    ),
    (
        "sok-declared-rejects",
        "the sok client reads exposure.list of a window, which needs a page",
    ),
    (
        "sok-status-value",
        "status.get of a page status, which the page answers",
    ),
    (
        "status-get-screen",
        "status.get of a page status, which the page answers",
    ),
    (
        "status-unknown-name",
        "status.get of a name that is not a host status is answered by the page",
    ),
    (
        "watch-current-value",
        "status.watch of a page status, whose value the page reports",
    ),
    (
        "watch-predicate-not-boolean",
        "status.watch of a page status, whose predicate the page evaluates",
    ),
    (
        "watch-until-close",
        "status.watch of a page status, whose value the page reports",
    ),
    (
        "window-check-no-mark",
        "the window check refuses the run before any request, so the host receives no frame",
    ),
    (
        "window-check-test-mark-fail",
        "diagnostics.test.mark needs a registered window and a diagnostic build",
    ),
    (
        "window-check-test-mark-pass",
        "diagnostics.test.mark needs a registered window and a diagnostic build",
    ),
    (
        "window-check-test-mark-start-end",
        "diagnostics.test.mark needs a registered window and a diagnostic build",
    ),
    (
        "window-check-test-mark-start",
        "diagnostics.test.mark needs a registered window and a diagnostic build",
    ),
];

// contract: endpoint.cases.replayed-cases-are-covered
#[test]
fn every_replayed_case_is_played_or_excluded() {
    let directory = case_directory();
    let mut problems = Vec::new();
    for entry in std::fs::read_dir(&directory).expect("the case directory can be read") {
        let path = entry.expect("a directory entry can be read").path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
        match read_case(&path) {
            Err(error) => problems.push(error),
            Ok(case) => {
                let listed = PLAYED.contains(&name.as_str())
                    || OUTSIDE.iter().any(|(outside, _)| *outside == name);
                if case["replay"] == Value::Bool(true) && !listed {
                    problems.push(format!(
                        "{name} is replayed by its case but neither played by this runner nor listed outside it"
                    ));
                }
            }
        }
    }
    for name in PLAYED
        .iter()
        .copied()
        .chain(OUTSIDE.iter().map(|(name, _)| *name))
    {
        if !directory.join(format!("{name}.json")).is_file() {
            problems.push(format!("{name} is listed but has no case file"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
