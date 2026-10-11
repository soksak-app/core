//! The query over the event files of a configuration directory (docs/spec/logging.md#query). It reads the files through their indexes and
//! answers one page. The Go implementation (packages/sok/wailsv3/src/log_query.go) gives the same page, cursor and error text for the same
//! files and parameters.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::debug::{self, Json};
use crate::files::file_error;
pub use crate::log_index::IndexUpdate;
use crate::log_index::{
    bloom_has, open_log, read_range, scan_line, OpenedLog, ScannedLine, Segment, BLOOM_CIDS,
    BLOOM_EVENT, BLOOM_RUN, BLOOM_SESSION, BLOOM_SHAPES, BLOOM_SURFACE, CLASSES, LAYERS, LEVELS,
    SEGMENT_EVENTS,
};

const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: i64 = 5000;
/// The most rows before and the most rows after the row of an around query, and their default.
const MAX_AROUND: i64 = 500;
const DEFAULT_AROUND: usize = 5;
/// The bound of the line text of the rows of one page; the first row is always taken.
const PAGE_BYTES: usize = 8388608;
const CHANNELS: [&str; 3] = ["other", "debug", "all"];
const ORDERS: [&str; 2] = ["asc", "desc"];
/// The parameters of a query in the order that they are checked.
const MEMBERS: [&str; 20] = [
    "channel",
    "level",
    "class",
    "layer",
    "event",
    "event_prefix",
    "surface",
    "session",
    "cid",
    "run",
    "text",
    "from_us",
    "to_us",
    "limit",
    "order",
    "after",
    "since",
    "around",
    "earlier",
    "later",
];

/// The key of a row: the position that a page continues after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogCursor {
    pub ts_us: i64,
    pub role: String,
    pub boot: String,
    pub seq: i64,
}

impl LogCursor {
    /// Orders the keys of two rows.
    fn less(&self, other: &LogCursor) -> bool {
        (self.ts_us, &self.role, &self.boot, self.seq)
            < (other.ts_us, &other.role, &other.boot, other.seq)
    }
}

/// A query with its defaults applied.
#[derive(Debug, Clone, Default)]
pub struct LogQuery {
    pub channel: String,
    pub level: String,
    pub class: String,
    pub layer: String,
    pub event: String,
    pub event_prefix: String,
    pub surface: String,
    pub session: String,
    pub cid: String,
    pub run: String,
    pub text: String,
    pub order: String,
    pub from_us: Option<i64>,
    pub to_us: Option<i64>,
    pub limit: usize,
    pub after: Option<LogCursor>,
    pub since: Option<BTreeMap<String, i64>>,
    /// The key of the row whose neighbours the query returns, with `earlier` rows before it and `later` rows after it.
    pub around: Option<LogCursor>,
    pub earlier: usize,
    pub later: usize,
    /// The bound of the line text of the rows of the page; zero is `PAGE_BYTES`.
    page_bytes: usize,
}

fn query_error(message: impl AsRef<str>) -> String {
    format!("log query {}", message.as_ref())
}

fn json_get<'a>(members: &'a [(String, Json)], name: &str) -> Option<&'a Json> {
    members
        .iter()
        .rev()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v)
}

fn integer_of(value: Option<&Json>) -> Option<i64> {
    match value {
        Some(Json::Number(v)) if v.is_finite() && v.fract() == 0.0 => Some(*v as i64),
        _ => None,
    }
}

