//! 선언된 command 를 실행한다(docs/spec/cli.md). 매개변수 flag 는 고른 창의 exposure.list 가 보고하는 매개변수
//! schema 로 해석하며, 맞지 않는 flag 와 값은 command 를 보내기 전에 거부한다.

use std::collections::HashMap;
use std::io::Write;

use serde_json::{Map, Value};

use crate::{connect_to, indent, no_notify, select_window, Arguments, Error, Options};

/// 선언된 command 와 함께 쓰는, 값을 받는 공통 option.
const COMMON_VALUES: &[&str] = &["config-dir", "window", "project", "surface", "params"];

/// 첫 위치 인자. 공통 option 의 값은 위치 인자가 아니다.
pub(crate) fn command_word(args: &[String]) -> Option<&str> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let Some(option) = arg.strip_prefix("--") else {
            return Some(arg);
        };
        if !option.contains('=') && COMMON_VALUES.contains(&option) {
            i += 1;
        }
        i += 1;
    }
    None
}

/// 선언된 command 의 인자. flags 는 schema 로 해석하기 전의 매개변수 flag 다.
struct CommandArguments {
    name: String,
    common: HashMap<String, String>,
    flags: Vec<String>,
}

fn parse_command(args: &[String]) -> Result<CommandArguments, Error> {
    let mut parsed = CommandArguments {
        name: String::new(),
        common: HashMap::new(),
        flags: vec![],
    };
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let Some(option) = arg.strip_prefix("--") else {
            if !parsed.name.is_empty() {
                return Err(Error::Usage(format!("unexpected argument {arg}")));
            }
            parsed.name = arg.clone();
            i += 1;
            continue;
        };
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (option, None),
        };
        if !COMMON_VALUES.contains(&name) {
            parsed.flags.push(arg.clone());
            // 값을 = 뒤에 주지 않은 flag 의 다음 인자는 그 값일 수 있다. boolean 인지는 schema 를 읽은 뒤 정한다.
            if inline.is_none() && i + 1 < args.len() && !args[i + 1].starts_with("--") {
                i += 1;
                parsed.flags.push(args[i].clone());
            }
            i += 1;
            continue;
        }
        if parsed.common.contains_key(name) {
            return Err(Error::Usage(format!("--{name} is given twice")));
        }
        let value = match inline {
            Some(value) => value,
            None => {
                i += 1;
                args.get(i)
                    .cloned()
                    .ok_or_else(|| Error::Usage(format!("--{name} needs a value")))?
            }
        };
        parsed.common.insert(name.into(), value);
        i += 1;
    }
    Ok(parsed)
}

/// 매개변수 선언의 type 이름. 이름 하나나 이름 목록이다.
fn types(declared: &Value) -> Result<Vec<String>, String> {
    match declared.get("type") {
        None => Ok(vec![]),
        Some(Value::String(one)) => Ok(vec![one.clone()]),
        Some(Value::Array(many)) if many.iter().all(Value::is_string) => Ok(many
            .iter()
            .filter_map(|kind| kind.as_str().map(String::from))
            .collect()),
        Some(other) => Err(format!(
            "parameter type {other} is neither a name nor a list of names"
        )),
    }
}

/// enum 값의 텍스트. Go 의 fmt.Sprint 와 같은 표기다.
fn option_text(option: &Value) -> String {
    match option {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// flag 의 텍스트를 매개변수 schema 의 값으로 바꾼다.
fn convert(name: &str, text: &str, declared: &Value) -> Result<Value, Error> {
    if let Some(options) = declared
        .get("enum")
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty())
    {
        if let Some(option) = options.iter().find(|option| option_text(option) == text) {
            return Ok(option.clone());
        }
        let names: Vec<String> = options.iter().map(option_text).collect();
        return Err(Error::Usage(format!(
            "--{name} must be one of {}",
            names.join(", ")
        )));
    }
    let kinds = types(declared)?;
    // 목록에 null 이 있으면 텍스트 null 은 다른 type 보다 먼저 null 이다(docs/spec/cli.md).
    if text == "null" && kinds.iter().any(|kind| kind == "null") {
        return Ok(Value::Null);
    }
    let mut failures = vec![];
    for kind in kinds {
        match kind.as_str() {
            "null" => {}
            "string" => return Ok(Value::String(text.into())),
            "number" => {
                if let Some(value) = text.parse::<f64>().ok().filter(|value| value.is_finite()) {
                    return Ok(crate::number_value(value));
                }
            }
            "integer" => {
                if let Ok(value) = text.parse::<i64>() {
                    return Ok(Value::from(value));
                }
            }
            "boolean" if text == "true" || text == "false" => {
                return Ok(Value::Bool(text == "true"))
            }
            "boolean" => {}
            "object" | "array" => {
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    if (kind == "object" && value.is_object())
                        || (kind == "array" && value.is_array())
                    {
                        return Ok(value);
                    }
                }
            }
            other => {
                return Err(Error::Failed(format!(
                    "parameter --{name} has the unknown type {other}"
                )))
            }
        }
        failures.push(kind);
    }
    Err(Error::Usage(format!(
        "--{name} must be {}",
        failures.join(" or ")
    )))
}

