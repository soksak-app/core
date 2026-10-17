//! The retention of the event files (docs/spec/logging.md#retention): the files of the runs in logs/ stay within a stated bound; the
//! oldest runs go first, the run of the writer and a run with a `.keep` file never go, and every removal is the event log.pruned.
//! The same cases run in the Go host.

#[path = "support/records.rs"]
mod records;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};
use soksak_host_tauriv2::event_log::{self, EventLog, Level, Options};

fn line(seq: u64, at: i64, event: &str, padding: &str) -> String {
    json!({"ts_us": at, "mono_ns": 1, "seq": seq, "level": "info", "class": "lifecycle", "layer": "host", "event": event, "fields": {"padding": padding}}).to_string()
}

/// Writes the files of an earlier run into `logs`: an event file of `size` bytes whose first line is log.open at `ts` and whose last
/// line is an event at `last`, its debug file, an index and a standard error file, and gives them the modification time `at`. Returns
/// the bytes of the files.
fn run(logs: &Path, name: &str, ts: i64, last: i64, size: usize, at: SystemTime) -> u64 {
    let fixed = line(1, ts, "log.open", "").len()
        + line(3, ts + 1, "host.app.event", "").len()
        + line(2, last, "host.app.event", "").len()
        + 3;
    let main = format!(
        "{}\n{}\n{}\n",
        line(1, ts, "log.open", ""),
        line(3, ts + 1, "host.app.event", &"x".repeat(size - fixed)),
        line(2, last, "host.app.event", "")
    );
    let files = [
        (format!("{name}.jsonl"), main),
        (
            format!("{name}.debug.jsonl"),
            format!(
                "{}\n{}\n",
                line(3, ts + 1, "log.open", ""),
                line(4, last - 1, "host.trace.mark", "")
            ),
        ),
        (format!("{name}.jsonl.idx"), "i".repeat(100)),
        (format!("{name}.stderr"), "raw\n".to_string()),
    ];
    let mut total = 0;
    for (file, text) in files {
        let path = logs.join(file);
        fs::write(&path, &text).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(at)
            .unwrap();
        total += text.len() as u64;
    }
    total
}

fn options(logs: &Path, bound: u64) -> Options {
    Options {
        directory: logs.to_path_buf(),
        role: "host".into(),
        boot: "1791500009-9".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 1 << 30,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: bound,
    }
}

fn pruned_events(log: &EventLog) -> Vec<Value> {
    log.flush(Duration::from_secs(5)).unwrap();
    // The event lies in the file at the path or in a generation that a later rotation closed.
    let main = log.path().to_path_buf();
    let mut files = vec![main.clone()];
    for n in 1.. {
        let generation = PathBuf::from(format!("{}.{n}", main.display()));
        if !generation.exists() {
            break;
        }
        files.push(generation);
    }
    files
        .iter()
        .flat_map(|file| {
            fs::read_to_string(file)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>()
        })
        .filter(|event| event["event"] == "log.pruned")
        .collect()
}

fn ago(hours: u64) -> SystemTime {
    SystemTime::now() - Duration::from_secs(hours * 3600)
}

// contract: log.retention.removes-the-oldest-runs-over-the-bound
#[test]
fn the_oldest_runs_are_removed_when_the_files_pass_the_bound_and_each_removal_is_an_event() {
    let directory = tempfile::tempdir().unwrap();
    let logs = directory.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let oldest = run(
        &logs,
        "host-1791500001-1",
        1_791_500_001_000_000,
        1_791_500_001_900_000,
        2000,
        ago(4),
    );
    let older = run(
        &logs,
        "vt-1791500002-2",
        1_791_500_002_000_000,
        1_791_500_002_800_000,
        2000,
        ago(3),
    );
    let newer = run(
        &logs,
        "host-1791500003-3",
        1_791_500_003_000_000,
        1_791_500_003_700_000,
        2000,
        ago(2),
    );
    // Files that are no part of a run are left alone.
    for name in ["application.log", "state-1.json", "crash-found.txt"] {
        fs::write(logs.join(name), "z".repeat(5000)).unwrap();
    }
    // The bound leaves room for the newest earlier run and the files of the writer, not for the two older runs.
    let bound = newer + 1000;
    let log = event_log::start(options(&logs, bound)).unwrap();
    records::store_every_level(&log);
    let pruned = pruned_events(&log);
    assert_eq!(pruned.len(), 1, "{pruned:?}");
    let fields = &pruned[0]["fields"];
    assert_eq!(
        fields["runs"],
        json!(["host-1791500001-1", "vt-1791500002-2"])
    );
    assert_eq!(fields["logs"], 8);
    assert_eq!(fields["bytes"], oldest + older);
    assert_eq!(fields["from_us"], 1_791_500_001_000_000u64);
    assert_eq!(fields["to_us"], 1_791_500_002_800_000u64);
    assert_eq!(fields["bound"], bound);
    assert!(fields["remaining"].as_u64().unwrap() <= bound);
    assert_eq!(pruned[0]["level"], "info");
    assert_eq!(pruned[0]["class"], "lifecycle");
    for gone in [
        "host-1791500001-1.jsonl",
        "host-1791500001-1.debug.jsonl",
        "host-1791500001-1.jsonl.idx",
        "host-1791500001-1.stderr",
        "vt-1791500002-2.jsonl",
    ] {
        assert!(!logs.join(gone).exists(), "{gone} was not removed");
    }
    for kept in [
        "host-1791500003-3.jsonl",
        "host-1791500003-3.stderr",
        "application.log",
        "state-1.json",
        "crash-found.txt",
    ] {
        assert!(logs.join(kept).exists(), "{kept} was removed");
    }
    assert!(log.path().exists());
}