/// Reads the parameters of a query: one JSON object.
pub fn parse_log_query(params: &str) -> Result<LogQuery, String> {
    let value: Json = serde_json::from_str(params).map_err(|_| {
        query_error(format!(
            "parameters must be a JSON object, found {}",
            params.trim()
        ))
    })?;
    let Json::Object(object) = value else {
        return Err(query_error(format!(
            "parameters must be an object, found {}",
            debug::stringify(Some(&value))
        )));
    };
    let mut unknown: Vec<&str> = vec![];
    for (name, _) in &object {
        if !MEMBERS.contains(&name.as_str()) && !unknown.contains(&name.as_str()) {
            unknown.push(name);
        }
    }
    if !unknown.is_empty() {
        unknown.sort();
        return Err(query_error(format!("has no parameter {}", unknown[0])));
    }
    let mut query = LogQuery {
        channel: "other".into(),
        level: "trace".into(),
        order: "asc".into(),
        limit: DEFAULT_LIMIT,
        ..LogQuery::default()
    };
    let choice = |name: &str, options: &[&str]| -> Result<Option<String>, String> {
        match json_get(&object, name) {
            None => Ok(None),
            Some(Json::String(text)) if options.contains(&text.as_str()) => Ok(Some(text.clone())),
            other => Err(query_error(format!(
                "{name} {} is not one of {}",
                debug::stringify(other),
                options.join(", ")
            ))),
        }
    };
    let text = |name: &str| -> Result<Option<String>, String> {
        match json_get(&object, name) {
            None => Ok(None),
            Some(Json::String(text)) if !text.is_empty() => Ok(Some(text.clone())),
            other => Err(query_error(format!(
                "{name} must be a non-empty string, found {}",
                debug::stringify(other)
            ))),
        }
    };
    let bound = |name: &str| -> Result<Option<i64>, String> {
        match json_get(&object, name) {
            None => Ok(None),
            Some(value) => match integer_of(Some(value)) {
                Some(n) if n >= 0 => Ok(Some(n)),
                _ => Err(query_error(format!(
                    "{name} must be a non-negative integer, found {}",
                    debug::stringify(Some(value))
                ))),
            },
        }
    };
    if let Some(value) = choice("channel", &CHANNELS)? {
        query.channel = value;
    }
    if let Some(value) = choice("level", &LEVELS)? {
        query.level = value;
    }
    query.class = choice("class", &CLASSES)?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.layer = choice("layer", &LAYERS)?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.event = text("event")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.event_prefix = text("event_prefix")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.surface = text("surface")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.session = text("session")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.cid = text("cid")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.run = text("run")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.text = text("text")?.unwrap_or_default(); // default: a member that is not given leaves the query open.
    query.from_us = bound("from_us")?;
    query.to_us = bound("to_us")?;
    if let Some(value) = json_get(&object, "limit") {
        match integer_of(Some(value)) {
            Some(n) if (1..=MAX_LIMIT).contains(&n) => query.limit = n as usize,
            _ => {
                return Err(query_error(format!(
                    "limit must be an integer from 1 to {MAX_LIMIT}, found {}",
                    debug::stringify(Some(value))
                )))
            }
        }
    }
    if let Some(value) = choice("order", &ORDERS)? {
        query.order = value;
    }
    if let Some(value) = json_get(&object, "after") {
        query.after = Some(cursor_of(value).ok_or_else(|| {
            query_error(format!(
                "after must be {{ts_us, role, boot, seq}}, found {}",
                debug::stringify(Some(value))
            ))
        })?);
    }
    if let Some(value) = json_get(&object, "since") {
        let invalid = || {
            query_error(format!(
                "since must map process names to integers, found {}",
                debug::stringify(Some(value))
            ))
        };
        let Json::Object(entries) = value else {
            return Err(invalid());
        };
        let mut since = BTreeMap::new();
        for (name, entry) in entries {
            since.insert(name.clone(), integer_of(Some(entry)).ok_or_else(invalid)?);
        }
        query.since = Some(since);
    }
    if let Some(value) = json_get(&object, "around") {
        query.around = Some(cursor_of(value).ok_or_else(|| {
            query_error(format!(
                "around must be {{ts_us, role, boot, seq}}, found {}",
                debug::stringify(Some(value))
            ))
        })?);
    }
    for (name, to) in [("earlier", &mut query.earlier), ("later", &mut query.later)] {
        let value = json_get(&object, name);
        if query.around.is_none() {
            if value.is_some() {
                return Err(query_error(format!("{name} needs around")));
            }
            continue;
        }
        *to = DEFAULT_AROUND;
        if let Some(value) = value {
            match integer_of(Some(value)) {
                Some(n) if (0..=MAX_AROUND).contains(&n) => *to = n as usize,
                _ => {
                    return Err(query_error(format!(
                        "{name} must be an integer from 0 to {MAX_AROUND}, found {}",
                        debug::stringify(Some(value))
                    )))
                }
            }
        }
    }
    if query.around.is_some() {
        for name in MEMBERS {
            if json_get(&object, name).is_some()
                && !["channel", "around", "earlier", "later"].contains(&name)
            {
                return Err(query_error(format!(
                    "around takes only channel, earlier and later, not {name}"
                )));
            }
        }
    }
    if let (Some(from), Some(to)) = (query.from_us, query.to_us) {
        if from > to {
            return Err(query_error(format!(
                "from_us is later than to_us: {from} {to}"
            )));
        }
    }
    if !query.event.is_empty() && !query.event_prefix.is_empty() {
        return Err(query_error("takes event or event_prefix, not both"));
    }
    if query.event_prefix.ends_with('.') {
        return Err(query_error(format!(
            "event_prefix {} must not end with a dot",
            debug::js_string(&query.event_prefix)
        )));
    }
    Ok(query)
}