/// 매개변수 flag 를 schema 로 해석한 매개변수 객체.
fn parameters(
    command: &str,
    properties: &Map<String, Value>,
    flags: &[String],
) -> Result<Map<String, Value>, Error> {
    let mut params = Map::new();
    let mut names: Vec<&str> = properties.keys().map(String::as_str).collect();
    names.sort();
    let mut i = 0;
    while i < flags.len() {
        let arg = &flags[i];
        let Some(option) = arg.strip_prefix("--") else {
            return Err(Error::Usage(format!("unexpected argument {arg}")));
        };
        let (name, inline) = match option.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (option, None),
        };
        let Some(declared) = properties.get(name) else {
            return Err(Error::Usage(format!(
                "--{name} is not a parameter of {command}; its parameters are {}",
                names.join(", ")
            )));
        };
        if params.contains_key(name) {
            return Err(Error::Usage(format!("--{name} is given twice")));
        }
        let kinds = types(declared)?;
        let text = match inline {
            Some(text) => text,
            None if kinds == ["boolean"] => {
                params.insert(name.into(), Value::Bool(true));
                i += 1;
                continue;
            }
            None => {
                i += 1;
                match flags.get(i) {
                    Some(value) if !value.starts_with("--") => value.clone(),
                    _ => return Err(Error::Usage(format!("--{name} needs a value"))),
                }
            }
        };
        params.insert(name.into(), convert(name, &text, declared)?);
        i += 1;
    }
    Ok(params)
}

/// 선언된 command 하나를 실행하고 결과를 출력한다.
pub(crate) fn run_command(
    args: &[String],
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let parsed = parse_command(args)?;
    let mut client = connect_to(&parsed.common, options)?;
    let arguments = Arguments {
        positionals: vec![],
        values: parsed.common.clone(),
        flags: HashMap::new(),
    };
    let window = select_window(&arguments, &mut client)?;
    let listed = client.request(
        "exposure.list",
        Some(serde_json::json!({"window": window})),
        &mut no_notify,
    )?;
    let exposures: Value = serde_json::from_str(&listed)
        .map_err(|error| format!("exposure.list returned an unexpected value: {error}"))?;
    let commands = exposures["commands"].as_array().ok_or_else(|| {
        "exposure.list returned an unexpected value: commands is not a list".to_string()
    })?;
    let Some(command) = commands
        .iter()
        .find(|command| command["name"] == parsed.name.as_str())
    else {
        return Err(Error::Usage(format!(
            "{} is not a declared command of window {window}; sok commands lists them",
            parsed.name
        )));
    };
    let params = match parsed.common.get("params") {
        Some(text) => {
            if !parsed.flags.is_empty() {
                return Err(Error::Usage(
                    "--params gives the whole parameter object and cannot be combined with parameter flags".into(),
                ));
            }
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(object)) => object,
                _ => return Err(Error::Usage("--params must be a JSON object".into())),
            }
        }
        None => {
            // 기본값: 매개변수를 선언하지 않은 command 는 properties 가 없고 빈 매개변수 객체를 받는다.
            let empty = Map::new();
            let properties = command["params"]["properties"]
                .as_object()
                // 기본값: 매개변수를 선언하지 않은 command 는 properties 가 없고 빈 매개변수 객체를 받는다.
                .unwrap_or(&empty);
            parameters(&parsed.name, properties, &parsed.flags)?
        }
    };
    let mut request = Map::new();
    request.insert("window".into(), Value::String(window));
    request.insert("name".into(), Value::String(parsed.name.clone()));
    request.insert("params".into(), Value::Object(params));
    if let Some(surface) = parsed.common.get("surface") {
        request.insert("surface".into(), Value::String(surface.clone()));
    }
    let result = client.request("command.run", Some(Value::Object(request)), &mut no_notify)?;
    let out = indent(&result)?;
    stdout
        .write_all(out.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}
