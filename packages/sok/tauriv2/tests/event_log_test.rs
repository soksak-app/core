//! Checks the event file of the tool (docs/spec/cli.md#event-log, docs/spec/logging.md): every run writes
//! logs/sok-<boot>.jsonl in the configuration directory it targets, with the command and its result, and a panic with its
//! stack.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use soksak_sok::{Options, PANIC_STATUS};

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// A temporary folder removed when the test ends.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!(
            "sok-log{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            panic!("{}: {error}", self.0.display());
        }
    }
}

type Command2<'a> = &'a dyn Fn(&[String], &mut dyn Write, &mut dyn Write, &Options) -> i32;

fn logged(config: &Path, command: Command2, args: &[&str]) -> (i32, String) {
    let mut all: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    all.push("--config-dir".into());
    all.push(config.to_str().unwrap().into());
    let options = Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/nonexistent/paths.d")),
        core_version: "0.0.2",
    };
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let code = soksak_sok::logged(&all, &mut stdout, &mut stderr, &options, command);
    (code, String::from_utf8(stderr).unwrap())
}

/// Reads the events that a run left in the logs folder of config: the main file and, when the run stored a debug event, the debug
/// file, in the order of `seq`.
fn events_of(config: &Path) -> Vec<Value> {
    let files: Vec<PathBuf> = match std::fs::read_dir(config.join("logs")) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.starts_with("sok-") && name.ends_with(".jsonl")
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    let debug = |path: &PathBuf| path.to_string_lossy().ends_with(".debug.jsonl");
    assert!(
        files.iter().filter(|path| !debug(path)).count() == 1 && files.len() <= 2,
        "logs/ of {} holds the event files {files:?} of the tool, want one main file and at most one debug file",
        config.display()
    );
    let mut events: Vec<Value> = files
        .iter()
        .flat_map(|file| {
            std::fs::read_to_string(file)
                .unwrap()
                .lines()
                .map(|line| {
                    serde_json::from_str(line)
                        .unwrap_or_else(|_| panic!("{line:?} is not an event"))
                })
                .collect::<Vec<Value>>()
        })
        .collect();
    events.sort_by_key(|event| event["seq"].as_u64().unwrap());
    events
}

fn named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event["event"] == name)
        .collect()
}

// contract: cli.log.records-each-command-with-its-result
#[test]
fn each_command_is_recorded_with_its_result() {
    let config = Dir::new();
    let (code, stderr) = logged(&config.0, &soksak_sok::run, &["nothing"]);
    assert_eq!(code, 2, "stderr {stderr:?}");
    let events = events_of(&config.0);
    assert!(
        events[0]["event"] == "log.open" && events[0]["layer"] == "sok" && events[0]["seq"] == 1,
        "the first line is {}, want log.open of the layer sok with seq 1",
        events[0]
    );
    for event in &events {
        assert!(
            event["layer"] == "sok"
                && event["mono_ns"].as_u64().unwrap_or(0) > 0
                && event["ts_us"].as_u64().unwrap_or(0) > 0,
            "{event} lacks the layer sok or a clock"
        );
    }
    let commands = named(&events, "sok.command");
    assert_eq!(commands.len(), 1, "sok.command events in {events:?}");
    let command = commands[0];
    let fields = &command["fields"];
    assert!(
        command["level"] == "warn"
            && fields["name"] == "nothing"
            && fields["ok"] == false
            && fields["status"] == 2
            && fields["error"] == "sok: unknown command: nothing"
            && fields["micros"].is_number(),
        "sok.command = {command}"
    );
    assert_eq!(
        fields["args"],
        format!("nothing --config-dir {}", config.0.display())
    );

    let passing = Dir::new();
    let (code, stderr) = logged(&passing.0, &soksak_sok::run, &["path", "remove"]);
    assert_eq!(code, 0, "stderr {stderr:?}");
    let events = events_of(&passing.0);
    let ok = named(&events, "sok.command");
    assert!(
        ok.len() == 1
            && ok[0]["level"] == "debug"
            && ok[0]["fields"]["ok"] == true
            && ok[0]["fields"]["status"] == 0
            && ok[0]["fields"].get("error").is_none(),
        "sok.command of a command that succeeded = {ok:?}"
    );
}