/// Reads a cursor: an object of exactly ts_us, role, boot and seq.
fn cursor_of(value: &Json) -> Option<LogCursor> {
    let Json::Object(object) = value else {
        return None;
    };
    if object.len() != 4 {
        return None;
    }
    let ts_us = integer_of(json_get(object, "ts_us"))?;
    let seq = integer_of(json_get(object, "seq"))?;
    let (Some(Json::String(role)), Some(Json::String(boot))) =
        (json_get(object, "role"), json_get(object, "boot"))
    else {
        return None;
    };
    if role.is_empty() || boot.is_empty() {
        return None;
    }
    Some(LogCursor {
        ts_us,
        role: role.clone(),
        boot: boot.clone(),
        seq,
    })
}

/// One row of a page.
#[derive(Debug, Serialize)]
pub struct LogRow {
    pub role: String,
    pub boot: String,
    pub file: String,
    pub offset: i64,
    pub event: Box<RawValue>,
    /// Set by an around query: true for a neighbour, false for the row at the cursor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<bool>,
}

/// How much of the files a query looked at.
#[derive(Debug, Default, Serialize)]
pub struct LogScanned {
    pub logs: usize,
    pub segments: usize,
    pub read: usize,
    pub lines: usize,
    pub rebuilt: usize,
}

/// The answer of a query.
#[derive(Debug, Serialize)]
pub struct LogPage {
    pub rows: Vec<LogRow>,
    pub next: Option<LogCursor>,
    pub tail: BTreeMap<String, i64>,
    pub scanned: LogScanned,
}

/// An event file of the channel.
struct LogSource {
    role: String,
    boot: String,
    name: String,
    path: PathBuf,
}

impl LogSource {
    fn process(&self) -> String {
        format!("{}-{}", self.role, self.boot)
    }
}

/// Reads the name of an event file: `<role>-<boot>[.debug].jsonl[.<n>]`, with the generation `n` a positive number without a leading zero.
/// Returns the role, the boot and whether it is a debug file.
fn parse_log_name(name: &str) -> Option<(String, String, bool)> {
    let mut stem = name;
    if let Some(at) = stem.rfind('.') {
        let generation = &stem[at + 1..];
        let positive = generation.bytes().all(|c| c.is_ascii_digit())
            && generation.bytes().next().is_some_and(|c| c != b'0');
        if positive && stem[..at].ends_with(".jsonl") {
            stem = &stem[..at];
        }
    }
    let mut stem = stem.strip_suffix(".jsonl")?;
    let debug = match stem.strip_suffix(".debug") {
        Some(rest) => {
            stem = rest;
            true
        }
        None => false,
    };
    let (role, boot) = stem.split_once('-')?;
    let mut chars = role.chars();
    let valid_role = chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !valid_role || boot.is_empty() {
        return None;
    }
    Some((role.to_string(), boot.to_string(), debug))
}

