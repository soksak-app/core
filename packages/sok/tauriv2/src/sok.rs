//! soksak 애플리케이션의 command line(docs/spec/cli.md). 실행 중인 애플리케이션의 엔드포인트에 요청을 보내고 결과를
//! JSON 으로 출력한다.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::value::RawValue;
use serde_json::{Map, Value};

mod command;
pub mod endpoint;
pub mod install;
mod path;
#[path = "platform/platform.rs"]
pub mod platform;
mod plugins;
mod registry;
mod release;
pub mod version;
pub use release::current_platform;

use endpoint::{Client, Failure};

/// 사용법.
pub const USAGE: &str = "usage: sok <command> [options]

commands:
  <declared command> [window] [--surface S] [--<parameter> VALUE]... [--params JSON]
  commands [window]
  windows
  exposures [window]
  status NAME [window] [--surface S] [--watch]
  dom rect|click|input|dispatch NAME [window] [--surface S] [--index N] [--value V] [--event JSON]
  input pointer [window] --x X --y Y --phase move|down|drag|up|scroll [--button left|right] [--delta-x N] [--delta-y N] [--activate]
  input key [window] --key K --phase down|up [--text T] [--modifiers shift,control,option,command]
  capture [window]          (diagnostic builds) writes a still image of the window without focusing it
  path install|remove       writes or deletes the PATH entry of this application (needs sudo)
  plugin pack DIRECTORY OUTPUT [--diagnostics]
                            writes the plugin package archive into OUTPUT; --diagnostics adds diagnostics.json
  sidecar release DIRECTORY OUTPUT [--platform P]
                            writes the sidecar release asset into OUTPUT and updates SHA256SUMS
  registry build DIRECTORY  checks a registry and writes its index.json
  registry use INDEX        sets the registry index that installation reads
  plugin install|update|remove|enable|disable ID
                            changes the installed plugins of the configuration directory
  plugin list               prints plugins/installed.json

window:
  --window NAME | --project DIRECTORY   without either, the only window of the application

