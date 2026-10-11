//! `sok debug timeline` (docs/spec/debug.md#timeline-command): the rows, the order, the filter and the text lines of the timeline of
//! the debug view (packages/workbench/debug-timeline.js), read from the host event files of the configuration directory.

use std::fmt;
use std::io::Write;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

use crate::files::file_error;
use crate::{config_dir_of, Arguments, Error, Options};

const EVENT_SCHEMA: f64 = 2.0;
const LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];
const LAYERS: [&str; 5] = ["native", "host", "page", "plugin", "sidecar"];

/// A JSON value whose object members keep the order of the text, which the text line of a row keeps.
enum Json {
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
fn js_string(value: &str) -> String {
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
fn stringify(value: Option<&Json>) -> String {
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
struct Row {
    file: String,
    ts_us: i64,
    seq: i64,
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
fn row_of(file: &str, number: usize, raw: &str) -> Result<Row, String> {
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
        file: file.to_string(),
        ts_us: numbers[0],
        seq: numbers[1],
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

/// Reads the whole lines of one event file. The first line must be `log.open` with the schema number that this reader knows.
fn parse_events(file: &str, text: &str) -> Result<Vec<Row>, String> {
    // Only whole lines are read: bytes after the last line feed are a line that is not written to its end.
    let whole = match text.rfind('\n') {
        Some(end) => &text[..end],
        None => "",
    };
    let mut rows = vec![];
    // A file without a line is what a process that ended before its first write leaves: it has no row.
    if !text.contains('\n') {
        return Ok(vec![]);
    }
    for (index, raw) in whole.split('\n').enumerate() {
        rows.push(row_of(file, index + 1, raw)?);
    }
    if rows[0].name != "log.open" {
        return Err(format!(
            "{file}: the first line is not log.open: {}",
            js_string(&rows[0].name)
        ));
    }
    let schema = get(&rows[0].fields, "schema");
    if integer(schema).map(|n| n as f64) != Some(EVENT_SCHEMA) {
        let shown = match schema {
            None => "undefined".to_string(),
            Some(Json::Number(v)) => js_number(*v),
            other => stringify(other),
        };
        return Err(format!("{file}: schema {shown} is not 2"));
    }
    Ok(rows)
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
fn event_line(row: &Row) -> String {
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

/// The filter of the timeline; an empty text leaves a member open.
struct Filter {
    level: String,
    layer: String,
    text: String,
    event: String,
    surface: String,
    session: String,
    cid: String,
    from: String,
    to: String,
    context: String,
}

/// The microseconds of a time bound, or None for the empty text that leaves the bound open.
fn bound(name: &str, value: &str) -> Result<Option<i64>, String> {
    if value.is_empty() {
        return Ok(None);
    }
    let invalid = || {
        format!(
            "timeline {name} {} is not a UTC time like 2026-10-08T22:53:20.123456Z or empty",
            js_string(value)
        )
    };
    let bytes = value.as_bytes();
    let digits = |from: usize, to: usize| -> Option<i64> {
        let part = value.get(from..to)?;
        if part.bytes().all(|b| b.is_ascii_digit()) {
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
    Ok(Some(
        ((days * 86400 + hour * 3600 + minute * 60 + second) * 1_000_000) + fraction,
    ))
}

fn context_count(value: &str) -> Result<usize, String> {
    if (1..=4).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit()) {
        Ok(value.parse().expect("digits"))
    } else {
        Err(format!(
            "timeline context must be decimal digits, found {}",
            js_string(value)
        ))
    }
}

/// Whether each row passes the filter.
fn filter_rows(rows: &[Row], filter: &Filter) -> Result<Vec<bool>, String> {
    let least = LEVELS
        .iter()
        .position(|level| *level == filter.level)
        .ok_or_else(|| {
            format!(
                "timeline level {} is not one of {}",
                js_string(&filter.level),
                LEVELS.join(", ")
            )
        })?;
    if filter.layer != "all" && !LAYERS.contains(&filter.layer.as_str()) {
        return Err(format!(
            "timeline layer {} is not one of all, {}",
            js_string(&filter.layer),
            LAYERS.join(", ")
        ));
    }
    context_count(&filter.context)?;
    let first = bound("from", &filter.from)?;
    let last = bound("to", &filter.to)?;
    if let (Some(first), Some(last)) = (first, last) {
        if first > last {
            return Err(format!(
                "timeline from is later than to: {} {}",
                js_string(&filter.from),
                js_string(&filter.to)
            ));
        }
    }
    let needle = filter.text.to_lowercase();
    let name = filter.event.to_lowercase();
    Ok(rows
        .iter()
        .map(|row| {
            LEVELS
                .iter()
                .position(|level| *level == row.level)
                .expect("level checked")
                <= least
                && (filter.layer == "all" || row.layer == filter.layer)
                && (name.is_empty() || row.name.to_lowercase().contains(&name))
                && (filter.surface.is_empty() || row.surface.as_deref() == Some(&filter.surface))
                && (filter.session.is_empty() || row.session.as_deref() == Some(&filter.session))
                && (filter.cid.is_empty()
                    || row
                        .cids
                        .as_ref()
                        .is_some_and(|cids| cids.contains(&filter.cid)))
                && first.is_none_or(|first| row.ts_us >= first)
                && last.is_none_or(|last| row.ts_us <= last)
                && (needle.is_empty() || event_line(row).to_lowercase().contains(&needle))
        })
        .collect())
}

/// The text lines that the timeline shows: the rows that pass the filter with the context rows around them, once, in the order of
/// the rows; a context row is indented by two spaces.
fn timeline_lines(rows: &[Row], filter: &Filter) -> Result<Vec<String>, String> {
    let pass = filter_rows(rows, filter)?;
    let count = context_count(&filter.context)?;
    let mut lines = vec![];
    let mut until: i64 = -1;
    for (index, row) in rows.iter().enumerate() {
        let position = index as i64;
        if pass[index] {
            let from = (until + 1).max(position - count as i64);
            for before in from..position {
                lines.push(format!(
                    "{}{}",
                    if count > 0 { "  " } else { "" },
                    event_line(&rows[before as usize])
                ));
            }
            lines.push(event_line(row));
            until = position + count as i64;
        } else if position <= until {
            lines.push(format!(
                "{}{}",
                if count > 0 { "  " } else { "" },
                event_line(row)
            ));
        }
    }
    Ok(lines)
}

/// Runs `sok debug <view>`.
pub(crate) fn run_debug(
    a: &Arguments,
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let view = a.positional(1, "debug view")?;
    if view != "timeline" {
        return Err(Error::Usage(format!("unknown command: debug {view}")));
    }
    if let Some(extra) = a.positionals.get(2) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    let value = |name: &str, default: &str| {
        a.values
            .get(name)
            .cloned()
            // default: a filter flag that is not given has the default of the filter (docs/spec/debug.md#timeline-command).
            .unwrap_or_else(|| default.to_string())
    };
    let filter = Filter {
        level: value("level", "trace"),
        layer: value("layer", "all"),
        text: value("text", ""),
        event: value("event", ""),
        surface: value("surface", ""),
        session: value("session", ""),
        cid: value("cid", ""),
        from: value("from", ""),
        to: value("to", ""),
        context: value("context", "0"),
    };
    let config_dir = config_dir_of(&a.values, options)?;
    let logs = config_dir.join("logs");
    let entries = std::fs::read_dir(&logs).map_err(|error| file_error(logs.display(), &error))?;
    let mut names = vec![];
    for entry in entries {
        let entry = entry.map_err(|error| file_error(logs.display(), &error))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_file = entry
            .file_type()
            .map_err(|error| file_error(logs.display(), &error))?
            .is_file();
        if is_file && name.starts_with("host-") && name.ends_with(".jsonl") {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Err(Error::Failed(format!(
            "no event file logs/host-<boot>.jsonl in {}",
            logs.display()
        )));
    }
    names.sort();
    let mut rows = vec![];
    for name in names {
        let path = logs.join(&name);
        let text =
            std::fs::read_to_string(&path).map_err(|error| file_error(path.display(), &error))?;
        rows.extend(parse_events(&format!("logs/{name}"), &text)?);
    }
    rows.sort_by(|left, right| {
        left.ts_us
            .cmp(&right.ts_us)
            .then(left.seq.cmp(&right.seq))
            .then(left.file.cmp(&right.file))
    });
    let lines = timeline_lines(&rows, &filter).map_err(Error::Usage)?;
    let mut out = String::new();
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    stdout
        .write_all(out.as_bytes())
        .map_err(|error| Error::Failed(error.to_string()))
}
