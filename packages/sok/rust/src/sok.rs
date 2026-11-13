//! The command line of the soksak application (docs/spec/cli.md). It sends a request to the endpoint of the running application and prints the result as
//! JSON.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::value::RawValue;
use serde_json::{Map, Value};

pub mod appupdate;
mod command;
mod debug;
#[cfg(feature = "diagnostics")]
mod diagnostics;
pub mod endpoint;
pub mod event_bounds;
pub mod event_classes;
pub mod event_log;
pub mod fetch;
mod files;
pub mod identity;
pub mod install;
pub mod log_index;
pub mod log_policy;
pub mod log_query;
mod logged;
mod manifest;
mod output;
mod ownership;
mod path;
#[path = "platform/platform.rs"]
pub mod platform;
pub mod plugin_catalog;
pub mod plugins;
mod process;
mod registry;
pub mod replay;
pub mod replay_inputs;
pub mod routine;
pub mod version;
pub use logged::{Command, logged, run_logged, start_tool_event_log};
pub use output::current_platform;
pub use routine::PANIC_STATUS;

use endpoint::{Client, Failure};

/// The usage text.
pub const USAGE: &str = "usage: sok <command> [options]

commands:
  <declared command> [window] [--surface S] [--<parameter> VALUE]... [--params JSON]
  commands [window]
  windows
  exposures [window]
  status NAME [window] [--surface S] [--watch]
  element rect|click|input|dispatch NAME [window] [--surface S] [--index N] [--value V] [--event JSON]
  input pointer [window] [--pointer NAME] --x X --y Y --phase move|down|drag|up|scroll [--button left|right] [--delta-x N] [--delta-y N] [--clicks N] [--activate]
  input gesture [window] [--pointer NAME] [--button left|right] [--clicks N] --points X,Y[;X,Y]...
                            sends down at the first point, a drag to each later point and up at the last on one connection
  input key [window] --key K --phase down|up [--text T] [--modifiers shift,control,option,command]
  input text [window] --phase mark|insert|unmark [--text T] [--selection START,LENGTH] [--replacement START,LENGTH]
                            gives one step of a composition to the text input client of the key responder, as an input method does
  debug query [--channel C] [--level L] [--class C] [--layer L] [--event E] [--event-prefix P] [--surface S] [--session S] [--cid C] [--run R] [--text T] [--from T] [--to T] [--order asc|desc] [--limit N] [--after CURSOR]
                            prints one page of the events of the event files that pass the filter
  debug replay SESSION [--until SEQUENCE]
                            replays the session with the replay executable of its sidecar and compares every stored screen hash
  capture [window]          (diagnostic builds) writes a still image of the window without focusing it
  path install|remove       writes or deletes the PATH entry of this application (needs sudo)
  app update --wait PID --bundle PATH --target PATH [-- ARGUMENT...]
                            replaces the application bundle TARGET with BUNDLE after the process PID ended
  app relaunch --wait PID --target PATH [-- ARGUMENT...]
                            starts the application bundle TARGET again in the background after the process PID ended
  process wait PID
                            waits for the operating system to report that PID ended
  registry build DIRECTORY  checks a registry and writes its index.json
  registry use INDEX        sets the registry index that installation reads
  plugin install|update|remove|enable|disable ID
                            changes the installed plugins of the configuration directory
  plugin list               prints plugins/installed.json

window:
  --window NAME | --project DIRECTORY   without either, the only window of the application

common options:
  --config-dir DIR          configuration directory of the running application (default: this application's)";

/// The reason a command failed. Usage is a command written wrongly and is reported with exit status 2 and the usage text.
enum Error {
    Usage(String),
    Failed(String),
}

impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        Error::Failed(failure.to_string())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error::Failed(message)
    }
}

macro_rules! usage {
    ($($arg:tt)*) => { Error::Usage(format!($($arg)*)) };
}