/// Lists the event files of the channel under `<config-dir>/logs/` in the order of their names.
fn discover_logs(config_dir: &Path, channel: &str) -> Result<Vec<LogSource>, String> {
    let logs = config_dir.join("logs");
    let entries = std::fs::read_dir(&logs).map_err(|error| file_error(logs.display(), &error))?;
    let mut sources = vec![];
    for entry in entries {
        let entry = entry.map_err(|error| file_error(logs.display(), &error))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((role, boot, debug)) = parse_log_name(&name) else {
            continue;
        };
        let is_dir = entry
            .file_type()
            .map_err(|error| file_error(logs.display(), &error))?
            .is_dir();
        if is_dir || (channel == "other" && debug) || (channel == "debug" && !debug) {
            continue;
        }
        sources.push(LogSource {
            role,
            boot,
            name: format!("logs/{name}"),
            path: logs.join(&name),
        });
    }
    sources.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(sources)
}

/// A query with the values that its tests use.
struct QueryPlan<'a> {
    query: &'a LogQuery,
    level_mask: u8,
    layer_bit: Option<u8>,
    class_bit: Option<u8>,
    low: i64,
    high: i64,
    needle: Vec<u8>,
    /// Values that a line holds in the same bytes when it holds them at all, so a line without them is not parsed.
    literals: Vec<Vec<u8>>,
}

/// The bytes of a value that JSON writes as they are: printable ASCII without a quote, a backslash and the characters that a Go writer
/// escapes (<, > and &). `None` for another value or an empty one.
fn plain_literal(value: &str) -> Option<Vec<u8>> {
    if value.is_empty()
        || value
            .bytes()
            .any(|c| !(0x20..=0x7e).contains(&c) || matches!(c, b'"' | b'\\' | b'<' | b'>' | b'&'))
    {
        return None;
    }
    Some(value.as_bytes().to_vec())
}

/// Whether `hay` holds `needle`, which is already in lower case, comparing ASCII letters without case.
fn contains_fold(hay: &[u8], needle: &[u8]) -> bool {
    let n = needle.len();
    if n == 0 {
        return true;
    }
    if hay.len() < n {
        return false;
    }
    let (lower, upper) = (needle[0], needle[0].to_ascii_uppercase());
    let last = hay.len() - n;
    let mut from = 0;
    while from <= last {
        let found = if lower == upper {
            memchr::memchr(lower, &hay[from..=last])
        } else {
            memchr::memchr2(lower, upper, &hay[from..=last])
        };
        let Some(offset) = found else { return false };
        let at = from + offset;
        if hay[at..at + n]
            .iter()
            .zip(needle)
            .all(|(c, want)| c.to_ascii_lowercase() == *want)
        {
            return true;
        }
        from = at + 1;
    }
    false
}

fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || memchr::memmem::find(hay, needle).is_some()
}

impl<'a> QueryPlan<'a> {
    fn new(query: &'a LogQuery) -> Self {
        let level = LEVELS
            .iter()
            .position(|item| *item == query.level)
            .expect("the level was checked");
        let bit_of = |list: &[&str], value: &str| -> Option<u8> {
            if value.is_empty() {
                None
            } else {
                list.iter()
                    .position(|item| *item == value)
                    .map(|index| 1u8 << index)
            }
        };
        let literals = [
            &query.event,
            &query.event_prefix,
            &query.surface,
            &query.session,
            &query.cid,
        ]
        .into_iter()
        .filter_map(|value| plain_literal(value))
        .collect();
        QueryPlan {
            query,
            level_mask: ((1u16 << (level + 1)) - 1) as u8,
            layer_bit: bit_of(&LAYERS, &query.layer),
            class_bit: bit_of(&CLASSES, &query.class),
            low: query.from_us.unwrap_or(i64::MIN), // default: a query without a lower bound leaves the time open.
            high: query.to_us.unwrap_or(i64::MAX), // default: a query without an upper bound leaves the time open.
            needle: query.text.to_ascii_lowercase().into_bytes(),
            literals,
        }
    }