common options:
  --config-dir DIR          configuration directory of the running application (default: this application's)";

/// 명령이 실패한 이유. Usage 는 잘못 쓴 명령이며 종료 상태 2 와 사용법으로 보고한다.
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

const BOOLEANS: &[&str] = &["watch", "activate", "help", "diagnostics"];
const OPTIONS: &[&str] = &[
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
    "delta-x",
    "delta-y",
    "key",
    "text",
    "modifiers",
];

struct Arguments {
    positionals: Vec<String>,
    values: HashMap<String, String>,
    flags: HashMap<String, bool>,
}

fn parse(args: &[String]) -> Result<Arguments, Error> {
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
        if BOOLEANS.contains(&name) {
            if inline.is_some() {
                return Err(usage!("--{name} takes no value"));
            }
            parsed.flags.insert(name.into(), true);
        } else if OPTIONS.contains(&name) {
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
            .ok()
            .filter(|value| value.is_finite() && !text.trim().is_empty());
        let value = value.ok_or_else(|| usage!("--{name} must be a number"))?;
        Ok(Some(number_value(value)))
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

/// 정수인 수는 JSON 정수로 쓴다. Go 의 float64 직렬화와 같은 표기다.
fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// None 인 필드를 뺀 요청 매개변수.
fn compact(fields: Vec<(&str, Option<Value>)>) -> Map<String, Value> {
    fields
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| (name.to_string(), value)))
        .collect()
}

struct Request {
    method: &'static str,
    params: Option<Map<String, Value>>,
    watch: bool,
    /// 결과 객체에서 출력할 필드. None 이면 결과 전체를 출력한다.
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
            watch: false,
            field: None,
        }),
        "commands" => Ok(Request {
            method: "exposure.list",
            params: Some(compact(vec![("window", text(window()?))])),
            watch: false,
            field: Some("commands"),
        }),
        "exposures" => Ok(Request {
            method: "exposure.list",
            params: Some(compact(vec![("window", text(window()?))])),
            watch: false,
            field: None,
        }),
        "capture" => Ok(Request {
            method: "diagnostics.capture.still",
            params: Some(compact(vec![("window", text(window()?))])),
            watch: false,
            field: None,
        }),
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
                watch,
                field: None,
            })
        }
        "dom" => {
            let action = a.positional(1, "dom action")?;
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
                    method: "dom.rect",
                    params: Some(compact(base)),
                    watch: false,
                    field: None,
                }),
                "click" => {
                    base.push(("action", text("click".into())));
                    Ok(Request {
                        method: "dom.act",
                        params: Some(compact(base)),
                        watch: false,
                        field: None,
                    })
                }
                "input" => {
                    let value = a.required("value")?;
                    base.push(("action", text("input".into())));
                    base.push(("value", text(value)));
                    Ok(Request {
                        method: "dom.act",
                        params: Some(compact(base)),
                        watch: false,
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
                        method: "dom.act",
                        params: Some(compact(base)),
                        watch: false,
                        field: None,
                    })
                }
                _ => Err(usage!("unknown dom action: {action}")),
            }
        }
        "input" => {
            let kind = a.positional(1, "input kind")?;
            match kind.as_str() {
                "pointer" => {
                    let phase = a.required("phase")?;
                    if let Some(button) = a.values.get("button") {
                        if button != "left" && button != "right" {
                            return Err(usage!("--button must be left or right"));
                        }
                    }
                    if a.flag("activate") && phase != "move" {
                        return Err(usage!("--activate applies to --phase move"));
                    }
                    let x = a.required_number("x")?;
                    let y = a.required_number("y")?;
                    let delta_x = a.number("delta-x")?;
                    let delta_y = a.number("delta-y")?;
                    let activate = a.flag("activate").then_some(Value::Bool(true));
                    let window = window()?;
                    Ok(Request {
                        method: "input.pointer",
                        params: Some(compact(vec![
                            ("window", text(window)),
                            ("x", x),
                            ("y", y),
                            ("phase", text(phase)),
                            ("button", a.optional("button")),
                            ("deltaX", delta_x),
                            ("deltaY", delta_y),
                            ("activate", activate),
                        ])),
                        watch: false,
                        field: None,
                    })
                }
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
                        watch: false,
                        field: None,
                    })
                }
                _ => Err(usage!("unknown input kind: {kind}")),
            }
        }
        _ => Err(usage!("unknown command: {command}")),
    }
}

fn no_notify(_: &str, _: &RawValue) -> Result<(), String> {
    Ok(())
}

/// --window, --project 또는 하나뿐인 창으로 요청할 창을 고른다.
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
            if std::fs::canonicalize(open).ok().as_deref() == Some(target.as_path()) {
                if let Some(name) = entry["window"].as_str() {
                    return Ok(name.to_string());
                }
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

/// JSON 을 키 순서를 그대로 두고 두 칸으로 들여 쓴다. Go 의 json.Indent 와 같은 결과다.
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

/// JSON 의 공백을 뺀 한 줄.
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

/// status 값과 그 뒤의 변경을 한 줄씩 출력한다. SIGINT 나 SIGTERM 이 오면 연결을 닫고 성공으로 끝난다.
fn watch(
    client: &mut Client,
    params: Map<String, Value>,
    stdout: &mut dyn Write,
) -> Result<(), Error> {
    let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let close = client.closer()?;
        let flag = stopped.clone();
        platform::current()?.on_interrupt(Box::new(move || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            close();
        }))?;
    }
    let finish = |error: Error| -> Result<(), Error> {
        if stopped.load(std::sync::atomic::Ordering::SeqCst) {
            Ok(())
        } else {
            Err(error)
        }
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
        if method != "status.changed" {
            return Ok(());
        }
        let changed: Value = serde_json::from_str(raw.get())
            .map_err(|error| format!("status.changed has unexpected params: {error}"))?;
        // 기본값: surface 가 없는 알림은 페이지 status 이며 surface 자리는 없음(None)이다.
        let changed_surface = changed
            .get("surface")
            .filter(|value| !value.is_null())
            .cloned();
        if changed.get("window") != window.as_ref()
            || changed.get("name") != name.as_ref()
            || changed_surface != surface
        {
            return Ok(());
        }
        print(&changed["value"].to_string())
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
    print(&value)?;
    let reason = client.listen(&mut notify);
    finish(Error::Failed(reason))
}

