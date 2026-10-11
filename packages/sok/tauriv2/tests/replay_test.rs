//! `sok debug replay` (docs/spec/replay.md#command): the events of a session are replayed by the replay executable that an
//! installed sidecar declares, and every stored hash of the sidecar and of the page is compared with the replayed one. The replay
//! executable of these tests is a shell script that stands in for the engine of a sidecar: it counts the bytes of the inputs it
//! reads and prints that count as the hash of each frame record.

#[path = "log_support_test.rs"]
mod log_support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use log_support::temp_dir;

/// Prints, for each frame record it reads, the number of bytes of the inputs read so far as 64 decimal digits.
const FAKE_REPLAY: &str = r#"#!/bin/sh
total=0
while IFS= read -r line; do
  case "$line" in
    *'"event":"fake.input"'*)
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
        r#"{{"ts_us":{ts},"mono_ns":{ts},"seq":{seq},"level":"debug","layer":"sidecar","class":"io","event":"fake.input","session":"{session}","fields":{{"sequence":{sequence},"hex":"{hex}"}}}}"#
    )
}

fn frame(layer: &str, ts: i64, seq: i64, sequence: i64, session: &str, hash: &str) -> String {
    format!(
        r#"{{"ts_us":{ts},"mono_ns":{ts},"seq":{seq},"level":"debug","layer":"{layer}","class":"frame","event":"fake.frame","session":"{session}","fields":{{"sequence":{sequence},"rows":2,"cols":3,"hash":"{hash}"}}}}"#
    )
}

/// The inputs "hi" (2 bytes) and "\r\n" (2 bytes) with a frame record after each, written consistently.
fn standard_events() -> Events {
    Events {
        sidecar: vec![
            input(1010, 2, 1, "s1", "6869"),
            frame("sidecar", 1020, 3, 1, "s1", &digits(2)),
            input(1030, 4, 2, "s1", "0d0a"),
            frame("sidecar", 1040, 5, 2, "s1", &digits(4)),
        ],
        page: vec![
            frame("page", 1025, 2, 1, "s1", &digits(2)),
            frame("page", 1045, 3, 2, "s1", &digits(4)),
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
fn replay_config(name: &str, events: &Events, script: &str, role: &str) -> PathBuf {
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
            r#"{{"format":2,"plugins":{{"probe":{{"version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{{"@probe/worker":"^1.0.0"}}}}}},"sidecars":{{"@probe/worker":{{"version":"1.0.0","path":"{folder}"}}}}}}"#
        ),
        0o644,
    );
    write_file(
        &config.join(folder).join("sidecar.json"),
        &format!(
            r#"{{"executable":"worker","protocol":1,"replay":{{"role":"{role}","executable":"replay.sh"}}}}"#
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
            && stdout == "replay session s1: 2 sidecar frames and 2 page frames equal\n"
            && stderr.is_empty(),
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.debug.replay-until
#[test]
fn replay_stops_at_the_sequence_of_until() {
    let mut events = standard_events();
    events.sidecar[2] = input(1030, 4, 2, "s1", "0d0a0a");
    let config = replay_config("replay-until", &events, FAKE_REPLAY, "fake");
    let (stdout, stderr, code) = run_replay(&config, &["s1", "--until", "1"]);
    assert!(
        code == 0
            && stdout == "replay session s1: 1 sidecar frames and 1 page frames equal\n"
            && stderr.is_empty(),
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
    let (_, stderr, code) = run_replay(&config, &["s1", "--until", "2"]);
    let want = format!(
        "sok: replay divergence: session s1 sequence 2 layer sidecar expected {} found {}\n",
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
            |e| e.sidecar[0] = input(1010, 2, 1, "s1", "686921"),
            "sidecar",
            1,
            digits(3),
            digits(2),
        ),
        (
            "the hash of a frame of the sidecar was altered",
            |e| e.sidecar[3] = frame("sidecar", 1040, 5, 2, "s1", &digits(9)),
            "sidecar",
            2,
            digits(4),
            digits(9),
        ),
        (
            "the hash of a drawn frame was altered",
            |e| e.page[1] = frame("page", 1045, 3, 2, "s1", &digits(8)),
            "page",
            2,
            digits(4),
            digits(8),
        ),
        (
            "a page frame has no frame of the sidecar",
            |e| e.page.push(frame("page", 1050, 4, 3, "s1", &digits(4))),
            "page",
            3,
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
            "replay divergence: session s1 sequence {sequence} layer {layer} expected {expected} found {found}"
        );
        assert!(
            code == 1 && stdout.is_empty() && stderr == format!("sok: {message}\n"),
            "{name}: code {code} stdout {stdout:?} stderr {stderr:?}, want {message:?}"
        );
        let fields = format!(
            r#""fields":{{"expected":"{expected}","found":"{found}","layer":"{layer}","sequence":{sequence},"session":"s1"}}"#
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
    no_frame.sidecar.truncate(1);
    no_frame.page.clear();
    let mut bad_stored = standard_events();
    bad_stored.sidecar[1] = frame("sidecar", 1020, 3, 1, "s1", "ABC");
    let cases = vec![
        refused("no session", standard_events(), FAKE_REPLAY, "fake", vec![], "sok: session is required\n"),
        refused("unknown session", standard_events(), FAKE_REPLAY, "fake", vec!["s9"], "sok: replay session s9: the event files hold no event of the layer sidecar for it\n"),
        refused("no sidecar declares the role", standard_events(), FAKE_REPLAY, "other", vec!["s1"], "sok: replay session s1: no installed sidecar declares the replay role fake\n"),
        refused("no frame record", no_frame, FAKE_REPLAY, "fake", vec!["s1"], "sok: replay session s1: no frame record to compare\n"),
        refused("a stored hash is not a hash", bad_stored, FAKE_REPLAY, "fake", vec!["s1"], "sok: replay session s1: sequence 1 layer sidecar: the stored hash is not 64 lowercase hexadecimal characters: \"ABC\"\n"),
        refused("the executable fails", standard_events(), "#!/bin/sh\necho engine broke >&2\nexit 3\n", "fake", vec!["s1"], "sok: replay session s1: replay.sh exited with status 3: engine broke\n"),
        refused("the executable prints a line that is not a hash", standard_events(), "#!/bin/sh\necho nope\n", "fake", vec!["s1"], "sok: replay session s1: replay output line 1 is not {\"sequence\": <integer>, \"hash\": <64 lowercase hexadecimal characters>}: nope\n"),
        refused("the executable prints no hash for a frame record", standard_events(), "#!/bin/sh\ncat >/dev/null\n", "fake", vec!["s1"], "sok: replay session s1: the replay executable reported no hash for the frame record at sequence 1\n"),
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
            &[input(1050, 2, 3, "s1", "00")],
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