    /// Whether the record can hold a row of the plan.
    fn admits(&self, s: &Segment, process: &str, ascending: bool) -> bool {
        if s.max_ts < self.low || s.min_ts > self.high {
            return false;
        }
        if s.levels & self.level_mask == 0
            || self.layer_bit.is_some_and(|bit| s.layers & bit == 0)
            || self.class_bit.is_some_and(|bit| s.classes & bit == 0)
        {
            return false;
        }
        if let Some(cursor) = &self.query.after {
            if (ascending && s.max_ts < cursor.ts_us) || (!ascending && s.min_ts > cursor.ts_us) {
                return false;
            }
        }
        if let Some(limit) = self
            .query
            .since
            .as_ref()
            .and_then(|since| since.get(process))
        {
            if (s.last_seq as i64) <= *limit {
                return false;
            }
        }
        let q = self.query;
        let has = |kind: usize, item: &str| bloom_has(s.filter(kind), BLOOM_SHAPES[kind].1, item);
        !((!q.event.is_empty() && !has(BLOOM_EVENT, &q.event))
            || (!q.event_prefix.is_empty() && !has(BLOOM_EVENT, &q.event_prefix))
            || (!q.surface.is_empty() && !has(BLOOM_SURFACE, &q.surface))
            || (!q.session.is_empty() && !has(BLOOM_SESSION, &q.session))
            || (!q.cid.is_empty() && !has(BLOOM_CIDS, &q.cid)))
    }

    /// Whether a line can be a row of the plan without parsing it: it holds the text and the literal values.
    fn prefilter(&self, raw: &[u8]) -> bool {
        (self.needle.is_empty() || contains_fold(raw, &self.needle))
            && self
                .literals
                .iter()
                .all(|literal| contains_bytes(raw, literal))
    }

    /// Whether a line is a row of the plan; the cursor and the bounds of the run are applied by the caller.
    fn matches(&self, line: &ScannedLine, process: &str) -> bool {
        let q = self.query;
        if let Some(limit) = q.since.as_ref().and_then(|since| since.get(process)) {
            if line.seq <= *limit {
                return false;
            }
        }
        if line.ts_us < self.low
            || line.ts_us > self.high
            || (1u8 << line.level) & self.level_mask == 0
        {
            return false;
        }
        if self
            .layer_bit
            .is_some_and(|bit| (1u8 << line.layer) & bit == 0)
        {
            return false;
        }
        if self
            .class_bit
            .is_some_and(|bit| line.class.is_none_or(|class| (1u8 << class) & bit == 0))
        {
            return false;
        }
        (q.event.is_empty() || line.event == q.event)
            && (q.event_prefix.is_empty()
                || line.event == q.event_prefix
                || line
                    .event
                    .strip_prefix(q.event_prefix.as_str())
                    .is_some_and(|rest| rest.starts_with('.')))
            && (q.surface.is_empty() || line.surface == q.surface)
            && (q.session.is_empty() || line.session == q.session)
            && (q.cid.is_empty() || line.cids.contains(&q.cid))
    }
}

struct Candidate {
    log: usize,
    number: usize,
    segment: Segment,
}

struct Entry {
    key: LogCursor,
    row: LogRow,
    size: usize,
}