const BOOLEANS: &[&str] = &["watch", "activate", "help"];
const OPTIONS: &[&str] = &[
    "wait",
    "bundle",
    "target",
    "config-dir",
    "window",
    "project",
    "surface",
    "index",
    "value",
    "event",
    "x",
    "y",
    "phase",
    "platform",
    "button",
    "pointer",
    "points",
    "delta-x",
    "clicks",
    "delta-y",
    "key",
    "text",
    "modifiers",
    "selection",
    "replacement",
    "level",
    "layer",
    "session",
    "cid",
    "from",
    "to",
    "channel",
    "class",
    "event-prefix",
    "run",
    "order",
    "limit",
    "after",
    "around",
    "earlier",
    "later",
    "until",
];

struct Arguments {
    positionals: Vec<String>,
    values: HashMap<String, String>,
    flags: HashMap<String, bool>,
}

fn parse(args: &[String]) -> Result<Arguments, Error> {
    parse_with_options(args, BOOLEANS, OPTIONS)
}

fn parse_with_options(
    args: &[String],
    allowed_booleans: &[&str],
    allowed_options: &[&str],
) -> Result<Arguments, Error> {
    let mut parsed = Arguments {
        positionals: vec![],
        values: HashMap::new(),
        flags: HashMap::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let Some(option) = arg.strip_prefix("--") else {
            parsed.positionals.push(arg.clone());
            i += 1;
            continue;
        };
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (option, None),
        };
        if allowed_booleans.contains(&name) {
            if inline.is_some() {
                return Err(usage!("--{name} takes no value"));
            }
            parsed.flags.insert(name.into(), true);
        } else if allowed_options.contains(&name) {
            if parsed.values.contains_key(name) {
                return Err(usage!("--{name} is given twice"));
            }
            let value = match inline {
                Some(value) => value,
                None => {
                    i += 1;
                    args.get(i)
                        .cloned()
                        .ok_or_else(|| usage!("--{name} needs a value"))?
                }
            };
            parsed.values.insert(name.into(), value);
        } else {
            return Err(usage!("unknown option --{name}"));
        }
        i += 1;
    }
    Ok(parsed)
}

impl Arguments {
    fn flag(&self, name: &str) -> bool {
        self.flags.contains_key(name)
    }

    fn required(&self, name: &str) -> Result<String, Error> {
        self.values
            .get(name)
            .cloned()
            .ok_or_else(|| usage!("--{name} is required"))
    }

    fn positional(&self, index: usize, what: &str) -> Result<String, Error> {
        self.positionals
            .get(index)
            .cloned()
            .ok_or_else(|| usage!("{what} is required"))
    }

    fn number(&self, name: &str) -> Result<Option<Value>, Error> {
        let Some(text) = self.values.get(name) else {
            return Ok(None);
        };
        let value = text
            .trim()
            .parse::<f64>()
            // default: text that is not a finite number becomes the usage error below.
            .ok()
            .filter(|value| value.is_finite() && !text.trim().is_empty());
        let value = value.ok_or_else(|| usage!("--{name} must be a number"))?;
        Ok(Some(number_value(value)))
    }

    /// Reads `--name START,LENGTH` as the range `{start, length}` of `input.text`, or None when it is not given.
    fn text_range(&self, name: &str) -> Result<Option<Value>, Error> {
        let Some(given) = self.values.get(name) else {
            return Ok(None);
        };
        let parts: Vec<&str> = given.split(',').collect();
        if let [start, length] = parts.as_slice()
            && let (Ok(start), Ok(length)) =
                (start.trim().parse::<i64>(), length.trim().parse::<i64>())
        {
            return Ok(Some(serde_json::json!({"start": start, "length": length})));
        }
        Err(usage!("--{name} must be START,LENGTH"))
    }

    fn required_number(&self, name: &str) -> Result<Option<Value>, Error> {
        self.required(name)?;
        self.number(name)
    }

    fn optional(&self, name: &str) -> Option<Value> {
        self.values
            .get(name)
            .map(|value| Value::String(value.clone()))
    }
}

/// A number that is an integer is written as a JSON integer, like the float64 serialization of Go.
fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// The request parameters without the fields that are None.
fn compact(fields: Vec<(&str, Option<Value>)>) -> Map<String, Value> {
    fields
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| (name.to_string(), value)))
        .collect()
}

/// How a planned request runs: one request, a watch of a status, or the steps of a gesture, each a request of
/// `method` with its params, on one connection.
pub(crate) enum Mode {
    Once,
    Watch,
    Gesture(Vec<Map<String, Value>>),
}