// contract: log.retention.keeps-a-pinned-run-and-the-current-run
#[test]
fn a_run_with_a_keep_file_and_the_run_of_the_writer_are_never_removed() {
    let directory = tempfile::tempdir().unwrap();
    let logs = directory.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    run(
        &logs,
        "host-1791500001-1",
        1_791_500_001_000_000,
        1_791_500_001_900_000,
        2000,
        ago(4),
    );
    run(
        &logs,
        "host-1791500002-2",
        1_791_500_002_000_000,
        1_791_500_002_900_000,
        2000,
        ago(3),
    );
    fs::write(logs.join("host-1791500001-1.keep"), "").unwrap();
    // The bound is smaller than the pinned run: the run that is not pinned goes, the pinned run stays, and the event says that the bound
    // is not met.
    let log = event_log::start(options(&logs, 100)).unwrap();
    records::store_every_level(&log);
    let pruned = pruned_events(&log);
    assert_eq!(pruned.len(), 1, "{pruned:?}");
    assert_eq!(pruned[0]["fields"]["runs"], json!(["host-1791500002-2"]));
    assert_eq!(pruned[0]["level"], "warn");
    assert!(pruned[0]["fields"]["remaining"].as_u64() > pruned[0]["fields"]["bound"].as_u64());
    for kept in ["host-1791500001-1.jsonl", "host-1791500001-1.keep"] {
        assert!(logs.join(kept).exists(), "{kept} was removed");
    }
    assert!(log.path().exists());
}

// contract: log.retention.stores-nothing-under-the-bound
#[test]
fn files_under_the_bound_are_not_removed_and_store_no_event() {
    let directory = tempfile::tempdir().unwrap();
    let logs = directory.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    run(
        &logs,
        "host-1791500001-1",
        1_791_500_001_000_000,
        1_791_500_001_900_000,
        2000,
        ago(1),
    );
    let log = event_log::start(options(&logs, 1 << 20)).unwrap();
    records::store_every_level(&log);
    assert_eq!(pruned_events(&log), Vec::<Value>::new());
    assert!(logs.join("host-1791500001-1.jsonl").exists());
}

// contract: log.retention.runs-after-a-rotation
#[test]
fn a_rotation_runs_the_retention_again() {
    let directory = tempfile::tempdir().unwrap();
    let logs = directory.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let mut opts = options(&logs, 600_000);
    opts.rotate_bytes = 1500;
    opts.queue_events = 200;
    let log = event_log::start(opts).unwrap();
    records::store_every_level(&log);
    // An earlier run appears after the start; the first rotation finds the files past the bound and removes it.
    run(
        &logs,
        "host-1791500001-1",
        1_791_500_001_000_000,
        1_791_500_001_900_000,
        1_000_000,
        ago(1),
    );
    for _ in 0..30 {
        log.emit(
            Level::Info,
            "host.app.event",
            &json!({"kind": "x".repeat(60)}),
        );
    }
    let pruned = pruned_events(&log);
    assert!(!pruned.is_empty(), "no rotation removed the earlier run");
    assert_eq!(pruned[0]["fields"]["runs"], json!(["host-1791500001-1"]));
}

// contract: log.retention.requires-a-bound
#[test]
fn an_event_log_without_a_retention_bound_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    match event_log::start(options(directory.path(), 0)) {
        Err(error) => assert!(error.contains("retention_bytes"), "{error}"),
        Ok(_) => panic!("a log without a retention bound started"),
    }
}
