// The processes that the agentprobe sidecar starts for surfaces (docs/spec/sidecars.md#processes-of-a-surface), judged on the real
// `sok-agentprobe` executable as the host runs it: the test starts it with SOKSAK_CONFIG_DIR set, as the host does, writes the lines
// of the host, among them process queries (docs/spec/sidecars.md#process-identity), and reads the lines of the sidecar.
// The program that a process runs in the place of `sok` is a system program, so the test reads what the process gave it.
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use serde_json::{Value, json};

/// The limit of every wait of a test: a line of the sidecar, the exit of the sidecar.
const WAIT: Duration = Duration::from_secs(20);

/// A running sidecar with its input and the lines of its output.
struct Sidecar {
    child: Child,
    input: Option<ChildStdin>,
    lines: Receiver<String>,
}

impl Sidecar {
    /// Starts the sidecar in the folder `dir` with SOKSAK_CONFIG_DIR `config`.
    fn start(dir: &PathBuf, config: &str) -> Sidecar {
        let mut child = Command::new(env!("CARGO_BIN_EXE_sok-agentprobe"))
            .current_dir(dir)
            .env("SOKSAK_CONFIG_DIR", config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the sidecar starts");
        let output = child.stdout.take().expect("the output of the sidecar is piped");
        let (send, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { return };
                if send.send(line).is_err() {
                    return;
                }
            }
        });
        let input = child.stdin.take();
        Sidecar { child, input, lines }
    }

    fn send(&mut self, line: Value) {
        let input = self.input.as_mut().expect("the input of the sidecar is open");
        writeln!(input, "{line}").expect("the sidecar reads its input");
        input.flush().expect("the sidecar reads its input");
    }

    /// The next line of the sidecar as JSON.
    fn next(&self, what: &str) -> Value {
        match self.lines.recv_timeout(WAIT) {
            Ok(line) => serde_json::from_str(&line).unwrap_or_else(|error| panic!("{what}: the line {line:?} is not JSON: {error}")),
            Err(RecvTimeoutError::Timeout) => panic!("{what}: the sidecar wrote no line within {WAIT:?}"),
            Err(RecvTimeoutError::Disconnected) => panic!("{what}: the output of the sidecar ended"),
        }
    }

    /// Closes the input of the sidecar and returns its exit status and the lines that it wrote after the last read line.
    fn end(mut self) -> (std::process::ExitStatus, Vec<String>) {
        drop(self.input.take());
        let mut child = self.child;
        let (send, exit) = std::sync::mpsc::channel();
        std::thread::spawn(move || send.send(child.wait().expect("the exit of the sidecar is read")));
        let status = exit.recv_timeout(WAIT).unwrap_or_else(|_| panic!("the sidecar did not end within {WAIT:?} after the end of its input"));
        // The output ends with the exit of the sidecar, so the reader has sent every line when the channel disconnects.
        (status, self.lines.iter().collect())
    }
}

/// A new empty folder for one test.
fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("agentprobe-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the folder of the test is created");
    dir
}

#[test]
fn a_process_of_a_surface_carries_the_configuration_directory_and_runs_the_program_with_context() {
    let dir = folder("carries");
    let mut sidecar = Sidecar::start(&dir, "/config/of/the/application");
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "start", "sok": "/bin/echo"}}));
    assert_eq!(
        sidecar.next("the process of tab-a"),
        json!({"surface": "tab-a", "body": {"event": "process", "configDirectory": "/config/of/the/application",
            "context": {"status": 0, "signal": null, "stdout": "context\n", "stderr": ""}}})
    );
    sidecar.send(json!({"surface": "tab-b", "root": "/project", "body": {"operation": "start", "sok": "/bin/echo"}}));
    assert_eq!(sidecar.next("the process of tab-b")["body"]["event"], json!("process"));
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "closed": true}));
    assert_eq!(sidecar.next("the close of tab-a"), json!({"surface": "tab-a", "closed": true}));
    let (status, rest) = sidecar.end();
    assert!(status.success(), "the sidecar ended with {status} after the end of its input");
    assert!(rest.is_empty(), "the sidecar wrote {rest:?} after the close");
    std::fs::remove_dir_all(&dir).expect("the folder of the test is removed");
}

#[test]
fn a_program_that_fails_and_a_request_that_the_sidecar_refuses_are_answered_with_their_error() {
    let dir = folder("fails");
    let mut sidecar = Sidecar::start(&dir, "/config");
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "start", "sok": "/bin/cat"}}));
    assert_eq!(
        sidecar.next("the process that runs cat"),
        json!({"surface": "tab-a", "body": {"event": "process", "configDirectory": "/config",
            "context": {"status": 1, "signal": null, "stdout": "", "stderr": "cat: context: No such file or directory\n"}}})
    );
    let missing = dir.join("missing-program");
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "start", "sok": missing}}));
    assert_eq!(
        sidecar.next("the process of a missing program"),
        json!({"surface": "tab-a", "body": {"error": format!("process of tab-a: run {}: No such file or directory (os error 2)", missing.display())}})
    );
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "start"}}));
    assert_eq!(
        sidecar.next("a start without sok"),
        json!({"surface": "tab-a", "body": {"error": "start needs sok, the path of the sok program, not null"}})
    );
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "stop"}}));
    assert_eq!(sidecar.next("an unknown operation"), json!({"surface": "tab-a", "body": {"error": "unknown operation \"stop\""}}));
    let (status, rest) = sidecar.end();
    assert!(status.success(), "the sidecar ended with {status} after the end of its input");
    assert!(rest.is_empty(), "the sidecar wrote {rest:?} at its end");
    std::fs::remove_dir_all(&dir).expect("the folder of the test is removed");
}