pub(crate) struct Request {
    method: &'static str,
    params: Option<Map<String, Value>>,
    mode: Mode,
    /// The field of the result object to print. When None, the whole result is printed.
    field: Option<&'static str>,
}

fn plan(
    a: &Arguments,
    window: &mut dyn FnMut() -> Result<String, Error>,
) -> Result<Request, Error> {
    let command = a.positional(0, "command")?;
    let text = |value: String| Some(Value::String(value));
    match command.as_str() {
        "windows" => Ok(Request {
            method: "windows.list",
            params: None,
            mode: Mode::Once,
            field: None,
        }),
        "commands" => Ok(Request {
            method: "exposure.list",
            params: Some(compact(vec![("window", text(window()?))])),
            mode: Mode::Once,
            field: Some("commands"),
        }),
        "exposures" => Ok(Request {
            method: "exposure.list",
            params: Some(compact(vec![("window", text(window()?))])),
            mode: Mode::Once,
            field: None,
        }),
        // Only the diagnostic build has the capture request (diagnostics.rs). The sok of a regular build has no diagnostic methods.
        #[cfg(feature = "diagnostics")]
        "capture" => Ok(diagnostics::capture(window()?)),
        #[cfg(not(feature = "diagnostics"))]
        "capture" => Err(Error::Usage(
            "capture needs a diagnostic build of sok".into(),
        )),
        "status" => {
            let name = a.positional(1, "NAME")?;
            let watch = a.flag("watch");
            let window = window()?;
            Ok(Request {
                method: if watch { "status.watch" } else { "status.get" },
                params: Some(compact(vec![
                    ("window", text(window)),
                    ("name", text(name)),
                    ("surface", a.optional("surface")),
                ])),
                mode: if watch { Mode::Watch } else { Mode::Once },
                field: None,
            })
        }
        "element" => {
            let action = a.positional(1, "element action")?;
            let name = a.positional(2, "NAME")?;
            let index = a.number("index")?;
            let window = window()?;
            let mut base = vec![
                ("window", text(window)),
                ("name", text(name)),
                ("surface", a.optional("surface")),
                ("index", index),
            ];
            match action.as_str() {
                "rect" => Ok(Request {
                    method: "element.rect",
                    params: Some(compact(base)),
                    mode: Mode::Once,
                    field: None,
                }),
                "click" => {
                    base.push(("action", text("click".into())));
                    Ok(Request {
                        method: "element.act",
                        params: Some(compact(base)),
                        mode: Mode::Once,
                        field: None,
                    })
                }
                "input" => {
                    let value = a.required("value")?;
                    base.push(("action", text("input".into())));
                    base.push(("value", text(value)));
                    Ok(Request {
                        method: "element.act",
                        params: Some(compact(base)),
                        mode: Mode::Once,
                        field: None,
                    })
                }
                "dispatch" => {
                    let event_text = a.required("event")?;
                    let event: Value = serde_json::from_str(&event_text)
                        .map_err(|_| usage!("--event must be a JSON object with a type"))?;
                    if !event.is_object() || !event["type"].is_string() {
                        return Err(usage!("--event must be a JSON object with a type"));
                    }
                    base.push(("action", text("dispatch".into())));
                    base.push(("event", Some(event)));
                    Ok(Request {
                        method: "element.act",
                        params: Some(compact(base)),
                        mode: Mode::Once,
                        field: None,
                    })
                }
                _ => Err(usage!("unknown element action: {action}")),
            }
        }
        "input" => {
            let kind = a.positional(1, "input kind")?;
            match kind.as_str() {
                "pointer" => {
                    let phase = a.required("phase")?;
                    if let Some(button) = a.values.get("button")
                        && button != "left"
                        && button != "right"
                    {
                        return Err(usage!("--button must be left or right"));
                    }
                    if a.flag("activate") && phase != "move" {
                        return Err(usage!("--activate applies to --phase move"));
                    }
                    let x = a.required_number("x")?;
                    let y = a.required_number("y")?;
                    let delta_x = a.number("delta-x")?;
                    let delta_y = a.number("delta-y")?;
                    let clicks = a.number("clicks")?;
                    let activate = a.flag("activate").then_some(Value::Bool(true));
                    let window = window()?;
                    Ok(Request {
                        method: "input.pointer",
                        params: Some(compact(vec![
                            ("window", text(window)),
                            ("pointer", a.optional("pointer")),
                            ("x", x),
                            ("y", y),
                            ("phase", text(phase)),
                            ("button", a.optional("button")),
                            ("deltaX", delta_x),
                            ("deltaY", delta_y),
                            ("clicks", clicks),
                            ("activate", activate),
                        ])),
                        mode: Mode::Once,
                        field: None,
                    })
                }
                "gesture" => gesture(a, window),
                "key" => {
                    let key = a.required("key")?;
                    let phase = a.required("phase")?;
                    let modifiers = a.values.get("modifiers").map(|list| {
                        Value::Array(
                            list.split(',')
                                .filter(|item| !item.is_empty())
                                .map(|item| Value::String(item.into()))
                                .collect(),
                        )
                    });
                    let window = window()?;
                    Ok(Request {
                        method: "input.key",
                        params: Some(compact(vec![
                            ("window", text(window)),
                            ("key", text(key)),
                            ("phase", text(phase)),
                            ("text", a.optional("text")),
                            ("modifiers", modifiers),
                        ])),
                        mode: Mode::Once,
                        field: None,
                    })
                }
                "text" => {
                    let phase = a.required("phase")?;
                    let selection = a.text_range("selection")?;
                    let replacement = a.text_range("replacement")?;
                    let window = window()?;
                    Ok(Request {
                        method: "input.text",
                        params: Some(compact(vec![
                            ("window", text(window)),
                            ("phase", text(phase)),
                            ("text", a.optional("text")),
                            ("selection", selection),
                            ("replacement", replacement),
                        ])),
                        mode: Mode::Once,
                        field: None,
                    })
                }
                _ => Err(usage!("unknown input kind: {kind}")),
            }
        }
        _ => Err(usage!("unknown command: {command}")),
    }
}