/// Answers a query over the event files of the configuration directory. `indexed`, when it is given, is called for each index that the
/// query had to update.
pub fn query_logs(
    config_dir: &Path,
    query: &LogQuery,
    indexed: Option<&mut dyn FnMut(&IndexUpdate)>,
) -> Result<LogPage, String> {
    match &query.around {
        Some(cursor) => query_around(config_dir, query, cursor, indexed),
        None => query_page(config_dir, query, indexed),
    }
}

/// Answers a query that is not an around query.
fn query_page(
    config_dir: &Path,
    query: &LogQuery,
    mut indexed: Option<&mut dyn FnMut(&IndexUpdate)>,
) -> Result<LogPage, String> {
    let sources = discover_logs(config_dir, &query.channel)?;
    let mut page = LogPage {
        rows: vec![],
        next: None,
        tail: BTreeMap::new(),
        scanned: LogScanned::default(),
    };
    let mut logs: Vec<(LogSource, OpenedLog)> = vec![];
    for source in sources {
        let opened = open_log(&source.path)?;
        if opened.update.changed {
            if let Some(callback) = indexed.as_mut() {
                callback(&opened.update);
            }
        }
        if opened.update.rebuilt {
            page.scanned.rebuilt += 1;
        }
        page.scanned.logs += 1;
        page.scanned.segments += opened.index.segments();
        if opened.index.state.events > 0 {
            let last = opened.index.state.last_seq as i64;
            let entry = page.tail.entry(source.process()).or_insert(last);
            *entry = (*entry).max(last);
        }
        logs.push((source, opened));
    }
    let mut plan = QueryPlan::new(query);
    if !query.run.is_empty() {
        let (low, high) = resolve_run(&logs, &query.run, &mut page.scanned)?;
        plan.low = plan.low.max(low);
        plan.high = plan.high.min(high);
    }
    let ascending = query.order == "asc";
    let mut candidates = vec![];
    for (index, (source, opened)) in logs.iter().enumerate() {
        for number in 0..opened.index.segments() {
            let segment = opened.index.segment_at(number)?;
            if plan.admits(&segment, &source.process(), ascending) {
                candidates.push(Candidate {
                    log: index,
                    number,
                    segment,
                });
            }
        }
    }
    if ascending {
        candidates.sort_by_key(|candidate| candidate.segment.min_ts);
    } else {
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.segment.max_ts));
    }
    let before = |a: &LogCursor, b: &LogCursor| if ascending { a.less(b) } else { b.less(a) };
    let mut best: Vec<Entry> = vec![];
    for candidate in &candidates {
        if best.len() == query.limit + 1 {
            let last = best[best.len() - 1].key.ts_us;
            if (ascending && candidate.segment.min_ts > last)
                || (!ascending && candidate.segment.max_ts < last)
            {
                break;
            }
        }
        let (source, opened) = &logs[candidate.log];
        let data = read_range(
            &opened.source,
            candidate.segment.offset,
            candidate.segment.length as usize,
        )
        .map_err(|error| file_error(&source.name, &error))?;
        page.scanned.read += 1;
        let process = source.process();
        let mut offset = candidate.segment.offset as i64;
        let mut number = candidate.number * SEGMENT_EVENTS as usize + 1;
        let mut rest = &data[..];
        while !rest.is_empty() {
            let Some(end) = memchr::memchr(b'\n', rest) else {
                return Err(format!(
                    "{}: segment {} does not end with a line feed",
                    source.name, candidate.number
                ));
            };
            let raw = &rest[..end];
            rest = &rest[end + 1..];
            let line_offset = offset;
            offset += end as i64 + 1;
            page.scanned.lines += 1;
            number += 1;
            if !plan.prefilter(raw) {
                continue;
            }
            let line = scan_line(&source.name, number - 1, raw)?;
            if !plan.matches(&line, &process) {
                continue;
            }
            let key = LogCursor {
                ts_us: line.ts_us,
                role: source.role.clone(),
                boot: source.boot.clone(),
                seq: line.seq,
            };
            if query
                .after
                .as_ref()
                .is_some_and(|cursor| !before(cursor, &key))
            {
                continue;
            }
            if best.len() == query.limit + 1 && !before(&key, &best[best.len() - 1].key) {
                continue;
            }
            let at = best.partition_point(|entry| !before(&key, &entry.key));
            let event = RawValue::from_string(String::from_utf8_lossy(raw).into_owned())
                .map_err(|error| format!("{}: {error}", source.name))?;
            let row = LogRow {
                role: key.role.clone(),
                boot: key.boot.clone(),
                file: source.name.clone(),
                offset: line_offset,
                event,
                context: None,
            };
            best.insert(
                at,
                Entry {
                    key,
                    row,
                    size: raw.len(),
                },
            );
            best.truncate(query.limit + 1);
        }
    }
    let budget = if query.page_bytes > 0 {
        query.page_bytes
    } else {
        PAGE_BYTES
    };
    let total = best.len();
    let mut used = 0;
    let mut taken = 0;
    let mut last_key = None;
    for entry in best {
        if taken >= query.limit || (taken > 0 && used + entry.size > budget) {
            break;
        }
        used += entry.size;
        taken += 1;
        last_key = Some(entry.key.clone());
        page.rows.push(entry.row);
    }
    if taken < total {
        page.next = last_key;
    }
    Ok(page)
}

