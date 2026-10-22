//! The rules of the replay inputs of a session (docs/spec/replay.md#records): the forms of each kind and the rules of a session,
//! with the texts of `replayInputProblem` and `replaySessionProblem` of @soksak/log-contract, whose golden cases
//! (docs/spec/cases/log-contract/replay/inputs.json) both tools reproduce.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::Value;

/// The kinds of the replay inputs, which `replay.inputs` of a sidecar.json maps to event names.
pub const REPLAY_INPUT_KINDS: [&str; 6] = [
    "output",
    "write",
    "resize",
    "selection",
    "viewport",
    "theme",
];

/// The members of a JSON object in the order of the text, so a problem names the first member that breaks a rule as the
/// JavaScript reader does.
struct Ordered(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Ordered, D::Error> {
        struct OrderedVisitor;
        impl<'de> Visitor<'de> for OrderedVisitor {
            type Value = Ordered;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut members = Vec::new();
                while let Some(member) = map.next_entry::<String, Value>()? {
                    members.push(member);
                }
                Ok(Ordered(members))
            }
        }
        deserializer.deserialize_map(OrderedVisitor)
    }
}

/// A value as JSON.stringify writes it, and `undefined` for an absent member.
fn shown(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => value.to_string(),
    }
}

/// The value of a member as an integer when it is a number without a fraction.
fn integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0).then_some(number as i64)
}

fn integer_from(kind: &str, fields: &Value, name: &str, min: i64) -> Option<String> {
    match integer(fields.get(name)) {
        Some(value) if value >= min => None,
        _ => Some(format!(
            "{kind}: {name} must be an integer from {min}, found {}",
            shown(fields.get(name))
        )),
    }
}