/// Plans `input gesture`: `down` at the first point of `--points`, a `drag` to each later point and `up` at the last point,
/// each an `input.pointer` request of the same pointer and button (docs/spec/cli.md).
fn gesture(
    a: &Arguments,
    window: impl FnOnce() -> Result<String, Error>,
) -> Result<Request, Error> {
    if let Some(button) = a.values.get("button")
        && button != "left"
        && button != "right"
    {
        return Err(usage!("--button must be left or right"));
    }
    let clicks = a.number("clicks")?;
    let points = points(&a.required("points")?)?;
    // The window is asked for after the arguments are checked, so a usage error opens no connection.
    let window = window()?;
    let last = points.len() - 1;
    let step = |phase: &str, (x, y): (f64, f64), clicks: Option<Value>| {
        compact(vec![
            ("window", Some(Value::String(window.clone()))),
            ("pointer", a.optional("pointer")),
            ("x", Some(number_value(x))),
            ("y", Some(number_value(y))),
            ("phase", Some(Value::String(phase.into()))),
            ("button", a.optional("button")),
            ("clicks", clicks),
        ])
    };
    let mut steps = vec![step("down", points[0], clicks.clone())];
    for point in &points[1..] {
        steps.push(step("drag", *point, None));
    }
    steps.push(step("up", points[last], clicks));
    Ok(Request {
        method: "input.pointer",
        params: None,
        mode: Mode::Gesture(steps),
        field: None,
    })
}

/// Reads the points of `--points`: `x,y` pairs separated by `;`, at least one.
fn points(text: &str) -> Result<Vec<(f64, f64)>, Error> {
    let wrong = || usage!("--points must be x,y pairs separated by ;");
    let coordinate = |text: &str| -> Result<f64, Error> {
        let text = text.trim();
        text.parse::<f64>()
            // default: text that is not a finite number becomes the usage error.
            .ok()
            .filter(|value| value.is_finite() && !text.is_empty())
            .ok_or_else(wrong)
    };
    text.split(';')
        .map(|pair| {
            let (x, y) = pair.split_once(',').ok_or_else(wrong)?;
            Ok((coordinate(x)?, coordinate(y)?))
        })
        .collect()
}

