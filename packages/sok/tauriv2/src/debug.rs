//! `sok debug query` (docs/spec/debug.md#timeline-command): one page of the events of the event files of the configuration directory,
//! printed as the text lines of the timeline of the debug view (packages/workbench/debug-timeline.js). The reader of an event line, its
//! text line and the JSON helpers that keep the output of the two implementations equal are here.

use std::fmt;
use std::io::Write;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

use crate::log_index::{CLASSES, LAYERS, LEVELS};
use crate::log_query::{format_log_cursor, log_row_line, parse_log_query, query_logs};
use crate::{config_dir_of, Arguments, Error, Options};

/// A JSON value whose object members keep the order of the text, which the text line of a row keeps.
pub(crate) enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Number(value as f64))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Number(value as f64))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(Json::Number(value))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::String(value.to_string()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = vec![];
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut members = vec![];
                while let Some((name, value)) = map.next_entry::<String, Json>()? {
                    members.push((name, value));
                }
                Ok(Json::Object(members))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

/// The last member of an object with the name: a repeated name is read as the last one, as JSON.parse does.
fn get<'a>(members: &'a [(String, Json)], name: &str) -> Option<&'a Json> {
    members
        .iter()
        .rev()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v)
}

/// The text that JSON.stringify gives a number.
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let text = format!("{:e}", value.abs());
    let (mantissa, exponent) = text.split_once('e').expect("exponent form");
    let exponent: i32 = exponent.parse().expect("exponent");
    let digits = mantissa.replace('.', "");
    let n = exponent + 1;
    let out = if 0 < n && n <= 21 {
        let n = n as usize;
        if digits.len() <= n {
            format!("{digits}{}", "0".repeat(n - digits.len()))
        } else {
            format!("{}.{}", &digits[..n], &digits[n..])
        }
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let mut out = digits[..1].to_string();
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let sign = if n - 1 < 0 { '-' } else { '+' };
        format!("{out}e{sign}{}", (n - 1).abs())
    };
    if value < 0.0 {
        format!("-{out}")
    } else {
        out
    }
}