fn is_hex(text: &str) -> bool {
    !text.is_empty()
        && text.len().is_multiple_of(2)
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_color(text: &str) -> bool {
    text.len() == 7
        && text.starts_with('#')
        && text[1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The problem of the fields of one replay input of `kind`, given as the text of the event, as text, or `None` when the fields
/// are in the form of the contract. The members of the colors of a theme are judged in the order of the text.
pub fn replay_input_problem(kind: &str, text: &str) -> Option<String> {
    let (fields, colors) = fields_of(text);
    let colors = colors.as_deref();
    let fields = &fields;
    if !REPLAY_INPUT_KINDS.contains(&kind) {
        return Some(format!(
            "replay input {kind} is not one of {}",
            REPLAY_INPUT_KINDS.join(", ")
        ));
    }
    if let Some(problem) = integer_from(kind, fields, "sequence", 1) {
        return Some(problem);
    }
    match kind {
        "output" | "write" => {
            if fields
                .get("hex")
                .and_then(Value::as_str)
                .is_some_and(is_hex)
            {
                return None;
            }
            Some(format!(
                "{kind}: hex must be lowercase hexadecimal text of whole bytes, found {}",
                shown(fields.get("hex"))
            ))
        }
        "resize" => {
            integer_from(kind, fields, "rows", 1).or_else(|| integer_from(kind, fields, "cols", 1))
        }
        "selection" => {
            let action = fields.get("action").and_then(Value::as_str);
            match action {
                Some("start") | Some("update") => integer_from(kind, fields, "edge", 0)
                    .or_else(|| integer_from(kind, fields, "row", 0)),
                Some(action @ ("end" | "clear")) => (fields.get("edge").is_some()
                    || fields.get("row").is_some())
                .then(|| format!("selection: {action} takes no edge and no row")),
                _ => Some(format!(
                    "selection: action must be start, update, end or clear, found {}",
                    shown(fields.get("action"))
                )),
            }
        }
        "viewport" => match (fields.get("lines"), fields.get("newest")) {
            (Some(_), Some(_)) => Some("viewport: lines and newest are exclusive".to_string()),
            (None, None) => Some(
                "viewport: lines (a non-zero integer) or newest (true) is required".to_string(),
            ),
            (None, Some(newest)) => (newest != &Value::Bool(true))
                .then(|| format!("viewport: newest must be true, found {newest}")),
            (Some(lines), None) => match integer(Some(lines)) {
                Some(value) if value != 0 => None,
                _ => Some(format!(
                    "viewport: lines must be a non-zero integer, found {lines}"
                )),
            },
        },
        _ => {
            // default: colors that are not an object are refused below with the value shown.
            let members = colors.and_then(|text| serde_json::from_str::<Ordered>(text).ok());
            let Some(Ordered(members)) = members else {
                return Some(format!(
                    "theme: colors must be an object of colors, found {}",
                    shown(fields.get("colors"))
                ));
            };
            for name in ["foreground", "background", "selection"] {
                if !members.iter().any(|(member, _)| member == name) {
                    return Some(format!("theme: colors.{name} is required"));
                }
            }
            members.iter().find_map(|(name, color)| {
                (!color.as_str().is_some_and(is_color)).then(|| {
                    format!("theme: colors.{name} must be \"#rrggbb\" in lowercase, found {color}")
                })
            })
        }
    }
}

/// One replay input of a session: its kind and the text of its fields as the event stored them.
pub struct ReplayInput {
    pub kind: String,
    pub fields: String,
}

/// The fields of an input and the text of its member `colors`, which a theme judges in its order.
fn fields_of(text: &str) -> (Value, Option<String>) {
    // silent: fields that are not JSON are refused by the form check, which reads an empty object.
    let fields: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let colors = serde_json::from_str::<
        std::collections::HashMap<String, Box<serde_json::value::RawValue>>,
    >(text)
    // default: fields that are not an object have no colors, which the form check of a theme refuses.
    .ok()
    .and_then(|members| members.get("colors").map(|raw| raw.get().to_string()));
    (fields, colors)
}

/// The problem of the replay inputs of one session in the order they were applied, as text, or `None`: each input is in form,
/// the sequences run from 1 without a gap, the first input is a theme, a selection start or update lies inside the grid of the
/// last resize, and a selection update or end follows a selection start.
pub fn replay_session_problem(inputs: &[ReplayInput]) -> Option<String> {
    let mut previous = 0i64;
    let mut selecting = false;
    let mut size: Option<(i64, i64)> = None;
    for (index, input) in inputs.iter().enumerate() {
        let at = index + 1;
        if let Some(problem) = replay_input_problem(&input.kind, &input.fields) {
            return Some(format!("input {at}: {problem}"));
        }
        let (fields, _) = fields_of(&input.fields);
        // default: the form check above requires this member, so the default is never read.
        let sequence = integer(fields.get("sequence")).unwrap_or(0);
        if sequence != previous + 1 {
            return Some(format!(
                "input {at} has sequence {sequence} and the sequence after {previous} is {}",
                previous + 1
            ));
        }
        previous = sequence;
        if index == 0 && input.kind != "theme" {
            return Some(format!(
                "input 1 is a {} and the first input of a session is a theme",
                input.kind
            ));
        }
        if input.kind == "resize" {
            size = Some((
                // default: the form check above requires this member, so the default is never read.
                integer(fields.get("rows")).unwrap_or(0),
                // default: the form check above requires this member, so the default is never read.
                integer(fields.get("cols")).unwrap_or(0),
            ));
        }
        if input.kind != "selection" {
            continue;
        }
        // default: the form check above requires this member, so the default is never read.
        let action = fields.get("action").and_then(Value::as_str).unwrap_or("");
        if action == "start" || action == "update" {
            let Some((rows, cols)) = size else {
                return Some(format!(
                    "input {at} is a selection {action} before any resize"
                ));
            };
            // default: the form check above requires this member, so the default is never read.
            let edge = integer(fields.get("edge")).unwrap_or(0);
            // default: the form check above requires this member, so the default is never read.
            let row = integer(fields.get("row")).unwrap_or(0);
            if row >= rows || edge > cols {
                return Some(format!(
                    "input {at} is a selection {action} at edge {edge} row {row} outside the grid of {rows} rows and {cols} columns"
                ));
            }
        }
        if (action == "update" || action == "end") && !selecting {
            return Some(format!(
                "input {at} is a selection {action} and no selection has started"
            ));
        }
        selecting = action == "start" || action == "update";
    }
    None
}