/// The key of a row.
fn row_key(row: &LogRow) -> Result<LogCursor, String> {
    #[derive(Deserialize)]
    struct Key {
        ts_us: i64,
        seq: i64,
    }
    let key: Key =
        serde_json::from_str(row.event.get()).map_err(|error| format!("{}: {error}", row.file))?;
    Ok(LogCursor {
        ts_us: key.ts_us,
        role: row.role.clone(),
        boot: row.boot.clone(),
        seq: key.seq,
    })
}

/// Answers an around query: the row at the cursor and the rows before and after it in the key order of the channel, without a filter,
/// oldest first. The line text of the rows is bounded like a page: the row at the cursor is taken first, the rows before it may use half
/// of the bytes that are left, and the rows after it use the rest; the first row of each part is always taken. `logs`, `segments` and
/// `rebuilt` of the answer are those of the first read, `read` and `lines` are the sums of the reads.
fn query_around(
    config_dir: &Path,
    query: &LogQuery,
    cursor: &LogCursor,
    mut indexed: Option<&mut dyn FnMut(&IndexUpdate)>,
) -> Result<LogPage, String> {
    let mut forward = |update: &IndexUpdate| {
        if let Some(callback) = indexed.as_mut() {
            callback(update);
        }
    };
    let mut read = |order: &str, after: &LogCursor, limit: usize, page_bytes: usize| {
        let part = LogQuery {
            channel: query.channel.clone(),
            level: "trace".into(),
            order: order.into(),
            limit,
            after: Some(after.clone()),
            page_bytes,
            ..LogQuery::default()
        };
        query_page(config_dir, &part, Some(&mut forward))
    };
    let size = |rows: &[LogRow]| rows.iter().map(|row| row.event.get().len()).sum::<usize>();
    // The row at the cursor is the first row after the key just before it. No row has the least seq, so the cursor with it has no row.
    let mut previous = cursor.clone();
    if previous.seq > i64::MIN {
        previous.seq -= 1;
    }
    let first = read("asc", &previous, 1, PAGE_BYTES)?;
    let mut answer = LogPage {
        rows: vec![],
        next: None,
        tail: first.tail.clone(),
        scanned: LogScanned {
            logs: first.scanned.logs,
            segments: first.scanned.segments,
            read: first.scanned.read,
            lines: first.scanned.lines,
            rebuilt: first.scanned.rebuilt,
        },
    };
    let mut middle = vec![];
    if let [row] = first.rows.as_slice() {
        if row_key(row)? == *cursor {
            middle = first.rows;
            middle[0].context = Some(false);
        }
    }
    let mut used = size(&middle);
    let mut earlier = vec![];
    if query.earlier > 0 {
        let mut page = read("desc", cursor, query.earlier, (PAGE_BYTES - used) / 2)?;
        for row in &mut page.rows {
            row.context = Some(true);
        }
        earlier = page.rows;
        earlier.reverse();
        answer.tail = page.tail;
        answer.scanned.read += page.scanned.read;
        answer.scanned.lines += page.scanned.lines;
    }
    used += size(&earlier);
    let mut later = vec![];
    if query.later > 0 {
        let mut page = read("asc", cursor, query.later, PAGE_BYTES - used)?;
        for row in &mut page.rows {
            row.context = Some(true);
        }
        later = page.rows;
        answer.tail = page.tail;
        answer.scanned.read += page.scanned.read;
        answer.scanned.lines += page.scanned.lines;
    }
    answer.rows = earlier.into_iter().chain(middle).chain(later).collect();
    Ok(answer)
}

