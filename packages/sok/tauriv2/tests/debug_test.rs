//! `sok debug query` (docs/spec/debug.md#timeline-command) prints the same lines as the debug view for the golden files of
//! packages/log-contract/fixtures/query, and rejects a file or a value that breaks the contract with an error that names it.

mod log_support;

use std::path::Path;

use log_support::*;

fn run_query_command(config_dir: &Path, args: &[&str]) -> (String, String, i32) {
    let mut all: Vec<String> = ["debug", "query", "--config-dir"]
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

// contract: cli.debug.query-golden-lines
#[test]
fn query_prints_the_golden_lines_of_every_case() {
    for case in read_cases() {
        let Some(args) = case["args"].as_array() else {
            continue;
        };
        let args: Vec<&str> = args.iter().map(|arg| arg.as_str().expect("arg")).collect();
        let (stdout, stderr, code) = run_query_command(&fixture_config("cli-golden"), &args);
        let want: String = case["lines"]
            .as_array()
            .expect("lines")
            .iter()
            .map(|line| format!("{}\n", line.as_str().expect("line")))
            .collect();
        assert!(
            code == 0 && stdout == want,
            "{}: code {code} stderr {stderr:?}\n got {stdout:?}\nwant {want:?}",
            case["name"]
        );
        let want_more = match case["next"].as_object() {
            Some(next) => format!(
                "more: --after {}/{}/{}/{}\n",
                next["ts_us"],
                next["role"].as_str().expect("role"),
                next["boot"].as_str().expect("boot"),
                next["seq"]
            ),
            None => String::new(),
        };
        assert_eq!(stderr, want_more, "{}: stderr", case["name"]);
    }
}

// contract: cli.debug.query-errors
#[test]
fn query_refuses_what_breaks_the_contract() {
    let empty = std::env::temp_dir().join(format!("sok-debug-no-logs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&empty);
    std::fs::create_dir_all(&empty).expect("create");
    let (_, stderr, code) = run_query_command(&empty, &[]);
    assert!(
        code == 1 && stderr.contains("logs: no such file or directory"),
        "no logs folder: code {code} stderr {stderr:?}"
    );

    let broken = temp_dir("cli-broken");
    let logs = broken.join("logs");
    let open = "{\"ts_us\":1,\"mono_ns\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":2}}\n";
    let line = |extra: &str| format!("{open}{extra}\n");
    let cases: Vec<(&str, String, &str)> = vec![
        ("first line", "{\"ts_us\":1,\"mono_ns\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.x\"}\n".into(), "logs/host-b1.jsonl: the first line is not log.open: \"host.x\""),
        ("schema", "{\"ts_us\":1,\"mono_ns\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":1}}\n".into(), "logs/host-b1.jsonl: schema 1 is not 2"),
        ("not json", line("not json"), "logs/host-b1.jsonl:2: not JSON: not json"),
        ("not object", line("[1]"), "logs/host-b1.jsonl:2: not an event object: [1]"),
        ("seq", line("{\"ts_us\":1,\"seq\":\"x\",\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\"}"), "logs/host-b1.jsonl:2: seq must be an integer, found \"x\""),
        ("level", line("{\"ts_us\":1,\"seq\":1,\"level\":\"loud\",\"layer\":\"host\",\"event\":\"a\"}"), "logs/host-b1.jsonl:2: level \"loud\" is not one of error, warn, info, debug, trace"),
        ("layer", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"x\",\"event\":\"a\"}"), "logs/host-b1.jsonl:2: layer \"x\" is not one of native, host, page, plugin, sidecar, sok"),
        ("event", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":3}"), "logs/host-b1.jsonl:2: event must be a string, found 3"),
        ("fields", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"fields\":[1]}"), "logs/host-b1.jsonl:2: fields must be an object, found [1]"),
        ("cids", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"cids\":[1]}"), "logs/host-b1.jsonl:2: cids must be an array of strings, found [1]"),
        ("surface", line("{\"ts_us\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"surface\":7}"), "logs/host-b1.jsonl:2: surface must be a string, found 7"),
    ];
    for (name, text, want) in cases {
        let _ = std::fs::remove_file(logs.join("host-b1.jsonl.idx"));
        std::fs::write(logs.join("host-b1.jsonl"), text).expect("write the file");
        let (_, stderr, code) = run_query_command(&broken, &[]);
        assert!(
            code == 1 && stderr.contains(want),
            "{name}: code {code} stderr {stderr:?} want {want:?}"
        );
    }
    // A line that is not ended by a line feed is not read yet.
    let _ = std::fs::remove_file(logs.join("host-b1.jsonl.idx"));
    std::fs::write(
        logs.join("host-b1.jsonl"),
        format!("{open}{{\"ts_us\":2,\"seq\":1,\"lev"),
    )
    .expect("write the file");
    let (stdout, stderr, code) = run_query_command(&broken, &[]);
    assert!(
        code == 0 && stdout.matches('\n').count() == 1,
        "unfinished line: code {code} stdout {stdout:?} stderr {stderr:?}"
    );
    // A file without a line has no row and does not hide the other files.
    std::fs::write(logs.join("host-a.jsonl"), "").expect("write the empty file");
    let (stdout, stderr, code) = run_query_command(&broken, &[]);
    assert!(
        code == 0 && stdout.matches('\n').count() == 1,
        "empty file: code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.debug.query-flag-values
#[test]
fn query_refuses_an_invalid_flag_value_as_a_usage_error() {
    let config = fixture_config("cli-flags");
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (vec!["--channel", "x"], "log query channel \"x\" is not one of other, debug, all"),
        (vec!["--level", "loud"], "log query level \"loud\" is not one of error, warn, info, debug, trace"),
        (vec!["--class", "x"], "log query class \"x\" is not one of lifecycle, input, call, io, frame"),
        (vec!["--layer", "x"], "log query layer \"x\" is not one of native, host, page, plugin, sidecar, sok"),
        (vec!["--event", ""], "log query event must be a non-empty string, found \"\""),
        (vec!["--event", "a", "--event-prefix", "b"], "log query takes event or event_prefix, not both"),
        (vec!["--from", "yesterday"], "log query from \"yesterday\" is not a UTC time like 2026-10-08T22:53:20.123456Z"),
        (vec!["--to", "2026-02-30T00:00:00Z"], "log query to \"2026-02-30T00:00:00Z\" is not a UTC time like 2026-10-08T22:53:20.123456Z"),
        (vec!["--from", "2026-10-08T00:00:02Z", "--to", "2026-10-08T00:00:01Z"], "log query from_us is later than to_us: 1791417602000000 1791417601000000"),
        (vec!["--limit", "x"], "log query limit must be an integer from 1 to 5000, found \"x\""),
        (vec!["--limit", "0"], "log query limit must be an integer from 1 to 5000, found 0"),
        (vec!["--order", "up"], "log query order \"up\" is not one of asc, desc"),
        (vec!["--after", "nonsense"], "log query after must be {ts_us, role, boot, seq}, found \"nonsense\""),
        (vec!["--context", "1"], "unknown option --context"),
    ];
    for (args, want) in cases {
        let (stdout, stderr, code) = run_query_command(&config, &args);
        assert!(
            code == 2 && stdout.is_empty() && stderr.contains(want),
            "{args:?}: code {code} stdout {stdout:?} stderr {stderr:?} want {want:?}"
        );
    }
}
