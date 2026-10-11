//! The query over the event files (docs/spec/logging.md#query): the golden pages, the cursor, the tail, the run, the refusals and the
//! segments that a query reads. The generated log is checked against a reference that filters every event of the log.

mod log_support;

use std::io::Write;
use std::path::Path;

use log_support::*;
use serde_json::{json, Value};
use soksak_sok::log_query::{log_line, parse_log_query, query_logs, LogPage};

fn run_query(config: &Path, params: &str) -> LogPage {
    let query = parse_log_query(params).unwrap_or_else(|error| panic!("{params}: {error}"));
    query_logs(config, &query, None).unwrap_or_else(|error| panic!("{params}: {error}"))
}

// contract: log.query.answers-the-golden-pages
#[test]
fn query_answers_the_golden_pages() {
    for case in read_cases() {
        let name = case["name"].as_str().expect("name");
        let config = fixture_config("query-golden");
        let page = run_query(&config, &case["params"].to_string());
        let rows: Vec<&str> = case["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| row.as_str().expect("row"))
            .collect();
        assert_eq!(row_ids(&page), rows, "{name}: rows");
        let next = page
            .next
            .as_ref()
            .map(|cursor| serde_json::to_value(cursor).expect("cursor"))
            .unwrap_or(Value::Null);
        assert_eq!(next, case["next"], "{name}: next");
        assert_eq!(
            serde_json::to_value(&page.tail).expect("tail"),
            case["tail"],
            "{name}: tail"
        );
        if let Some(scanned) = case.get("scanned") {
            let got = json!({"files": page.scanned.files, "segments": page.scanned.segments, "read": page.scanned.read, "lines": page.scanned.lines});
            assert_eq!(&got, scanned, "{name}: scanned");
        }
        assert_eq!(
            page.scanned.rebuilt, page.scanned.files,
            "{name}: the indexes that were built for files that had none"
        );
        let lines = case["lines"].as_array().expect("lines");
        for (index, row) in page.rows.iter().enumerate() {
            let line = log_line(row.event.get()).expect("line");
            assert_eq!(
                &line,
                lines[index].as_str().expect("line"),
                "{name}: line {index}"
            );
        }
    }
}

fn sorted_big(events: &[BigEvent]) -> Vec<BigEvent> {
    let mut sorted = events.to_vec();
    sorted.sort_by_key(|event| (event.ts_us, event.seq));
    sorted
}

fn page_through(config: &Path, params: Value) -> Vec<i64> {
    let mut params = params;
    let mut seqs = vec![];
    for pages in 0.. {
        assert!(pages <= 100, "the pages do not end");
        let page = run_query(config, &params.to_string());
        seqs.extend(seqs_of(&page));
        match page.next {
            None => return seqs,
            Some(cursor) => params["after"] = serde_json::to_value(cursor).expect("cursor"),
        }
    }
    unreachable!()
}

// contract: log.query.pages-through-the-cursor
#[test]
fn query_pages_through_the_cursor() {
    let (config, _path, events) = write_big("query-pages");
    let sorted = sorted_big(&events);
    for order in ["asc", "desc"] {
        for limit in [1000, 4096, 5000] {
            let got = page_through(&config, json!({"order": order, "limit": limit}));
            assert_eq!(
                got.len(),
                sorted.len(),
                "{order} {limit}: rows in the pages"
            );
            for (index, event) in sorted.iter().enumerate() {
                let want = if order == "desc" {
                    sorted[sorted.len() - 1 - index].seq
                } else {
                    event.seq
                };
                assert_eq!(got[index], want, "{order} {limit}: row {index}");
            }
        }
    }

    // The page ends before the byte bound of 8,388,608 bytes of lines and always holds one row.
    let heavy = temp_dir("query-heavy");
    let mut text = event_line_small(1) + "\n";
    for seq in 2..=12 {
        text.push_str(&format!(
            "{{\"ts_us\":{},\"mono_ns\":{seq},\"seq\":{seq},\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.x.y\",\"fields\":{{\"text\":\"{}\"}}}}\n",
            1000 + seq,
            "x".repeat(1_000_000)
        ));
    }
    std::fs::write(heavy.join("logs").join("host-h.jsonl"), text).expect("write");
    let page = run_query(&heavy, r#"{"limit": 500}"#);
    assert!(
        page.rows.len() == 9 && page.next.as_ref().is_some_and(|cursor| cursor.seq == 9),
        "a page of lines of about 1,000,000 bytes holds {} rows and next {:?}, want the small first line and 8 of them, and the cursor of seq 9",
        page.rows.len(),
        page.next
    );
    let rest = run_query(
        &heavy,
        r#"{"limit": 500, "after": {"ts_us": 1009, "role": "host", "boot": "h", "seq": 9}}"#,
    );
    assert!(
        rest.rows.len() == 3 && rest.next.is_none(),
        "the page after it holds {} rows and next {:?}, want the 3 rows that remain",
        rest.rows.len(),
        rest.next
    );
    // A line over the bound still makes a page of its own.
    let one = temp_dir("query-one");
    let huge = format!(
        "{}\n{{\"ts_us\":2000,\"mono_ns\":2,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.x.y\",\"fields\":{{\"text\":\"{}\"}}}}\n",
        event_line_small(1),
        "y".repeat(9_000_000)
    );
    std::fs::write(one.join("logs").join("host-h.jsonl"), huge).expect("write");
    let page = run_query(&one, r#"{"order": "desc", "limit": 5}"#);
    assert!(
        page.rows.len() == 1 && page.next.is_some(),
        "a line over the byte bound: {} rows, next {:?}",
        page.rows.len(),
        page.next
    );
}

fn event_line_small(seq: i64) -> String {
    if seq == 1 {
        return r#"{"ts_us":1000,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":2,"pid":1,"role":"host","boot":"a"}}"#.to_string();
    }
    format!(
        r#"{{"ts_us":{},"mono_ns":{seq},"seq":{seq},"level":"debug","layer":"host","event":"host.x.y","fields":{{"n":{seq}}}}}"#,
        1000 + seq
    )
}

// contract: log.query.follows-the-tail-with-since
#[test]
fn query_follows_the_tail_with_since() {
    let config = fixture_config("query-since");
    let first = run_query(&config, r#"{"channel": "all"}"#);
    assert_eq!(
        first.rows.len(),
        18,
        "the first answer holds {} rows",
        first.rows.len()
    );
    // Two lines are appended; the first has a clock that is earlier than rows the first answer held.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(config.join("logs").join("host-b1.jsonl"))
        .expect("append");
    writeln!(
        file,
        r#"{{"ts_us":1791500000500000,"mono_ns":10,"seq":23,"level":"info","layer":"host","event":"host.late","fields":{{}}}}"#
    )
    .expect("write");
    writeln!(
        file,
        r#"{{"ts_us":1791500009000000,"mono_ns":11,"seq":24,"level":"info","layer":"host","event":"host.last","fields":{{}}}}"#
    )
    .expect("write");
    drop(file);
    let followed = run_query(
        &config,
        &json!({"channel": "all", "since": first.tail.clone()}).to_string(),
    );
    assert_eq!(seqs_of(&followed), vec![23, 24], "the rows after the tail");
    assert!(
        followed.tail["host-b1"] == 24 && followed.tail["vt-v1"] == 4,
        "the new tail is {:?}: host-b1 covers the file and the debug file",
        followed.tail
    );
    // The row with the earlier clock is not behind the cursor of the rows the first answer held, so only `since` finds it.
    let cursor = first.rows.last().expect("last");
    let after = json!({"channel": "all", "after": {"ts_us": 1791500002000100i64, "role": cursor.role, "boot": cursor.boot, "seq": 2}});
    assert_eq!(
        seqs_of(&run_query(&config, &after.to_string())),
        vec![24],
        "the rows after the cursor of the newest row"
    );
}

// contract: log.query.resolves-a-run-to-the-range-of-its-marks
#[test]
fn query_resolves_a_run_to_the_range_of_its_marks() {
    let (config, _path, events) = write_big("query-run");
    let (start, end) = (events[2000].ts_us, events[6000].ts_us);
    let want: Vec<i64> = sorted_big(&events)
        .iter()
        .filter(|e| e.ts_us >= start && e.ts_us <= end)
        .map(|e| e.seq)
        .collect();
    assert_eq!(
        page_through(&config, json!({"run": "r-big", "limit": 5000})),
        want,
        "run r-big"
    );
    // The run combines with the bounds by intersection.
    let bounded = page_through(
        &config,
        json!({"run": "r-big", "from_us": start + 1_000_000, "to_us": start + 1_500_000, "limit": 5000}),
    );
    let want_bounded: Vec<i64> = sorted_big(&events)
        .iter()
        .filter(|e| e.ts_us >= start + 1_000_000 && e.ts_us <= start + 1_500_000)
        .map(|e| e.seq)
        .collect();
    assert_eq!(bounded, want_bounded, "run with bounds");

    // A start without an end bounds the run to the end of the files.
    let open = temp_dir("query-open-run");
    let text = format!(
        "{}\n{}\n{}\n{}\n{}\n",
        event_line_small(1),
        event_line_small(2),
        r#"{"ts_us":5000,"mono_ns":3,"seq":3,"level":"info","layer":"host","event":"host.test.start","fields":{"name":"a","run":"r-open"}}"#,
        r#"{"ts_us":6000,"mono_ns":4,"seq":4,"level":"debug","layer":"host","event":"host.x.y","fields":{}}"#,
        r#"{"ts_us":7000,"mono_ns":5,"seq":5,"level":"debug","layer":"host","event":"host.x.y","fields":{}}"#
    );
    std::fs::write(open.join("logs").join("host-o.jsonl"), text).expect("write");
    assert_eq!(
        seqs_of(&run_query(&open, r#"{"run": "r-open"}"#)),
        vec![3, 4, 5],
        "an open run"
    );

    let query = parse_log_query(r#"{"run": "r1", "channel": "debug"}"#).expect("query");
    let error = query_logs(&fixture_config("query-no-start"), &query, None)
        .expect_err("a run without a start");
    assert_eq!(
        error,
        r#"log query run "r1" has no host.test.start in the channel"#
    );
}

// contract: log.query.refuses-invalid-parameters
#[test]
fn query_refuses_invalid_parameters() {
    let cases = [
        (r#"{"nope": 1}"#, "log query has no parameter nope"),
        (
            r#"{"channel": "x"}"#,
            r#"log query channel "x" is not one of other, debug, all"#,
        ),
        (
            r#"{"channel": 3}"#,
            "log query channel 3 is not one of other, debug, all",
        ),
        (
            r#"{"level": "loud"}"#,
            r#"log query level "loud" is not one of error, warn, info, debug, trace"#,
        ),
        (
            r#"{"class": "x"}"#,
            r#"log query class "x" is not one of lifecycle, input, call, io, frame"#,
        ),
        (
            r#"{"layer": "x"}"#,
            r#"log query layer "x" is not one of native, host, page, plugin, sidecar, sok"#,
        ),
        (
            r#"{"event": ""}"#,
            r#"log query event must be a non-empty string, found """#,
        ),
        (
            r#"{"surface": 7}"#,
            "log query surface must be a non-empty string, found 7",
        ),
        (
            r#"{"text": null}"#,
            "log query text must be a non-empty string, found null",
        ),
        (
            r#"{"from_us": -1}"#,
            "log query from_us must be a non-negative integer, found -1",
        ),
        (
            r#"{"to_us": 1.5}"#,
            "log query to_us must be a non-negative integer, found 1.5",
        ),
        (
            r#"{"from_us": 5, "to_us": 4}"#,
            "log query from_us is later than to_us: 5 4",
        ),
        (
            r#"{"limit": 0}"#,
            "log query limit must be an integer from 1 to 5000, found 0",
        ),
        (
            r#"{"limit": 5001}"#,
            "log query limit must be an integer from 1 to 5000, found 5001",
        ),
        (
            r#"{"limit": "9"}"#,
            r#"log query limit must be an integer from 1 to 5000, found "9""#,
        ),
        (
            r#"{"order": "up"}"#,
            r#"log query order "up" is not one of asc, desc"#,
        ),
        (
            r#"{"after": {"ts_us": 1}}"#,
            r#"log query after must be {ts_us, role, boot, seq}, found {"ts_us":1}"#,
        ),
        (
            r#"{"after": 3}"#,
            "log query after must be {ts_us, role, boot, seq}, found 3",
        ),
        (
            r#"{"since": {"host-a": "x"}}"#,
            r#"log query since must map process names to integers, found {"host-a":"x"}"#,
        ),
        (
            r#"{"event": "a.b", "event_prefix": "a"}"#,
            "log query takes event or event_prefix, not both",
        ),
        (
            r#"{"event_prefix": "a."}"#,
            r#"log query event_prefix "a." must not end with a dot"#,
        ),
    ];
    for (params, want) in cases {
        let error = parse_log_query(params).expect_err(params);
        assert_eq!(error, want, "{params}");
    }
    let query = parse_log_query("{}").expect("defaults");
    assert_eq!(
        (
            query.limit,
            query.channel.as_str(),
            query.order.as_str(),
            query.level.as_str()
        ),
        (500, "other", "asc", "trace")
    );

    // A file that breaks the event structure fails the query with the file and the line.
    let config = fixture_config("query-broken");
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(config.join("logs").join("vt-v1.jsonl"))
        .expect("append");
    file.write_all(b"not json\n").expect("write");
    drop(file);
    let query = parse_log_query("{}").expect("query");
    let error = query_logs(&config, &query, None).expect_err("broken line");
    assert!(
        error.contains("logs/vt-v1.jsonl:5: not JSON: not json"),
        "{error}"
    );
    let error = query_logs(
        &std::env::temp_dir().join("sok-log-no-logs-folder"),
        &query,
        None,
    )
    .expect_err("no logs folder");
    assert!(error.contains("logs"), "{error}");
}

/// The reference of the query: tests one generated event against the parameters of a query.
fn matches(event: &BigEvent, params: &Value) -> bool {
    let rank = |level: &str| {
        ["error", "warn", "info", "debug", "trace"]
            .iter()
            .position(|l| *l == level)
            .expect("level")
    };
    let text = |name: &str| params.get(name).and_then(Value::as_str);
    let number = |name: &str| params.get(name).and_then(Value::as_i64);
    if let Some(level) = text("level") {
        if rank(&event.level) > rank(level) {
            return false;
        }
    }
    text("layer").is_none_or(|layer| event.layer == layer)
        && text("event").is_none_or(|name| event.event == name)
        && text("event_prefix").is_none_or(|prefix| {
            event.event == prefix || event.event.starts_with(&format!("{prefix}."))
        })
        && text("surface").is_none_or(|surface| event.surface == surface)
        && text("session").is_none_or(|session| event.session == session)
        && text("cid").is_none_or(|cid| event.cid == cid)
        && number("from_us").is_none_or(|from| event.ts_us >= from)
        && number("to_us").is_none_or(|to| event.ts_us <= to)
        && text("text").is_none_or(|needle| {
            event
                .line
                .to_ascii_lowercase()
                .contains(&needle.to_ascii_lowercase())
        })
}

// contract: log.query.pages-through-the-cursor
#[test]
fn query_agrees_with_the_reference_on_the_generated_log() {
    let (config, _path, events) = write_big("query-reference");
    let sorted = sorted_big(&events);
    let base = BIG_BASE;
    let queries = vec![
        json!({"level": "warn"}),
        json!({"level": "error", "layer": "native"}),
        json!({"layer": "page", "level": "info"}),
        json!({"event": "host.call.b"}),
        json!({"event_prefix": "native.input"}),
        json!({"event_prefix": "sidecar"}),
        json!({"surface": "s7"}),
        json!({"surface": "s49", "level": "debug"}),
        json!({"session": "x7"}),
        json!({"cid": "c500"}),
        json!({"cid": "c899"}),
        json!({"from_us": base + 4_000_000, "to_us": base + 4_100_000}),
        json!({"text": "LINE 77"}),
        json!({"text": "line 8999"}),
        json!({"layer": "sok", "event_prefix": "sok.window", "from_us": base + 1_000_000}),
    ];
    for query in queries {
        let want: Vec<i64> = sorted
            .iter()
            .filter(|event| matches(event, &query))
            .map(|event| event.seq)
            .collect();
        let mut params = query.clone();
        params["limit"] = json!(5000);
        assert_eq!(page_through(&config, params), want, "{query}");
    }
}

// contract: log.query.reads-only-the-segments-that-can-hold-a-row
#[test]
fn query_reads_only_the_segments_that_can_hold_a_row() {
    let (config, _path, events) = write_big("query-segments");
    let cases = [
        ("cid", r#"{"cid": "c500"}"#.to_string(), 1usize, 1usize),
        (
            "exact event",
            r#"{"event": "host.test.end"}"#.to_string(),
            1,
            1,
        ),
        (
            "time range",
            format!(
                r#"{{"from_us": {}, "to_us": {}}}"#,
                BIG_BASE + 5_000_000,
                BIG_BASE + 5_010_000
            ),
            1,
            10,
        ),
        ("first page", r#"{"limit": 10}"#.to_string(), 1, 10),
        (
            "last page",
            r#"{"order": "desc", "limit": 10}"#.to_string(),
            1,
            10,
        ),
        ("text", r#"{"text": "line 8999"}"#.to_string(), 3, 1),
    ];
    for (name, params, reads, rows) in cases {
        let page = run_query(&config, &params);
        assert!(
            page.scanned.segments == 3 && page.scanned.read <= reads && (name != "text" || page.scanned.read == 3) && page.rows.len() == rows,
            "{name}: scanned {:?} with {} rows, want at most {reads} segments of 3 read and {rows} rows",
            page.scanned,
            page.rows.len()
        );
    }
    let want = events
        .iter()
        .filter(|e| e.ts_us >= BIG_BASE + 5_000_000 && e.ts_us <= BIG_BASE + 5_010_000)
        .count();
    assert_eq!(want, 10, "the reference counts the lines in the range");
}
