#![cfg(not(feature = "diagnostics"))]
//! The query on a log of 1,000,000 events (docs/spec/logging.md#query). The test builds the log, builds its index, and times a query of
//! each kind and the first page, with the limit that each time must keep. It prints each time, so a run records the numbers that
//! docs/features.md (F160.24.7) states. The diagnostics configurations skip it by the feature: the numbers do not depend on them.

#[path = "log_support_test.rs"]
mod log_support;

use std::io::Write;
use std::time::{Duration, Instant};

use log_support::*;
use soksak_sok::log_index::update_log_index;
use soksak_sok::log_query::{parse_log_query, query_logs};

const MILLION_EVENTS: usize = 1_000_000;

// The limits of the times: the build of the index, a page without a filter (first page), a query of one cid, one event name or a short
// time range (selective), a query that fills a page of 5,000 rows from many segments (filtered), and a text that every segment must be
// searched for (text).
const BUILD: Duration = Duration::from_secs(30);
const FIRST_PAGE: Duration = Duration::from_millis(500);
const SELECTIVE: Duration = Duration::from_secs(1);
const FILTERED: Duration = Duration::from_secs(5);
const TEXT: Duration = Duration::from_secs(10);

// contract: log.query.answers-a-million-events-within-the-limit
#[test]
fn query_answers_a_million_events_within_the_limit() {
    let config = temp_dir("million");
    let path = config.join("logs").join("host-big.jsonl");
    let file = std::fs::File::create(&path).expect("create");
    let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);
    let (mut surface_seven, mut error_native, mut time_range) = (0usize, 0usize, 0usize);
    let (mut run_start, mut run_end) = (0i64, 0i64);
    let mut head = vec![];
    generate_each(MILLION_EVENTS, |event| {
        if event.surface == "s7" {
            surface_seven += 1;
        }
        if event.level == "error" && event.layer == "native" {
            error_native += 1;
        }
        if event.ts_us >= BIG_BASE + 500_000_000 && event.ts_us <= BIG_BASE + 500_100_000 {
            time_range += 1;
        }
        match event.seq {
            2001 => run_start = event.ts_us,
            6001 => run_end = event.ts_us,
            _ => {}
        }
        writer.write_all(event.line.as_bytes()).expect("write");
        writer.write_all(b"\n").expect("write");
        if event.seq <= 6001 {
            head.push(event);
        }
    });
    writer.flush().expect("flush");
    drop(writer);
    let run_lines = head
        .iter()
        .filter(|event| event.ts_us >= run_start && event.ts_us <= run_end)
        .count();
    let size = std::fs::metadata(&path).expect("size").len();
    println!("log: {MILLION_EVENTS} events, {:.1} MB", size as f64 / 1e6);

    let started = Instant::now();
    let update = update_log_index(&path).expect("index build");
    let elapsed = started.elapsed();
    assert!(
        update.rebuilt && update.lines == MILLION_EVENTS as i64,
        "index build: {update:?}"
    );
    println!("index build: {elapsed:?}");
    assert!(
        elapsed <= BUILD,
        "the build of the index took {elapsed:?}, over {BUILD:?}"
    );
    let index = std::fs::metadata(path.with_file_name("host-big.jsonl.idx"))
        .expect("index size")
        .len();
    println!("index size: {:.1} MB", index as f64 / 1e6);

    let cases: Vec<(&str, String, Duration, usize)> = vec![
        ("first page", "{}".into(), FIRST_PAGE, 500),
        (
            "newest page",
            r#"{"order": "desc"}"#.into(),
            FIRST_PAGE,
            500,
        ),
        ("cid", r#"{"cid": "c50000"}"#.into(), SELECTIVE, 1),
        (
            "exact event",
            r#"{"event": "host.test.end"}"#.into(),
            SELECTIVE,
            1,
        ),
        (
            "event prefix",
            r#"{"event_prefix": "native.input", "limit": 5000}"#.into(),
            FILTERED,
            5000,
        ),
        (
            "surface",
            r#"{"surface": "s7", "limit": 5000}"#.into(),
            FILTERED,
            surface_seven.min(5000),
        ),
        (
            "time range",
            format!(
                r#"{{"from_us": {}, "to_us": {}}}"#,
                BIG_BASE + 500_000_000,
                BIG_BASE + 500_100_000
            ),
            SELECTIVE,
            time_range,
        ),
        (
            "level and layer",
            r#"{"level": "error", "layer": "native", "limit": 5000}"#.into(),
            FILTERED,
            error_native.min(5000),
        ),
        (
            "run",
            r#"{"run": "r-big", "limit": 5000}"#.into(),
            FILTERED,
            run_lines.min(5000),
        ),
        ("text", r#"{"text": "line 999999"}"#.into(), TEXT, 1),
    ];
    for (name, params, limit, rows) in cases {
        let query = parse_log_query(&params).expect("query");
        let started = Instant::now();
        let page =
            query_logs(&config, &query, None).unwrap_or_else(|error| panic!("{name}: {error}"));
        let elapsed = started.elapsed();
        println!(
            "{name:<16} {elapsed:>12?}  rows {:<5} segments read {} of {}, lines {}",
            page.rows.len(),
            page.scanned.read,
            page.scanned.segments,
            page.scanned.lines
        );
        assert_eq!(page.rows.len(), rows, "{name}: rows");
        assert!(
            elapsed <= limit,
            "{name}: {elapsed:?} is over the limit {limit:?}"
        );
    }
}
