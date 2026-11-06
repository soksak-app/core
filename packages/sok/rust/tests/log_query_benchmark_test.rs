#![cfg(not(feature = "diagnostics"))]
//! The query on a log of 1,000,000 events (docs/spec/logging.md#query). The test builds the log, builds its index, and runs a query of
//! each kind and the first page. It judges the rows of each query and the segments and lines that it reads, which the index decides and
//! the load of the machine does not; it prints each time, which the benchmark targets measure after development (F160.24.7). The
//! diagnostics configurations skip it by the feature: the reads do not depend on them.

#[path = "log_support_test.rs"]
mod log_support;

use std::io::Write;
use std::time::Instant;

use log_support::*;
use soksak_sok::log_index::update_log_index;
use soksak_sok::log_query::{parse_log_query, query_logs};

const MILLION_EVENTS: usize = 1_000_000;

// The number of segments of the index of the log of the test.
const SEGMENTS: usize = 245;

// contract: log.query.reads-what-each-query-of-a-million-events-needs
#[test]
fn query_reads_what_each_query_of_a_million_events_needs() {
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
    let index = std::fs::metadata(path.with_file_name("host-big.jsonl.idx"))
        .expect("index size")
        .len();
    println!("index size: {:.1} MB", index as f64 / 1e6);

    let cases: Vec<(&str, String, usize, usize, usize)> = vec![
        ("first page", "{}".into(), 500, 1, 4096),
        ("newest page", r#"{"order": "desc"}"#.into(), 500, 1, 576),
        ("cid", r#"{"cid": "c50000"}"#.into(), 1, 1, 4096),
        (
            "exact event",
            r#"{"event": "host.test.end"}"#.into(),
            1,
            1,
            4096,
        ),
        (
            "event prefix",
            r#"{"event_prefix": "native.input", "limit": 5000}"#.into(),
            5000,
            35,
            143360,
        ),
        (
            "surface",
            r#"{"surface": "s7", "limit": 5000}"#.into(),
            surface_seven.min(5000),
            184,
            753664,
        ),
        (
            "time range",
            format!(
                r#"{{"from_us": {}, "to_us": {}}}"#,
                BIG_BASE + 500_000_000,
                BIG_BASE + 500_100_000
            ),
            time_range,
            1,
            4096,
        ),
        (
            "level and layer",
            r#"{"level": "error", "layer": "native", "limit": 5000}"#.into(),
            error_native.min(5000),
            43,
            176128,
        ),
        (
            "run",
            r#"{"run": "r-big", "limit": 5000}"#.into(),
            run_lines.min(5000),
            4,
            16384,
        ),
        ("text", r#"{"text": "line 999999"}"#.into(), 1, 245, 1000000),
    ];
    for (name, params, rows, segments, lines) in cases {
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
        assert_eq!(
            (page.scanned.read, page.scanned.segments, page.scanned.lines),
            (segments, SEGMENTS, lines),
            "{name}: segments read, segments and lines"
        );
    }
}