fn no_notify(_: &str, _: &RawValue) -> Result<(), String> {
    Ok(())
}

/// Chooses the window to request from --window, --project or the only window.
fn select_window(a: &Arguments, client: &mut Client) -> Result<String, Error> {
    let by_name = a.values.get("window");
    let by_project = a.values.get("project");
    if by_name.is_some() && by_project.is_some() {
        return Err(usage!(
            "--window and --project select the window in two ways; give one"
        ));
    }
    if let Some(name) = by_name {
        return Ok(name.clone());
    }
    let result = client.request("windows.list", None, &mut no_notify)?;
    let windows: Vec<Value> = serde_json::from_str(&result)
        .map_err(|error| format!("windows.list returned an unexpected value: {error}"))?;
    let mut names: Vec<String> = windows
        .iter()
        .filter_map(|entry| entry["window"].as_str().map(String::from))
        .collect();
    names.sort();
    if let Some(project) = by_project {
        let target = std::fs::canonicalize(project)
            .map_err(|error| format!("project directory {project}: {error}"))?;
        for entry in &windows {
            let Some(open) = entry["project"].as_str() else {
                continue;
            };
            // default: a window whose project path cannot be resolved cannot be the target; no match returns the error that lists the windows.
            if std::fs::canonicalize(open).ok().as_deref() == Some(target.as_path())
                && let Some(name) = entry["window"].as_str()
            {
                return Ok(name.to_string());
            }
        }
        return Err(Error::Failed(format!(
            "no window shows the project {}; windows: {}",
            target.display(),
            names.join(", ")
        )));
    }
    if windows.len() != 1 {
        return Err(usage!(
            "the application has {} windows ({}); select one with --window or --project",
            windows.len(),
            names.join(", ")
        ));
    }
    windows[0]["window"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| Error::Failed("windows.list returned a window without a name".into()))
}

/// Writes JSON with two-space indentation and keeps the key order. The result equals json.Indent of Go.
pub fn indent(raw: &str) -> Result<String, String> {
    serde_json::from_str::<&RawValue>(raw)
        .map_err(|error| format!("endpoint returned invalid JSON: {error}"))?;
    let mut out = String::with_capacity(raw.len() * 2);
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '{' | '[' => {
                let close = if c == '{' { '}' } else { ']' };
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == close {
                    out.push(c);
                    out.push(close);
                    i = j;
                } else {
                    out.push(c);
                    depth += 1;
                    newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth -= 1;
                newline(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(c);
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
        i += 1;
    }
    out.push('\n');
    Ok(out)
}

/// The JSON on one line without whitespace.
fn compact_line(raw: &str) -> Result<String, String> {
    let value: &RawValue = serde_json::from_str(raw)
        .map_err(|error| format!("endpoint returned invalid JSON: {error}"))?;
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in value.get().chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out.push('\n');
    Ok(out)
}

/// Prints the status value and each later change on its own line. `status.ended` of the watch ends it with the error
/// `status <name> ended: <reason>`. On SIGINT or SIGTERM the routine of the signal closes the connection, stores the command with
/// the result of the close and ends the process, also while this thread waits in a write to its standard output.
fn watch(
    client: &mut Client,
    params: Map<String, Value>,
    stdout: &mut dyn Write,
) -> Result<(), Error> {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let close = client.closer()?;
        let flag = stopped.clone();
        platform::current()?.on_interrupt(Box::new(move |_signal| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            crate::routine::interrupted(close());
        }))?;
    }
    let finish = |error: Error| -> Result<(), Error> {
        if stopped.load(std::sync::atomic::Ordering::SeqCst) {
            // The close of the routine of the signal ended this read, and that routine ends the process with the result
            // of the close.
            loop {
                std::thread::park();
            }
        }
        Err(error)
    };
    let surface = params.get("surface").cloned();
    let window = params.get("window").cloned();
    let name = params.get("name").cloned();
    let out = std::cell::RefCell::new(stdout);
    let print = |raw: &str| -> Result<(), String> {
        let line = compact_line(raw)?;
        out.borrow_mut()
            .write_all(line.as_bytes())
            .map_err(|error| error.to_string())
    };
    let mut notify = |method: &str, raw: &RawValue| -> Result<(), String> {
        if method != "status.changed" && method != "status.ended" {
            return Ok(());
        }
        let notice: Value = serde_json::from_str(raw.get())
            .map_err(|error| format!("{method} has unexpected params: {error}"))?;
        // default: a notification without a surface is a page status, and its surface is none (None).
        let notice_surface = notice
            .get("surface")
            .filter(|value| !value.is_null())
            .cloned();
        if notice.get("window") != window.as_ref()
            || notice.get("name") != name.as_ref()
            || notice_surface != surface
        {
            return Ok(());
        }
        if method == "status.ended" {
            // default: the name was sent as a string and a reason that is not one is printed as its JSON.
            let shown = name.as_ref().and_then(Value::as_str).unwrap_or_default();
            let reason = match &notice["reason"] {
                Value::String(reason) => reason.clone(),
                other => other.to_string(),
            };
            return Err(format!("status {shown} ended: {reason}"));
        }
        print(&notice["value"].to_string())
    };
    if let Err(failure) = client.request(
        "status.watch",
        Some(Value::Object(params.clone())),
        &mut notify,
    ) {
        return finish(failure.into());
    }
    let mut target = Map::new();
    for key in ["window", "name", "surface"] {
        if let Some(value) = params.get(key) {
            target.insert(key.into(), value.clone());
        }
    }
    let value = match client.request("status.get", Some(Value::Object(target)), &mut notify) {
        Ok(value) => value,
        Err(failure) => return finish(failure.into()),
    };
    if let Err(error) = print(&value) {
        return finish(Error::Failed(error));
    }
    let reason = client.listen(&mut notify);
    finish(Error::Failed(reason))
}