#[test]
fn the_close_of_a_surface_ends_its_running_process_before_the_answer() {
    let dir = folder("close");
    // cat opens the named pipe `context` of the folder of the sidecar for reading, which waits for a writer that never comes.
    let status = Command::new("mkfifo").arg(dir.join("context")).status().expect("mkfifo runs");
    assert!(status.success(), "mkfifo ended with {status}");
    let mut sidecar = Sidecar::start(&dir, "/config");
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "start", "sok": "/bin/cat"}}));
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "closed": true}));
    assert_eq!(sidecar.next("the close of tab-a"), json!({"surface": "tab-a", "closed": true}));
    let (status, rest) = sidecar.end();
    assert!(status.success(), "the sidecar ended with {status} after the end of its input");
    assert!(rest.is_empty(), "the sidecar reported {rest:?} for the process that the close ended");
    std::fs::remove_dir_all(&dir).expect("the folder of the test is removed");
}

/// The milliseconds since the Unix epoch now.
fn now() -> i64 {
    let elapsed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("the clock is after the epoch");
    i64::try_from(elapsed.as_millis()).expect("the milliseconds fit")
}

/// The ids of the child processes of `parent`, which proc_listchildpids of libproc reads from the process table.
fn children(parent: u32) -> Vec<u32> {
    let parent = libc::pid_t::try_from(parent).expect("a process id fits pid_t");
    let mut ids = [0 as libc::pid_t; 64];
    let size = libc::c_int::try_from(std::mem::size_of_val(&ids)).expect("the buffer size fits c_int");
    // SAFETY: the buffer holds `size` bytes, and proc_listchildpids writes at most that many.
    let count = unsafe { libc::proc_listchildpids(parent, ids.as_mut_ptr().cast(), size) };
    assert!(count >= 0, "proc_listchildpids({parent}) failed: {}", std::io::Error::last_os_error());
    let count = usize::try_from(count).expect("the count is not negative");
    assert!(count < ids.len(), "the process {parent} has more children than the buffer holds");
    ids[..count].iter().map(|&id| u32::try_from(id).expect("a process id is positive")).collect()
}

#[test]
fn a_process_query_names_the_surface_and_the_start_time_of_a_running_process_that_the_sidecar_started() {
    let dir = folder("query");
    // cat opens the named pipe `context` of the folder of the sidecar for reading, which waits for a writer that never comes.
    let status = Command::new("mkfifo").arg(dir.join("context")).status().expect("mkfifo runs");
    assert!(status.success(), "mkfifo ended with {status}");
    let mut sidecar = Sidecar::start(&dir, "/config");
    let pid = sidecar.child.id();
    let before = now();
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "body": {"operation": "start", "sok": "/bin/cat"}}));
    // The sidecar reads the lines of the host in order, so the answer to this query follows the start of the process.
    sidecar.send(json!({"process": pid, "request": 1}));
    assert_eq!(sidecar.next("a query for the sidecar itself"), json!({"process": pid, "request": 1, "surface": null}));
    let after = now();
    let started = children(pid);
    assert_eq!(started.len(), 1, "the sidecar runs one process: {started:?}");
    let child = started[0];
    sidecar.send(json!({"process": child, "request": 2}));
    let answer = sidecar.next("a query for the process of tab-a");
    assert_eq!((&answer["process"], &answer["request"], &answer["surface"]), (&json!(child), &json!(2), &json!("tab-a")), "{answer}");
    let time = answer["started"].as_i64().unwrap_or_else(|| panic!("the answer has no start time: {answer}"));
    // The process table states the start in microseconds and the answer in milliseconds, so it may lie up to 1 ms before `before`.
    assert!(before - 1 <= time && time <= after, "the start time {time} is not between {before} and {after}");
    sidecar.send(json!({"surface": "tab-a", "root": "/project", "closed": true}));
    assert_eq!(sidecar.next("the close of tab-a"), json!({"surface": "tab-a", "closed": true}));
    sidecar.send(json!({"process": child, "request": 3}));
    assert_eq!(sidecar.next("a query after the close"), json!({"process": child, "request": 3, "surface": null}), "the close reaped the process");
    let (status, rest) = sidecar.end();
    assert!(status.success(), "the sidecar ended with {status} after the end of its input");
    assert!(rest.is_empty(), "the sidecar wrote {rest:?} at its end");
    std::fs::remove_dir_all(&dir).expect("the folder of the test is removed");
}
