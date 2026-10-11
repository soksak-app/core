//! `sok debug timeline` (docs/spec/debug.md#timeline-command) prints the same lines as the debug view for the golden files of
//! packages/log-contract/fixtures/timeline, and rejects a file or a value that breaks the contract with an error that names it.

use std::path::Path;

use serde_json::Value;

const FIXTURES: &str = "../../log-contract/fixtures/timeline";

fn run_timeline(config_dir: &Path, args: &[&str]) -> (String, String, i32) {
    let mut all: Vec<String> = ["debug", "timeline", "--config-dir"]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    all.push(config_dir.display().to_string());
    all.extend(args.iter().map(|arg| arg.to_string()));
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let options = soksak_sok::Options {
        identifier: "app.soksak.tauri",
        paths_dir: Err("not used".to_string()),
        core_version: "0.0.2",
    };
    let code = soksak_sok::run(&all, &mut stdout, &mut stderr, &options);
    (
        String::from_utf8(stdout).expect("stdout is text"),
        String::from_utf8(stderr).expect("stderr is text"),
        code,
    )
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sok-debug-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("logs")).expect("create the logs folder");
    dir
}

// contract: cli.debug.timeline-golden-lines
#[test]
fn timeline_prints_the_golden_lines_of_every_filter() {
    let text = std::fs::read_to_string(Path::new(FIXTURES).join("cases.json")).expect("cases.json");
    let cases: Vec<Value> = serde_json::from_str(&text).expect("cases are JSON");
    assert!(
        cases.len() >= 7,
        "the golden file holds {} cases",
        cases.len()
    );
    for case in cases {
        let args: Vec<&str> = case["args"]
            .as_array()
            .expect("args")
            .iter()
            .map(|arg| arg.as_str().expect("arg"))
            .collect();
        let want: String = case["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .map(|line| format!("{}\n", line.as_str().expect("line")))
            .collect();
        let (stdout, stderr, code) = run_timeline(Path::new(FIXTURES), &args);
        assert!(
            code == 0 && stdout == want,
            "{}: code {code} stderr {stderr:?}\n got {stdout:?}\nwant {want:?}",
            case["name"]
        );
    }
}

// contract: cli.debug.timeline-errors
#[test]
fn timeline_refuses_what_breaks_the_contract() {
    let empty = temp_dir("empty");
    let (_, stderr, code) = run_timeline(&empty, &[]);
    let want = format!(
        "no event file logs/host-<boot>.jsonl in {}",
        empty.join("logs").display()
    );
    assert!(
        code == 1 && stderr.contains(&want),
        "no file: code {code} stderr {stderr:?}"
    );

    let broken = temp_dir("broken");
    let open = "{\"ts_us\":1,\"seq\":0,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":2}}\n";
    let line = |extra: &str| format!("{open}{extra}\n");
    let cases: Vec<(&str, String, &str)> = vec![
        ("first line", "{\"ts_us\":1,\"seq\":0,\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.x\"}\n".into(), "logs/host-b1.jsonl: the first line is not log.open: \"host.x\""),
        ("schema", "{\"ts_us\":1,\"seq\":0,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":1}}\n".into(), "logs/host-b1.jsonl: schema 1 is not 2"),
        ("not json", line("not json"), "logs/host-b1.jsonl:2: not JSON: not json"),
        ("not object", line("[1]"), "logs/host-b1.jsonl:2: not an event object: [1]"),
        ("seq", line("{\"ts_us\":1,\"seq\":\"x\",\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\"}"), "logs/host-b1.jsonl:2: seq must be an integer, found \"x\""),
        ("level", line("{\"ts_us\":1,\"seq\":1,\"level\":\"loud\",\"layer\":\"host\",\"event\":\"a\"}"), "logs/host-b1.jsonl:2: level \"loud\" is not one of error, warn, info, debug, trace"),
        ("layer", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"x\",\"event\":\"a\"}"), "logs/host-b1.jsonl:2: layer \"x\" is not one of native, host, page, plugin, sidecar"),
        ("event", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":3}"), "logs/host-b1.jsonl:2: event must be a string, found 3"),
        ("fields", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"fields\":[1]}"), "logs/host-b1.jsonl:2: fields must be an object, found [1]"),
        ("cids", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"cids\":[1]}"), "logs/host-b1.jsonl:2: cids must be an array of strings, found [1]"),
        ("surface", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"surface\":7}"), "logs/host-b1.jsonl:2: surface must be a string, found 7"),
    ];
    for (name, text, want) in cases {
        std::fs::write(broken.join("logs/host-b1.jsonl"), text).expect("write the file");
        let (_, stderr, code) = run_timeline(&broken, &[]);
        assert!(
            code == 1 && stderr.contains(want),
            "{name}: code {code} stderr {stderr:?} want {want:?}"
        );
    }
    // A line that is not ended by a line feed is not read yet, as in the view.
    std::fs::write(
        broken.join("logs/host-b1.jsonl"),
        format!("{open}{{\"ts_us\":2,\"seq\":1,\"lev"),
    )
    .expect("write the file");
    let (stdout, stderr, code) = run_timeline(&broken, &[]);
    assert!(
        code == 0 && stdout.matches('\n').count() == 1,
        "unfinished line: code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.debug.timeline-filter-values
#[test]
fn timeline_refuses_an_invalid_filter_value_as_a_usage_error() {
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (vec!["--level", "loud"], "timeline level \"loud\" is not one of error, warn, info, debug, trace"),
        (vec!["--layer", "x"], "timeline layer \"x\" is not one of all, native, host, page, plugin, sidecar"),
        (vec!["--from", "yesterday"], "timeline from \"yesterday\" is not a UTC time like 2026-10-08T22:53:20.123456Z or empty"),
        (vec!["--from", "2026-02-30T00:00:00Z"], "timeline from \"2026-02-30T00:00:00Z\" is not a UTC time like 2026-10-08T22:53:20.123456Z or empty"),
        (vec!["--from", "2026-10-08T00:00:02Z", "--to", "2026-10-08T00:00:01Z"], "timeline from is later than to: \"2026-10-08T00:00:02Z\" \"2026-10-08T00:00:01Z\""),
        (vec!["--context", "x"], "timeline context must be decimal digits, found \"x\""),
        (vec!["--context", "12345"], "timeline context must be decimal digits, found \"12345\""),
    ];
    for (args, want) in cases {
        let (stdout, stderr, code) = run_timeline(Path::new(FIXTURES), &args);
        assert!(
            code == 2 && stdout.is_empty() && stderr.contains(want),
            "{args:?}: code {code} stdout {stdout:?} stderr {stderr:?} want {want:?}"
        );
    }
}

// contract: cli.debug.timeline-errors
#[test]
fn timeline_reads_a_file_without_a_line_as_no_rows() {
    let dir = temp_dir("without-a-line");
    let open = "{\"ts_us\":1,\"seq\":0,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":2}}\n";
    std::fs::write(dir.join("logs/host-a.jsonl"), "").expect("write the empty file");
    std::fs::write(dir.join("logs/host-b.jsonl"), open).expect("write the file");
    let (stdout, stderr, code) = run_timeline(&dir, &[]);
    assert!(
        code == 0 && stdout.matches('\n').count() == 1,
        "code {code} stdout {stdout:?} stderr {stderr:?}: the empty file must have no row and the other file one"
    );
}