/// The application and the operating system that this command line belongs to.
pub struct Options<'a> {
    /// The identifier of the application. It is the configuration folder name when --config-dir is absent and the file name of the path entry.
    pub identifier: &'a str,
    /// The folder that holds path entries (/etc/paths.d on macOS). When this operating system has no such folder, it holds the reason, and sok path
    /// fails with that error.
    pub paths_dir: Result<&'a Path, String>,
    /// The core version used to choose plugins. The executable supplies the version of this crate.
    pub core_version: &'a str,
}

/// Runs one command and returns the exit status.
pub fn run(
    args: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
) -> i32 {
    let wait_process_end = Box::new(|pid| {
        let platform = platform::current().map_err(process::WaitError::Platform)?;
        platform
            .wait_process_end(pid)
            .map_err(process::WaitError::Operation)
    });
    run_with_process_wait(args, stdout, stderr, options, wait_process_end)
}

fn run_with_process_wait(
    args: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
    wait_process_end: Box<process::Wait>,
) -> i32 {
    let result = execute(args, stdout, stderr, options, wait_process_end);
    // When the error cannot be written to standard error, there is nowhere to report it, so the code reports it with exit status 3 (docs/spec/cli.md).
    let (written, status) = match result {
        Ok(()) => return 0,
        Err(Error::Usage(message)) => (writeln!(stderr, "sok: {message}\n{USAGE}"), 2),
        Err(Error::Failed(message)) => (writeln!(stderr, "sok: {message}"), 1),
    };
    match written {
        Ok(()) => status,
        Err(_) => 3,
    }
}

/// Finds the endpoint in config-dir or the configuration folder of this application and connects to it.
/// config-dir or the configuration folder of this application.
pub(crate) fn config_dir_of(
    values: &HashMap<String, String>,
    options: &Options,
) -> Result<PathBuf, Error> {
    if let Some(dir) = values.get("config-dir") {
        return Ok(PathBuf::from(dir));
    }
    let base = platform::current()?
        .config_dir()
        .map_err(|error| format!("the default configuration directory is unknown: {error}"))?;
    Ok(base.join(options.identifier))
}

fn connect_to(values: &HashMap<String, String>, options: &Options) -> Result<Client, Error> {
    let config_dir = config_dir_of(values, options)?;
    let endpoint = endpoint::read_endpoint(Path::new(&config_dir))?;
    Ok(Client::dial(&endpoint)?)
}