/// The text that JSON.stringify gives a string.
pub(crate) fn js_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// JSON.stringify of a value; a missing value is `undefined`.
pub(crate) fn stringify(value: Option<&Json>) -> String {
    match value {
        None => "undefined".into(),
        Some(Json::Null) => "null".into(),
        Some(Json::Bool(v)) => v.to_string(),
        Some(Json::Number(v)) => js_number(*v),
        Some(Json::String(v)) => js_string(v),
        Some(Json::Array(items)) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| stringify(Some(item)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Some(Json::Object(members)) => format!("{{{}}}", distinct(members).join(",")),
    }
}

/// The members `"name":value` of an object: a repeated name is one member at the position of its first appearance with its last value.
fn distinct(members: &[(String, Json)]) -> Vec<String> {
    let mut seen: Vec<&str> = vec![];
    let mut parts = vec![];
    for (name, _) in members {
        if seen.contains(&name.as_str()) {
            continue;
        }
        seen.push(name);
        parts.push(format!(
            "{}:{}",
            js_string(name),
            stringify(get(members, name))
        ));
    }
    parts
}

/// One line of an event file.
pub(crate) struct Row {
    ts_us: i64,
    level: String,
    layer: String,
    name: String,
    window: Option<String>,
    surface: Option<String>,
    session: Option<String>,
    cids: Option<Vec<String>>,
    fields: Vec<(String, Json)>,
}

fn integer(value: Option<&Json>) -> Option<i64> {
    match value {
        Some(Json::Number(v)) if v.is_finite() && v.fract() == 0.0 => Some(*v as i64),
        _ => None,
    }
}

/// Reads one event line into a row, or fails with an error that names the file and the line.
pub(crate) fn row_of(file: &str, number: usize, raw: &str) -> Result<Row, String> {
    let where_ = format!("{file}:{number}");
    let parsed: Json =
        serde_json::from_str(raw).map_err(|_| format!("{where_}: not JSON: {raw}"))?;
    let Json::Object(event) = parsed else {
        return Err(format!("{where_}: not an event object: {raw}"));
    };
    let mut numbers = [0i64; 2];
    for (index, name) in ["ts_us", "seq"].iter().enumerate() {
        numbers[index] = integer(get(&event, name)).ok_or_else(|| {
            format!(
                "{where_}: {name} must be an integer, found {}",
                stringify(get(&event, name))
            )
        })?;
    }
    let one_of = |name: &str, allowed: &[&str]| -> Result<String, String> {
        match get(&event, name) {
            Some(Json::String(text)) if allowed.contains(&text.as_str()) => Ok(text.clone()),
            other => Err(format!(
                "{where_}: {name} {} is not one of {}",
                stringify(other),
                allowed.join(", ")
            )),
        }
    };
    let level = one_of("level", &LEVELS)?;
    let layer = one_of("layer", &LAYERS)?;
    match get(&event, "class") {
        None => {}
        Some(Json::String(text)) if CLASSES.contains(&text.as_str()) => {}
        other => {
            return Err(format!(
                "{where_}: class {} is not one of {}",
                stringify(other),
                CLASSES.join(", ")
            ))
        }
    };
    let name = match get(&event, "event") {
        Some(Json::String(text)) => text.clone(),
        other => {
            return Err(format!(
                "{where_}: event must be a string, found {}",
                stringify(other)
            ))
        }
    };
    let fields = match get(&event, "fields") {
        None => vec![],
        Some(Json::Object(members)) => members
            .iter()
            .map(|(n, v)| (n.clone(), clone_json(v)))
            .collect(),
        other => {
            return Err(format!(
                "{where_}: fields must be an object, found {}",
                stringify(other)
            ))
        }
    };
    let identifier = |name: &str| -> Result<Option<String>, String> {
        match get(&event, name) {
            None => Ok(None),
            Some(Json::String(text)) => Ok(Some(text.clone())),
            other => Err(format!(
                "{where_}: {name} must be a string, found {}",
                stringify(other)
            )),
        }
    };
    let cids = match get(&event, "cids") {
        None => None,
        Some(Json::Array(items)) if items.is_empty() => None,
        Some(Json::Array(items)) if items.iter().all(|item| matches!(item, Json::String(_))) => {
            Some(
                items
                    .iter()
                    .map(|item| match item {
                        Json::String(text) => text.clone(),
                        _ => unreachable!("checked above"),
                    })
                    .collect(),
            )
        }
        other => {
            return Err(format!(
                "{where_}: cids must be an array of strings, found {}",
                stringify(other)
            ))
        }
    };
    Ok(Row {
        ts_us: numbers[0],
        level,
        layer,
        name,
        window: identifier("window")?,
        surface: identifier("surface")?,
        session: identifier("session")?,
        cids,
        fields,
    })
}

fn clone_json(value: &Json) -> Json {
    match value {
        Json::Null => Json::Null,
        Json::Bool(v) => Json::Bool(*v),
        Json::Number(v) => Json::Number(*v),
        Json::String(v) => Json::String(v.clone()),
        Json::Array(items) => Json::Array(items.iter().map(clone_json).collect()),
        Json::Object(members) => Json::Object(
            members
                .iter()
                .map(|(n, v)| (n.clone(), clone_json(v)))
                .collect(),
        ),
    }
}

/// The days from 1970-01-01 of a civil date (proleptic Gregorian calendar).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

/// The civil date (year, month, day) of the days from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719468;
    let era = days.div_euclid(146097);
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

/// The time of a row as UTC text with microseconds.
fn time_text(ts_us: i64) -> String {
    let seconds = ts_us.div_euclid(1_000_000);
    let micros = ts_us.rem_euclid(1_000_000);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86400));
    let of_day = seconds.rem_euclid(86400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{micros:06}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// One row as one text line: time, level, layer, event, identifiers, then the fields as `name=value`.
pub(crate) fn event_line(row: &Row) -> String {
    let mut parts = vec![
        time_text(row.ts_us),
        row.level.clone(),
        row.layer.clone(),
        row.name.clone(),
    ];
    for (name, value) in [
        ("window", &row.window),
        ("surface", &row.surface),
        ("session", &row.session),
    ] {
        if let Some(value) = value {
            parts.push(format!("{name}={value}"));
        }
    }
    if let Some(cids) = &row.cids {
        parts.push(format!("cids={}", cids.join(",")));
    }
    let mut seen: Vec<&str> = vec![];
    for (name, _) in &row.fields {
        if seen.contains(&name.as_str()) {
            continue;
        }
        seen.push(name);
        parts.push(format!("{name}={}", stringify(get(&row.fields, name))));
    }
    parts.join(" ")
}

/// The schema number of a `log.open` line.
pub(crate) fn schema_of(name: &str, raw: &str) -> Result<i64, String> {
    let row = row_of(name, 1, raw)?;
    let schema = get(&row.fields, "schema");
    integer(schema).ok_or_else(|| {
        let shown = match schema {
            None => "undefined".to_string(),
            Some(Json::Number(v)) => js_number(*v),
            other => stringify(other),
        };
        format!("{name}: schema {shown} is not 2")
    })
}

/// The microseconds of a UTC time given to `--from` and `--to`.
fn time_bound(name: &str, value: &str) -> Result<i64, String> {
    let invalid = || {
        format!(
            "log query {name} {} is not a UTC time like 2026-10-08T22:53:20.123456Z",
            js_string(value)
        )
    };
    let bytes = value.as_bytes();
    let digits = |from: usize, to: usize| -> Option<i64> {
        let part = value.get(from..to)?;
        if part.bytes().all(|b| b.is_ascii_digit()) {
            // default: a non-numeric part gives None, which the caller reports as the invalid time error.
            part.parse().ok()
        } else {
            None
        }
    };
    let punctuation = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if bytes.len() < 20 || punctuation.iter().any(|(at, c)| bytes[*at] != *c) || !value.is_ascii() {
        return Err(invalid());
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(0, 4),
        digits(5, 7),
        digits(8, 10),
        digits(11, 13),
        digits(14, 16),
        digits(17, 19),
    ) else {
        return Err(invalid());
    };
    let rest = &value[19..];
    let fraction = match rest.strip_suffix('Z') {
        Some("") => 0,
        Some(tail)
            if tail.starts_with('.')
                && (2..=7).contains(&tail.len())
                && tail[1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            format!("{:0<6}", &tail[1..])
                .parse::<i64>()
                .map_err(|_| invalid())?
        }
        _ => return Err(invalid()),
    };
    // A date that the calendar does not have (for example February 30) moves to another day.
    let days = days_from_civil(year, month, day);
    if !(1..=12).contains(&month)
        || civil_from_days(days) != (year, month, day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(invalid());
    }
    Ok(((days * 86400 + hour * 3600 + minute * 60 + second) * 1_000_000) + fraction)
}

/// The value of `--after`: `<ts_us>/<role>/<boot>/<seq>`. A text of another form is given on as it is, so the query refuses it with its own
/// words.
fn after_flag(value: &str) -> serde_json::Value {
    let parts: Vec<&str> = value.split('/').collect();
    if let [ts, role, boot, seq] = parts[..] {
        if let (Ok(ts), Ok(seq)) = (ts.parse::<i64>(), seq.parse::<i64>()) {
            return serde_json::json!({"ts_us": ts, "role": role, "boot": boot, "seq": seq});
        }
    }
    serde_json::Value::String(value.to_string())
}

/// Runs `sok debug query`.
pub(crate) fn run_debug(
    a: &Arguments,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let view = a.positional(1, "debug view")?;
    if view != "query" {
        return Err(Error::Usage(format!("unknown command: debug {view}")));
    }
    if let Some(extra) = a.positionals.get(2) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    let mut params = serde_json::Map::new();
    for (flag, name) in [
        ("channel", "channel"),
        ("level", "level"),
        ("class", "class"),
        ("layer", "layer"),
        ("event", "event"),
        ("event-prefix", "event_prefix"),
        ("surface", "surface"),
        ("session", "session"),
        ("cid", "cid"),
        ("run", "run"),
        ("text", "text"),
        ("order", "order"),
    ] {
        if let Some(value) = a.values.get(flag) {
            params.insert(name.to_string(), serde_json::Value::String(value.clone()));
        }
    }
    if let Some(value) = a.values.get("limit") {
        match value.parse::<i64>() {
            Ok(n) => params.insert("limit".to_string(), serde_json::json!(n)),
            Err(_) => params.insert(
                "limit".to_string(),
                serde_json::Value::String(value.clone()),
            ),
        };
    }
    for (flag, name) in [("from", "from_us"), ("to", "to_us")] {
        if let Some(value) = a.values.get(flag) {
            let bound = time_bound(flag, value).map_err(Error::Usage)?;
            params.insert(name.to_string(), serde_json::json!(bound));
        }
    }
    if let Some(value) = a.values.get("after") {
        params.insert("after".to_string(), after_flag(value));
    }
    if let Some(value) = a.values.get("around") {
        params.insert("around".to_string(), after_flag(value));
    }
    for flag in ["earlier", "later"] {
        if let Some(value) = a.values.get(flag) {
            match value.parse::<i64>() {
                Ok(n) => params.insert(flag.to_string(), serde_json::json!(n)),
                Err(_) => params.insert(flag.to_string(), serde_json::Value::String(value.clone())),
            };
        }
    }
    let query =
        parse_log_query(&serde_json::Value::Object(params).to_string()).map_err(Error::Usage)?;
    let config_dir = config_dir_of(&a.values, options)?;
    let page = query_logs(&config_dir, &query, None)?;
    let mut out = String::new();
    for row in &page.rows {
        out.push_str(&log_row_line(row)?);
        out.push('\n');
    }
    stdout
        .write_all(out.as_bytes())
        .map_err(|error| Error::Failed(error.to_string()))?;
    if let Some(next) = &page.next {
        writeln!(stderr, "more: --after {}", format_log_cursor(next))
            .map_err(|error| Error::Failed(error.to_string()))?;
    }
    Ok(())
}