/// Finds the range of time of a run: from the earliest host.test.start to the latest host.test.end whose fields.run is the identifier, or
/// to the end of the files when the last start has no end after it.
fn resolve_run(
    logs: &[(LogSource, OpenedLog)],
    run: &str,
    scanned: &mut LogScanned,
) -> Result<(i64, i64), String> {
    let (mut low, mut last_start, mut last_end) = (i64::MAX, i64::MIN, i64::MIN);
    let mut found = false;
    for (source, opened) in logs {
        for number in 0..opened.index.segments() {
            let segment = opened.index.segment_at(number)?;
            let has = |kind: usize, item: &str| {
                bloom_has(segment.filter(kind), BLOOM_SHAPES[kind].1, item)
            };
            if !has(BLOOM_RUN, run)
                || !(has(BLOOM_EVENT, "host.test.start") || has(BLOOM_EVENT, "host.test.end"))
            {
                continue;
            }
            let data = read_range(&opened.source, segment.offset, segment.length as usize)
                .map_err(|error| file_error(&source.name, &error))?;
            scanned.read += 1;
            let first_line = number * SEGMENT_EVENTS as usize + 1;
            // default: a segment that does not end with a line feed is read as it is.
            let body = data.strip_suffix(b"\n").unwrap_or(&data);
            for (line_number, raw) in (first_line..).zip(body.split(|byte| *byte == b'\n')) {
                let line = scan_line(&source.name, line_number, raw)?;
                scanned.lines += 1;
                if line.run != run {
                    continue;
                }
                match line.event.as_str() {
                    "host.test.start" => {
                        found = true;
                        low = low.min(line.ts_us);
                        last_start = last_start.max(line.ts_us);
                    }
                    "host.test.end" => last_end = last_end.max(line.ts_us),
                    _ => {}
                }
            }
        }
    }
    if !found {
        return Err(query_error(format!(
            "run {} has no host.test.start in the channel",
            debug::js_string(run)
        )));
    }
    if last_end < last_start {
        return Ok((low, i64::MAX));
    }
    Ok((low, last_end))
}

/// The text line of a row: the line of its event, and the line of a row that an around query marks as context is indented by two spaces.
pub fn log_row_line(row: &LogRow) -> Result<String, String> {
    let line = log_line(row.event.get())?;
    Ok(if row.context == Some(true) {
        format!("  {line}")
    } else {
        line
    })
}

/// The text line of an event line of a file: the form that the debug view shows and `sok debug query` prints.
pub fn log_line(event: &str) -> Result<String, String> {
    debug::row_of("event", 1, event).map(|row| debug::event_line(&row))
}

/// The form of a cursor in the flag `--after` and in the note of the next page.
pub fn format_log_cursor(cursor: &LogCursor) -> String {
    format!(
        "{}/{}/{}/{}",
        cursor.ts_us, cursor.role, cursor.boot, cursor.seq
    )
}