/// Parses the options of a command that does its own parsing.
pub(crate) fn parse_arguments(args: &[String]) -> Result<Arguments, Error> {
    parse(args)
}

pub(crate) fn parse_scoped_arguments(
    args: &[String],
    allowed_booleans: &[&str],
    allowed_options: &[&str],
) -> Result<Arguments, Error> {
    parse_with_options(args, allowed_booleans, allowed_options)
}

fn execute(
    args: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
    wait_process_end: Box<process::Wait>,
) -> Result<(), Error> {
    // The arguments after -- are those of the application that starts again, so the command parses its own.
    if args.first().map(String::as_str) == Some("app") {
        return appupdate::run_app(&args[1..], stdout);
    }
    if args.first().map(String::as_str) == Some("process") {
        return process::run(&args[1..], stdout, wait_process_end);
    }
    // A command word with a dot is a declared command (docs/spec/cli.md).
    if command::command_word(args).is_some_and(|word| word.contains('.')) {
        return command::run_command(args, stdout, options);
    }
    let a = parse(args)?;
    if a.flag("help") {
        writeln!(stdout, "{USAGE}").map_err(|error| error.to_string())?;
        return Ok(());
    }
    let first_two = (
        a.positionals.first().map(String::as_str),
        a.positionals.get(1).map(String::as_str),
    );
    if matches!(first_two, (Some("plugin"), Some(_)))
        || first_two == (Some("registry"), Some("use"))
    {
        return plugins::run_plugins(&a.positionals, &a.values, stdout, options);
    }
    if a.positionals.first().map(String::as_str) == Some("registry") {
        return registry::run_registry(&a.positionals, stdout);
    }
    if first_two == (Some("plugin"), None) {
        return Err(Error::Usage("plugin action is required".into()));
    }
    if a.positionals.first().map(String::as_str) == Some("debug") {
        return debug::run_debug(&a, stdout, stderr, options);
    }
    if a.positionals.first().map(String::as_str) == Some("path") {
        let action = a.positional(1, "path action")?;
        return path::run_path(&action, stdout, options);
    }
    let mut client: Option<Client> = None;
    let connect = |client: &mut Option<Client>| -> Result<(), Error> {
        if client.is_none() {
            *client = Some(connect_to(&a.values, options)?);
        }
        Ok(())
    };
    let request = {
        let mut choose = || -> Result<String, Error> {
            connect(&mut client)?;
            select_window(&a, client.as_mut().expect("connected above"))
        };
        plan(&a, &mut choose)?
    };
    connect(&mut client)?;
    let mut client = client.expect("connected above");
    let outcome = send(&mut client, request, stdout);
    // When the command succeeded, the code also reports the result of closing the connection. When it failed, that failure is the result.
    let closed = client.close();
    outcome?;
    closed.map_err(Error::Failed)
}

#[cfg(test)]
#[path = "process_wait_test.rs"]
mod process_wait_tests;

/// Sends the planned request and prints the result.
fn send(client: &mut Client, request: Request, stdout: &mut dyn Write) -> Result<(), Error> {
    match request.mode {
        Mode::Once => {}
        Mode::Watch => {
            return watch(client, request.params.expect("status has params"), stdout);
        }
        Mode::Gesture(steps) => {
            // The steps share the connection, so a step that fails leaves its press to the close of the connection, which
            // releases it (docs/spec/exposure.md#methods).
            for (index, step) in steps.into_iter().enumerate() {
                if let Err(failure) =
                    client.request(request.method, Some(Value::Object(step)), &mut no_notify)
                {
                    return Err(Error::Failed(format!(
                        "gesture step {}: {failure}",
                        index + 1
                    )));
                }
            }
            return Ok(());
        }
    }
    let mut result = client.request(
        request.method,
        request.params.map(Value::Object),
        &mut no_notify,
    )?;
    if let Some(field) = request.field {
        let fields: HashMap<String, Box<RawValue>> = serde_json::from_str(&result)
            .map_err(|_| format!("{} returned no {field}", request.method))?;
        result = fields
            .get(field)
            .map(|value| value.get().to_string())
            .ok_or_else(|| format!("{} returned no {field}", request.method))?;
    }
    let out = indent(&result)?;
    stdout
        .write_all(out.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}