/// command line 이 속한 애플리케이션과 운영체제 자리.
pub struct Options<'a> {
    /// 애플리케이션의 식별자이며 --config-dir 이 없을 때 설정 폴더 이름이고 경로 항목의 파일 이름이다.
    pub identifier: &'a str,
    /// 경로 항목을 두는 폴더(macOS 는 /etc/paths.d).
    pub paths_dir: &'a Path,
    /// plugin 을 고를 때 쓰는 core version. 실행 파일은 이 crate 의 version 을 준다.
    pub core_version: &'a str,
}

/// 명령 하나를 실행하고 종료 상태를 돌려준다.
pub fn run(
    args: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
) -> i32 {
    let result = execute(args, stdout, options);
    // 표준 오류에 쓰지 못하면 알릴 곳이 없으므로 종료 상태로만 실패를 알린다.
    match result {
        Ok(()) => 0,
        Err(Error::Usage(message)) => {
            // 기본값: 표준 오류 쓰기 실패는 종료 상태 2 로만 알린다.
            let _ = writeln!(stderr, "sok: {message}\n{USAGE}");
            2
        }
        Err(Error::Failed(message)) => {
            // 기본값: 표준 오류 쓰기 실패는 종료 상태 1 로만 알린다.
            let _ = writeln!(stderr, "sok: {message}");
            1
        }
    }
}

/// --config-dir 이나 이 애플리케이션의 설정 폴더에서 엔드포인트를 찾아 연결한다.
/// --config-dir 이나 이 애플리케이션의 설정 폴더.
pub(crate) fn config_dir_of(
    values: &HashMap<String, String>,
    identifier: &str,
) -> Result<PathBuf, Error> {
    Ok(match values.get("config-dir") {
        Some(dir) => PathBuf::from(dir),
        None => platform::current()?
            .config_dir()
            .map_err(|error| format!("the default configuration directory is unknown: {error}"))?
            .join(identifier),
    })
}

fn connect_to(values: &HashMap<String, String>, identifier: &str) -> Result<Client, Error> {
    let config_dir = config_dir_of(values, identifier)?;
    let endpoint = endpoint::read_endpoint(Path::new(&config_dir))?;
    Ok(Client::dial(&endpoint)?)
}

fn execute(args: &[String], stdout: &mut dyn Write, options: &Options) -> Result<(), Error> {
    let identifier = options.identifier;
    // 점이 있는 명령 단어는 선언된 command 다(docs/spec/cli.md).
    if command::command_word(args).is_some_and(|word| word.contains('.')) {
        return command::run_command(args, stdout, identifier);
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
    if matches!(first_two, (Some("plugin"), Some(action)) if action != "pack")
        || first_two == (Some("registry"), Some("use"))
    {
        return plugins::run_plugins(&a.positionals, &a.values, stdout, options);
    }
    if a.positionals.first().map(String::as_str) == Some("registry") {
        return registry::run_registry(&a.positionals, stdout);
    }
    if matches!(
        a.positionals.first().map(String::as_str),
        Some("plugin" | "sidecar")
    ) {
        return release::run_files(&a.positionals, &a.values, stdout, a.flag("diagnostics"));
    }
    if a.positionals.first().map(String::as_str) == Some("path") {
        let action = a.positional(1, "path action")?;
        return path::run_path(&action, stdout, options);
    }
    let mut client: Option<Client> = None;
    let connect = |client: &mut Option<Client>| -> Result<(), Error> {
        if client.is_none() {
            *client = Some(connect_to(&a.values, identifier)?);
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
    let client = client.as_mut().expect("connected above");
    if request.watch {
        return watch(client, request.params.expect("status has params"), stdout);
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