// contract: cli.log.records-a-panic-with-its-stack
#[test]
fn a_panic_of_a_command_is_recorded_with_its_stack() {
    let config = Dir::new();
    let panics = |_: &[String], _: &mut dyn Write, _: &mut dyn Write, _: &Options| -> i32 {
        panic!("the command broke")
    };
    let result = std::panic::catch_unwind(|| logged(&config.0, &panics, &["plugin", "list"]));
    let (status, stderr) = result.unwrap_or_else(|_| panic!("the panic reached the caller"));
    assert!(
        status == PANIC_STATUS && stderr.starts_with("sok: panic: the command broke\n"),
        "status {status} stderr {stderr:?}"
    );
    let events = events_of(&config.0);
    let found = named(&events, "sok.panic");
    assert!(
        found.len() == 1
            && found[0]["level"] == "error"
            && found[0]["fields"]["name"] == "main"
            && found[0]["fields"]["text"] == "the command broke",
        "sok.panic events = {found:?}"
    );
    let stack = found[0]["fields"]["stack"].as_str().unwrap_or("");
    assert!(
        stack.contains("a_panic_of_a_command_is_recorded_with_its_stack"),
        "the stack does not name the test that panicked: {stack:?}"
    );
    let commands = named(&events, "sok.command");
    assert!(
        commands.len() == 1
            && commands[0]["fields"]["ok"] == false
            && commands[0]["fields"]["status"] == PANIC_STATUS
            && commands[0]["fields"]["name"] == "plugin",
        "sok.command = {commands:?}"
    );
}

// contract: cli.log.records-a-panic-of-a-routine-and-ends-the-process
#[test]
fn a_panic_of_a_routine_is_recorded_and_ends_the_process() {
    let config = Dir::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "routine_panic_child", "--nocapture"])
        .env("SOK_ROUTINE_PANIC_CONFIG", &config.0)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(PANIC_STATUS),
        "the child ended with {:?}; stderr {stderr:?}",
        output.status
    );
    let events = events_of(&config.0);
    let found = named(&events, "sok.panic");
    assert!(
        found.len() == 1
            && found[0]["fields"]["name"] == "worker"
            && found[0]["fields"]["text"] == "the routine broke",
        "sok.panic events = {found:?}; stderr {stderr:?}"
    );
    let stack = found[0]["fields"]["stack"].as_str().unwrap_or("");
    assert!(
        stack.contains("routine_panic_child"),
        "the stack does not name the function that panicked: {stack:?}"
    );
}

/// The process that `a_panic_of_a_routine_is_recorded_and_ends_the_process` starts; it does nothing in a regular run.
#[test]
fn routine_panic_child() {
    let Some(config) = std::env::var_os("SOK_ROUTINE_PANIC_CONFIG") else {
        return;
    };
    let waits = |_: &[String], _: &mut dyn Write, _: &mut dyn Write, _: &Options| -> i32 {
        let worker = soksak_sok::routine::spawn_named("worker", || panic!("the routine broke"));
        // The routine ends the process; a join that returns means it did not.
        worker.join().unwrap();
        0
    };
    logged(Path::new(&config), &waits, &["windows"]);
}

// contract: cli.log.reports-a-folder-that-cannot-be-written
#[test]
fn a_folder_that_cannot_be_written_is_reported_and_the_command_runs() {
    let parent = Dir::new();
    let config = parent.0.join("file");
    std::fs::write(&config, "x").unwrap();
    let (code, stderr) = logged(&config, &soksak_sok::run, &["path", "remove"]);
    assert!(
        code == 0
            && stderr.starts_with("sok: event log: ")
            && stderr.contains(config.to_str().unwrap()),
        "code {code} stderr {stderr:?}"
    );
}
