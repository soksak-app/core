//! `sok debug replay` (docs/spec/replay.md#command): the events of a session are replayed by the replay executable that an
//! installed sidecar declares, and every stored hash of the sidecar and of the page is compared with the replayed one. The replay
//! executable of these tests is a shell script that stands in for the engine of a sidecar: it counts the bytes of the inputs it
//! reads and prints that count as the hash of each frame record.

#[path = "log_support_test.rs"]
mod log_support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use log_support::{Folder, temp_dir};

/// Prints, for each frame record it reads, the number of bytes of the inputs read so far as 64 decimal digits.
const FAKE_REPLAY: &str = r#"#!/bin/sh
total=0
while IFS= read -r line; do
  case "$line" in
    *'"event":"sidecar.fake.input"'*)
      hex=${line#*'"hex":"'}; hex=${hex%%'"'*}
      total=$((total + ${#hex} / 2)) ;;
    *'"class":"frame"'*)
      sequence=${line#*'"sequence":'}; sequence=${sequence%%[,\}]*}
      printf '{"sequence":%s,"hash":"%064d"}\n' "$sequence" "$total" ;;
  esac
done
"#;

fn log_open(ts: i64, layer: &str, role: &str) -> String {
    format!(
        r#"{{"ts_us":{ts},"mono_ns":{ts},"seq":1,"level":"info","layer":"{layer}","event":"log.open","fields":{{"schema":2,"pid":1,"role":"{role}","boot":"b1"}}}}"#
    )
}

/// The hash that the fake script prints for a count of bytes.
/// The events of the fake sidecar of each kind of replay input.
const REPLAY_INPUTS: &str = r#"{"output":"sidecar.fake.input","write":"sidecar.fake.write","resize":"sidecar.fake.resize","selection":"sidecar.fake.selection","viewport":"sidecar.fake.viewport","theme":"sidecar.fake.theme"}"#;

fn digits(n: usize) -> String {
    format!("{n:064}")
}

#[derive(Clone)]
struct Events {
    sidecar: Vec<String>,
    page: Vec<String>,
}

fn input(ts: i64, seq: i64, sequence: i64, session: &str, hex: &str) -> String {
    format!(
        r#"{{"ts_us":{ts},"mono_ns":{ts},"seq":{seq},"level":"debug","layer":"sidecar","class":"io","event":"sidecar.fake.input","session":"{session}","fields":{{"sequence":{sequence},"hex":"{hex}"}}}}"#
    )
}

/// A frame record; the page frame record is the event of the plugin of the page (layer plugin), which names the segment b1 of the
/// screen that it received.
fn frame(layer: &str, ts: i64, seq: i64, sequence: i64, session: &str, hash: &str) -> String {
    let (name, segment) = if layer == "plugin" {
        ("plugin.fake.frame", r#""segment":"b1","#)
    } else {
        ("sidecar.fake.frame", "")
    };
    format!(
        r#"{{"ts_us":{ts},"mono_ns":{ts},"seq":{seq},"level":"debug","layer":"{layer}","class":"frame","event":"{name}","session":"{session}","fields":{{"sequence":{sequence},{segment}"rows":2,"cols":3,"hash":"{hash}"}}}}"#
    )
}

/// The first replay input of a segment (docs/spec/replay.md#view-state).
fn theme(ts: i64, seq: i64, session: &str) -> String {
    format!(
        r##"{{"ts_us":{ts},"mono_ns":{ts},"seq":{seq},"level":"debug","layer":"sidecar","class":"input","event":"sidecar.fake.theme","session":"{session}","fields":{{"sequence":1,"colors":{{"foreground":"#c0c0c0","background":"#101010","selection":"#404080"}}}}}}"##
    )
}

/// A theme and the inputs "hi" (2 bytes) and "\r\n" (2 bytes) with a frame record after each, written consistently.
fn standard_events() -> Events {
    Events {
        sidecar: vec![
            theme(1005, 1, "s1"),
            input(1010, 2, 2, "s1", "6869"),
            frame("sidecar", 1020, 3, 2, "s1", &digits(2)),
            input(1030, 4, 3, "s1", "0d0a"),
            frame("sidecar", 1040, 5, 3, "s1", &digits(4)),
        ],
        page: vec![
            frame("plugin", 1025, 2, 2, "s1", &digits(2)),
            frame("plugin", 1045, 3, 3, "s1", &digits(4)),
        ],
    }
}

fn write_file(path: &Path, text: &str, mode: u32) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("create the folder");
    std::fs::write(path, text).expect("write the file");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("set the mode");
}

fn event_file(open: String, lines: &[String]) -> String {
    let mut all = vec![open];
    all.extend(lines.iter().cloned());
    all.join("\n") + "\n"
}

/// Writes the event files of the sidecar role "fake" and of the host, and installs a sidecar that declares the replay executable
/// with the given script and the given role.
fn replay_config(name: &str, events: &Events, script: &str, role: &str) -> Folder {
    let config = temp_dir(name);
    write_file(
        &config.join("logs/fake-b1.jsonl"),
        &event_file(log_open(1000, "sidecar", "fake"), &events.sidecar),
        0o600,
    );
    write_file(
        &config.join("logs/host-b1.jsonl"),
        &event_file(log_open(1001, "host", "host"), &events.page),
        0o600,
    );
    let folder = "sidecars/probe-worker/1.0.0/darwin-arm64";
    write_file(
        &config.join("plugins/installed.json"),
        &format!(
            r#"{{"format":3,"plugins":{{"probe":{{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{{"@probe/worker":"^1.0.0"}}}}}},"sidecars":{{"@probe/worker":{{"version":"1.0.0","path":"{folder}"}}}}}}"#
        ),
        0o644,
    );
    write_file(
        &config.join(folder).join("sidecar.json"),
        &format!(
            r#"{{"executable":"worker","protocol":1,"replay":{{"role":"{role}","executable":"replay.sh","inputs":{REPLAY_INPUTS}}}}}"#
        ),
        0o644,
    );
    write_file(&config.join(folder).join("replay.sh"), script, 0o755);
    config
}

type Entrance =
    fn(&[String], &mut dyn std::io::Write, &mut dyn std::io::Write, &soksak_sok::Options) -> i32;

fn run_replay(config: &Path, args: &[&str]) -> (String, String, i32) {
    run_replay_with(soksak_sok::run, config, args)
}

/// Runs the command with the entrance `run`, or `run_logged`, which also writes the event file of the run. The name of that file
/// holds the second and the process, so one configuration directory takes one run of `run_logged`.
fn run_replay_with(entrance: Entrance, config: &Path, args: &[&str]) -> (String, String, i32) {
    let mut all: Vec<String> = ["debug", "replay", "--config-dir"]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    all.push(config.display().to_string());
    all.extend(args.iter().map(|arg| arg.to_string()));
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let options = soksak_sok::Options {
        identifier: "app.soksak.tauri",
        paths_dir: Err("not used".to_string()),
        core_version: "0.0.2",
    };
    let code = entrance(&all, &mut stdout, &mut stderr, &options);
    (
        String::from_utf8(stdout).expect("stdout is text"),
        String::from_utf8(stderr).expect("stderr is text"),
        code,
    )
}

// contract: cli.debug.replay-equal
#[test]
fn replay_reports_equal_when_every_stored_hash_is_the_replayed_one() {
    let config = replay_config("replay-equal", &standard_events(), FAKE_REPLAY, "fake");
    let (stdout, stderr, code) = run_replay(&config, &["s1"]);
    assert!(
        code == 0
            && stdout
                == "replay session s1: 2 sidecar frames and 2 page frames equal in 1 segments\n"
            && stderr.is_empty(),
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.debug.replay-until
#[test]
fn replay_stops_at_the_sequence_of_until() {
    let mut events = standard_events();
    events.sidecar[3] = input(1030, 4, 3, "s1", "0d0a0a");
    let config = replay_config("replay-until", &events, FAKE_REPLAY, "fake");
    let (stdout, stderr, code) = run_replay(&config, &["s1", "--until", "2"]);
    assert!(
        code == 0
            && stdout
                == "replay session s1: 1 sidecar frames and 1 page frames equal in 1 segments\n"
            && stderr.is_empty(),
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
    let (_, stderr, code) = run_replay(&config, &["s1", "--until", "3"]);
    let want = format!(
        "sok: replay divergence: session s1 segment b1 sequence 3 layer sidecar expected {} found {}\n",
        digits(5),
        digits(4)
    );
    assert!(
        code == 1 && stderr.contains(&want),
        "until 2: code {code} stderr {stderr:?}"
    );
    let (_, stderr, code) = run_replay(&config, &["s1", "--until", "x"]);
    assert!(
        code == 2 && stderr.contains("sok: --until must be a non-negative integer, found \"x\""),
        "until x: code {code} stderr {stderr:?}"
    );
}

/// The event of the tool that names the first divergence.
fn divergence(config: &Path) -> String {
    let files: Vec<PathBuf> = std::fs::read_dir(config.join("logs"))
        .expect("logs folder")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| {
            let name = path
                .file_name()
                .expect("name")
                .to_string_lossy()
                .into_owned();
            name.starts_with("sok-") && name.ends_with(".jsonl")
        })
        .collect();
    assert_eq!(files.len(), 1, "event files of the tool {files:?}");
    let data = std::fs::read_to_string(&files[0]).expect("read the event file");
    let found: Vec<&str> = data
        .lines()
        .filter(|line| line.contains(r#""event":"sok.replay.divergence""#))
        .collect();
    assert_eq!(found.len(), 1, "divergence events in {data}");
    found[0].to_string()
}

// contract: cli.debug.replay-divergence
#[test]
fn replay_reports_the_first_divergence_with_its_layer() {
    type Change = fn(&mut Events);
    let cases: Vec<(&str, Change, &str, i64, String, String)> = vec![
        (
            "an input of the sidecar was altered",
            |e| e.sidecar[1] = input(1010, 2, 2, "s1", "686921"),
            "sidecar",
            2,
            digits(3),
            digits(2),
        ),
        (
            "the hash of a frame of the sidecar was altered",
            |e| e.sidecar[4] = frame("sidecar", 1040, 5, 3, "s1", &digits(9)),
            "sidecar",
            3,
            digits(4),
            digits(9),
        ),
        (
            "the hash of a drawn frame was altered",
            |e| e.page[1] = frame("plugin", 1045, 3, 3, "s1", &digits(8)),
            "plugin",
            3,
            digits(4),
            digits(8),
        ),
        (
            "a page frame has no frame of the sidecar",
            |e| e.page.push(frame("plugin", 1050, 4, 4, "s1", &digits(4))),
            "plugin",
            4,
            "none".to_string(),
            digits(4),
        ),
    ];
    for (index, (name, change, layer, sequence, expected, found)) in cases.into_iter().enumerate() {
        let mut events = standard_events();
        change(&mut events);
        let config = replay_config(
            &format!("replay-divergence-{index}"),
            &events,
            FAKE_REPLAY,
            "fake",
        );
        let (stdout, stderr, code) = run_replay_with(soksak_sok::run_logged, &config, &["s1"]);
        let message = format!(
            "replay divergence: session s1 segment b1 sequence {sequence} layer {layer} expected {expected} found {found}"
        );
        assert!(
            code == 1 && stdout.is_empty() && stderr == format!("sok: {message}\n"),
            "{name}: code {code} stdout {stdout:?} stderr {stderr:?}, want {message:?}"
        );
        let fields = format!(
            r#""fields":{{"expected":"{expected}","found":"{found}","layer":"{layer}","segment":"b1","sequence":{sequence},"session":"s1"}}"#
        );
        let line = divergence(&config);
        assert!(
            line.contains(r#""level":"error""#) && line.contains(&fields),
            "{name}: event {line}, want the level error and {fields}"
        );
    }
}

/// A run that must fail without a divergence.
struct Refused {
    name: &'static str,
    events: Events,
    script: &'static str,
    role: &'static str,
    args: Vec<&'static str>,
    want: &'static str,
}

fn refused(
    name: &'static str,
    events: Events,
    script: &'static str,
    role: &'static str,
    args: Vec<&'static str>,
    want: &'static str,
) -> Refused {
    Refused {
        name,
        events,
        script,
        role,
        args,
        want,
    }
}

// contract: cli.debug.replay-errors
#[test]
fn replay_refuses_what_it_cannot_compare() {
    let mut no_frame = standard_events();
    no_frame.sidecar.truncate(2);
    no_frame.page.clear();
    let mut bad_stored = standard_events();
    bad_stored.sidecar[2] = frame("sidecar", 1020, 3, 2, "s1", "ABC");
    let cases = vec![
        refused(
            "no session",
            standard_events(),
            FAKE_REPLAY,
            "fake",
            vec![],
            "sok: session is required\n",
        ),
        refused(
            "unknown session",
            standard_events(),
            FAKE_REPLAY,
            "fake",
            vec!["s9"],
            "sok: replay session s9: the event files hold no event of the layer sidecar for it\n",
        ),
        refused(
            "no sidecar declares the role",
            standard_events(),
            FAKE_REPLAY,
            "other",
            vec!["s1"],
            "sok: replay session s1: no installed sidecar declares the replay role fake\n",
        ),
        refused(
            "no frame record",
            no_frame,
            FAKE_REPLAY,
            "fake",
            vec!["s1"],
            "sok: replay session s1: no frame record to compare\n",
        ),
        refused(
            "a stored hash is not a hash",
            bad_stored,
            FAKE_REPLAY,
            "fake",
            vec!["s1"],
            "sok: replay session s1: sequence 2 layer sidecar: the stored hash is not 64 lowercase hexadecimal characters: \"ABC\"\n",
        ),
        refused(
            "the executable fails",
            standard_events(),
            "#!/bin/sh\necho engine broke >&2\nexit 3\n",
            "fake",
            vec!["s1"],
            "sok: replay session s1: replay.sh exited with status 3: engine broke\n",
        ),
        refused(
            "the executable prints a line that is not a hash",
            standard_events(),
            "#!/bin/sh\necho nope\n",
            "fake",
            vec!["s1"],
            "sok: replay session s1: replay output line 1 is not {\"sequence\": <integer>, \"hash\": <64 lowercase hexadecimal characters>}: nope\n",
        ),
        refused(
            "the executable prints no hash for a frame record",
            standard_events(),
            "#!/bin/sh\ncat >/dev/null\n",
            "fake",
            vec!["s1"],
            "sok: replay session s1: the replay executable reported no hash for the frame record at sequence 2\n",
        ),
    ];
    for (index, case) in cases.into_iter().enumerate() {
        let config = replay_config(
            &format!("replay-errors-{index}"),
            &case.events,
            case.script,
            case.role,
        );
        let (_, stderr, code) = run_replay(&config, &case.args);
        assert!(
            code != 0 && stderr.starts_with(case.want),
            "{}: code {code} stderr {stderr:?}, want it to start with {:?}",
            case.name,
            case.want
        );
    }
    // A session whose sidecar events come from two roles has no single replay executable.
    let config = replay_config("replay-two-roles", &standard_events(), FAKE_REPLAY, "fake");
    write_file(
        &config.join("logs/other-b1.jsonl"),
        &event_file(
            log_open(1002, "sidecar", "other"),
            &[input(1050, 2, 4, "s1", "00")],
        ),
        0o600,
    );
    let want = "sok: replay session s1: sidecar events of more than one role: fake, other\n";
    let (_, stderr, code) = run_replay(&config, &["s1"]);
    assert!(
        code == 1 && stderr == want,
        "two roles: code {code} stderr {stderr:?}, want {want:?}"
    );
}

/// A second run of the sidecar (boot b2) whose sequence restarts at 1: three inputs of 3, 1 and 1 bytes, each followed by a frame
/// record of the sidecar and of the page; the page frames name the segment they received.
fn segment_events(session: &str) -> Events {
    let page_frame = |ts: i64, seq: i64, sequence: i64, hash: &str| {
        frame("plugin", ts, seq, sequence, session, hash).replacen(
            r#""segment":"b1""#,
            r#""segment":"b2""#,
            1,
        )
    };
    Events {
        sidecar: vec![
            theme(2005, 1, session),
            input(2010, 2, 2, session, "00ff10"),
            frame("sidecar", 2020, 3, 2, session, &digits(3)),
            input(2030, 4, 3, session, "aa"),
            frame("sidecar", 2040, 5, 3, session, &digits(4)),
            input(2050, 6, 4, session, "bb"),
            frame("sidecar", 2060, 7, 4, session, &digits(5)),
        ],
        page: vec![
            page_frame(2025, 4, 2, &digits(3)),
            page_frame(2045, 5, 3, &digits(4)),
            page_frame(2065, 6, 4, &digits(5)),
        ],
    }
}

/// The session of `standard_events` (boot b1, its page frames naming b1) followed by `segment_events` (boot b2).
fn segmented_config(name: &str, change: impl Fn(&mut Events, &mut Events)) -> Folder {
    let mut first = standard_events();
    let mut second = segment_events("s1");
    change(&mut first, &mut second);
    let mut page = first.page.clone();
    page.extend(second.page.clone());
    let config = replay_config(
        name,
        &Events {
            sidecar: first.sidecar,
            page,
        },
        FAKE_REPLAY,
        "fake",
    );
    let open = r#"{"ts_us":2000,"mono_ns":2000,"seq":1,"level":"info","layer":"sidecar","event":"log.open","fields":{"schema":2,"pid":2,"role":"fake","boot":"b2"}}"#;
    write_file(
        &config.join("logs/fake-b2.jsonl"),
        &event_file(open.to_string(), &second.sidecar),
        0o600,
    );
    config
}

// contract: cli.debug.replay-segments
#[test]
fn replay_compares_each_segment_of_a_session_whose_sequence_restarts() {
    let config = segmented_config("replay-segments", |_, _| {});
    let (stdout, stderr, code) = run_replay(&config, &["s1"]);
    assert!(
        code == 0
            && stdout
                == "replay session s1: 5 sidecar frames and 5 page frames equal in 2 segments\n"
            && stderr.is_empty(),
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
    // A divergence in the second segment names the segment, which the sequence alone does not.
    let altered = segmented_config("replay-segments-altered", |_, second| {
        second.sidecar[4] = frame("sidecar", 2040, 5, 3, "s1", &digits(9));
    });
    let (stdout, stderr, code) = run_replay_with(soksak_sok::run_logged, &altered, &["s1"]);
    let want = format!(
        "sok: replay divergence: session s1 segment b2 sequence 3 layer sidecar expected {} found {}\n",
        digits(4),
        digits(9)
    );
    assert!(
        code == 1 && stdout.is_empty() && stderr == want,
        "code {code} stdout {stdout:?} stderr {stderr:?}, want {want:?}"
    );
    let fields = format!(
        r#""fields":{{"expected":"{}","found":"{}","layer":"sidecar","segment":"b2","sequence":3,"session":"s1"}}"#,
        digits(4),
        digits(9)
    );
    let line = divergence(&altered);
    assert!(line.contains(&fields), "event {line}, want {fields}");
    // --until applies to the sequence of each segment.
    let (stdout, stderr, code) = run_replay(&config, &["s1", "--until", "2"]);
    assert!(
        code == 0
            && stdout
                == "replay session s1: 2 sidecar frames and 2 page frames equal in 2 segments\n"
            && stderr.is_empty(),
        "until 1: code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.debug.replay-holds-one-segment
#[test]
fn replay_holds_the_event_lines_of_one_segment_at_a_time() {
    let config = segmented_config("replay-holds", |_, _| {});
    let result = soksak_sok::replay::replay_logs(&config, "s1", None).expect("the replay");
    // The segments hold 5 and 7 event lines; the session holds 12.
    assert_eq!(
        (result.segments, result.held_lines),
        (2, 7),
        "segments and held lines"
    );
}

// contract: cli.debug.replay-segment-errors
#[test]
fn replay_refuses_a_page_frame_that_names_no_segment_of_the_session() {
    type Change = fn(&mut Events, &mut Events);
    let cases: Vec<(&str, Change, &str)> = vec![
        (
            "a page frame without a segment",
            |first, _| first.page[0] = first.page[0].replacen(r#""segment":"b1","#, "", 1),
            "sok: replay session s1: the page frame record at sequence 2 has no fields.segment\n",
        ),
        (
            "a page frame of a segment the session does not have",
            |first, _| {
                first.page[0] = first.page[0].replacen(r#""segment":"b1""#, r#""segment":"b9""#, 1)
            },
            "sok: replay session s1: the page frame record at sequence 2 names the segment b9, which the session does not have\n",
        ),
        (
            "a page frame whose segment is not text",
            |first, _| {
                first.page[0] = first.page[0].replacen(r#""segment":"b1""#, r#""segment":7"#, 1)
            },
            "sok: replay session s1: the page frame record at sequence 2 has a fields.segment that is not text\n",
        ),
        (
            "the events of two runs of the sidecar alternate in time",
            |first, _| first.sidecar.push(input(3000, 6, 4, "s1", "00")),
            "sok: replay session s1: the sidecar events of the segments b1 and b2 are interleaved\n",
        ),
    ];
    for (index, (name, change, want)) in cases.into_iter().enumerate() {
        let config = segmented_config(&format!("replay-segment-errors-{index}"), change);
        let (_, stderr, code) = run_replay(&config, &["s1"]);
        assert!(
            code == 1 && stderr == want,
            "{name}: code {code} stderr {stderr:?}, want {want:?}"
        );
    }
    // The screen message carries the segment, so a page frame without it is refused in a session with one segment too.
    let mut events = standard_events();
    events.page[0] = events.page[0].replacen(r#""segment":"b1","#, "", 1);
    let config = replay_config("replay-segment-errors-single", &events, FAKE_REPLAY, "fake");
    let (_, stderr, code) = run_replay(&config, &["s1"]);
    let want =
        "sok: replay session s1: the page frame record at sequence 2 has no fields.segment\n";
    assert!(
        code == 1 && stderr == want,
        "one segment: code {code} stderr {stderr:?}, want {want:?}"
    );
}

// contract: cli.debug.replay-session-rules
#[test]
fn replay_refuses_a_segment_whose_inputs_break_the_rules_of_a_session() {
    let mut events = standard_events();
    events.sidecar.remove(0);
    let config = replay_config("replay-session-rules", &events, FAKE_REPLAY, "fake");
    let (_, stderr, code) = run_replay(&config, &["s1"]);
    let want = "sok: replay session s1: segment b1: input 1 has sequence 2 and the sequence after 0 is 1\n";
    assert!(
        code == 1 && stderr == want,
        "no theme: code {code} stderr {stderr:?}, want {want:?}"
    );
    // A sidecar that does not name the events of its replay inputs cannot be checked.
    let config = replay_config(
        "replay-session-no-inputs",
        &standard_events(),
        FAKE_REPLAY,
        "fake",
    );
    let file = config.join("sidecars/probe-worker/1.0.0/darwin-arm64/sidecar.json");
    write_file(
        &file,
        r#"{"executable":"worker","protocol":1,"replay":{"role":"fake","executable":"replay.sh"}}"#,
        0o644,
    );
    let (_, stderr, code) = run_replay(&config, &["s1"]);
    let want = format!(
        "{}: replay.inputs must name the event of the layer sidecar of each kind of replay input; output is \"\"",
        file.display()
    );
    assert!(
        code == 1 && stderr.contains(&want),
        "no inputs: code {code} stderr {stderr:?}"
    );
}
