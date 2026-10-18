//! The query over the files that the writer wrote (docs/spec/logging.md#query): the channel `other` reads the main file and its
//! generations, the channel `debug` reads the debug file and its generations, and the filter `class` matches the class that the writer
//! stored in the line. The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::{self, Level, Options};
use soksak_sok::log_query::{parse_log_query, query_logs};

/// Writes events of every level and of three classes through the writer into a configuration folder whose small bound rotates both
/// files; returns the number of the events of each level.
fn write_mixed_events(config: &Path) -> BTreeMap<&'static str, usize> {
    let log = event_log::start(Options {
        directory: config.join("logs"),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 500,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1500,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    })
    .unwrap();
    records::store_every_level(&log);
    let events: [(Level, &str, &str, Value); 6] = [
        (
            Level::Error,
            "error",
            "host.panic",
            json!({"name": "n", "text": "t", "stack": "s"}),
        ),
        (
            Level::Warn,
            "warn",
            "host.crash.found",
            json!({"path": "p", "pid": 1, "time": "t"}),
        ),
        (
            Level::Info,
            "info",
            "host.app.event",
            json!({"kind": "x".repeat(40)}),
        ),
        (
            Level::Debug,
            "debug",
            "host.binding.call",
            json!({"name": "echo", "args": "[]", "micros": 1, "ok": true, "truncated": false}),
        ),
        (Level::Trace, "trace", "host.trace.mark", json!({})),
        (
            Level::Debug,
            "debug",
            "host.sidecar.reply",
            json!({"name": "n", "surface": "s", "bytes": 1, "ok": true}),
        ),
    ];
    let mut counts = BTreeMap::new();
    for _ in 0..12 {
        for (level, label, name, fields) in &events {
            assert!(log.emit(*level, name, fields), "{name} was refused");
            *counts.entry(*label).or_default() += 1;
        }
    }
    log.flush(Duration::from_secs(10)).unwrap();
    counts
}

fn query_names(config: &Path, params: &str) -> (Vec<String>, BTreeSet<String>) {
    let mut query = parse_log_query(params).unwrap();
    query.limit = 5000;
    let page = query_logs(config, &query, None).unwrap();
    let names = page
        .rows
        .iter()
        .map(|row| {
            let event: Value = serde_json::from_str(row.event.get()).unwrap();
            event["event"].as_str().unwrap().to_string()
        })
        .collect();
    let files = page.rows.iter().map(|row| row.file.clone()).collect();
    (names, files)
}

fn count(names: &[String], name: &str) -> usize {
    names.iter().filter(|candidate| *candidate == name).count()
}

// contract: log.query.reads-the-files-the-writer-wrote
#[test]
fn the_query_reads_the_main_files_as_other_and_the_debug_files_as_debug_across_generations() {
    let config = folder::Folder::new();
    let counts = write_mixed_events(config.path());
    let (other, other_files) = query_names(config.path(), r#"{"channel":"other"}"#);
    let (debug, debug_files) = query_names(config.path(), r#"{"channel":"debug"}"#);
    let (all, _) = query_names(config.path(), r#"{"channel":"all"}"#);
    for name in ["host.binding.call", "host.trace.mark", "host.sidecar.reply"] {
        assert_eq!(count(&other, name), 0, "the channel other holds {name}");
    }
    assert_eq!(count(&other, "host.panic"), counts["error"]);
    assert_eq!(count(&other, "host.crash.found"), counts["warn"]);
    assert_eq!(count(&other, "host.app.event"), counts["info"]);
    assert_eq!(count(&debug, "host.binding.call"), 12);
    assert_eq!(count(&debug, "host.trace.mark"), counts["trace"]);
    assert_eq!(count(&debug, "host.sidecar.reply"), 12);
    assert_eq!(count(&debug, "host.app.event"), 0);
    assert_eq!(all.len(), other.len() + debug.len());
    // Both files rotated, so each channel reads generations.
    for (channel, files) in [("other", other_files), ("debug", debug_files)] {
        let generations = files
            .iter()
            .filter(|file| {
                file.rsplit('.')
                    .next()
                    .is_some_and(|last| last.chars().all(|c| c.is_ascii_digit()))
            })
            .count();
        assert!(
            generations >= 2,
            "the channel {channel} read {generations} generations: {files:?}"
        );
    }
}

// contract: log.query.matches-the-class-the-writer-stored
#[test]
fn the_filter_class_matches_the_class_that_the_writer_stored() {
    let config = folder::Folder::new();
    write_mixed_events(config.path());
    let want: [(&str, Vec<&str>); 3] = [
        ("call", vec!["host.binding.call", "host.trace.mark"]),
        ("io", vec!["host.sidecar.reply"]),
        (
            "lifecycle",
            vec![
                "host.app.event",
                "host.crash.found",
                "host.panic",
                "log.open",
                "log.policy",
                "log.rotated",
            ],
        ),
    ];
    for (class, names) in want {
        let (found, _) = query_names(
            config.path(),
            &format!(r#"{{"channel":"all","class":"{class}"}}"#),
        );
        let unique: BTreeSet<&str> = found.iter().map(String::as_str).collect();
        assert_eq!(
            unique.into_iter().collect::<Vec<_>>(),
            names,
            "class {class}"
        );
    }
    let (found, _) = query_names(config.path(), r#"{"channel":"all","class":"frame"}"#);
    assert!(found.is_empty(), "class frame matches {found:?}");
}
