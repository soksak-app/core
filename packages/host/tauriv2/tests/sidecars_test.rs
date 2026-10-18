//! Sidecar channel tests. They use a fake window and shell script sidecars.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

use serde_json::value::RawValue;
use soksak_host_tauriv2::sidecars::{
    ClosingSurface, Failure, Message, MessageLine, Owner, SidecarDeclaration, Sidecars,
    read_message_line,
};

/// The upper limit that ends a stalled check. Success is decided by the received event and the ended process and not by
/// this time. Even on a heavily loaded machine, the answer and the end of the sidecar come within this time.
const STALL: Duration = Duration::from_secs(120);

#[derive(Clone)]
struct FakeOwner {
    key: String,
    root: String,
    sent: Sender<Message>,
    // Only a check that asserts a failure has a failure channel.
    failed: Option<Sender<Failure>>,
}

impl Owner for FakeOwner {
    fn key(&self) -> String {
        self.key.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.root.clone())
    }
    fn deliver(&self, message: Message) {
        let _ = self.sent.send(message);
    }
    fn deliver_failure(&self, failure: Failure) {
        match &self.failed {
            Some(failed) => failed.send(failure).expect("failure receiver"),
            // The failure of a check that does not assert failures is left in the check output.
            None => eprintln!("sidecar failure: {failure:?}"),
        }
    }
}

fn owner(key: &str, root: &str) -> (FakeOwner, Receiver<Message>) {
    let (sent, received) = channel();
    (
        FakeOwner {
            key: key.into(),
            root: root.into(),
            sent,
            failed: None,
        },
        received,
    )
}

/// A window that also receives failure events.
fn failing_owner(key: &str, root: &str) -> (FakeOwner, Receiver<Message>, Receiver<Failure>) {
    let (sent, received) = channel();
    let (failed, failures) = channel();
    (
        FakeOwner {
            key: key.into(),
            root: root.into(),
            sent,
            failed: Some(failed),
        },
        received,
        failures,
    )
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

type Files = Vec<(&'static str, String)>;

/// One sidecar @fixture/sidecar-echo and the content of its sidecar.json.
fn files(sidecar: &str) -> Files {
    vec![("@fixture/sidecar-echo", sidecar.to_string())]
}

/// The declarations of the sidecars installed in folder.
fn declare(files: &Files, folder: &Path) -> Vec<SidecarDeclaration> {
    files
        .iter()
        .map(|(name, data)| SidecarDeclaration {
            name: name.to_string(),
            folder: folder.to_path_buf(),
            data: data.as_bytes().to_vec(),
            version: "0.0.1".to_string(),
        })
        .collect()
}

fn create(files: &Files, directory: &Path) -> Result<Sidecars<FakeOwner>, String> {
    Sidecars::new(&declare(files, directory), directory.to_path_buf())
}

const ECHO: &str = "@fixture/sidecar-echo";

/// Declares the fake sidecar @fixture/sidecar-echo, which prints the received line as it is and leaves it in the
/// request record file.
fn echo_sidecars() -> (Sidecars<FakeOwner>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let record = directory.path().join("requests");
    let program = directory.path().join("echo");
    std::fs::write(&program, format!("#!/bin/sh\ntee {}\n", record.display())).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut sidecars = create(
        &files(r#"{"executable":"echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    // stop closes stdin and waits for echo to record the remaining lines and end. With a short deadline it would be
    // ended by force before recording under load, so the deadline is set to STALL. echo ends soon at EOF, so the check
    // does not become slow.
    sidecars.stop_timeout = STALL;
    (sidecars, directory)
}

// contract: sidecars.send.delivers-only-to-owning-window, sidecars.send.rejects-surface-owned-by-another-window, sidecars.protocol.request-lines-carry-surface-root-body, sidecars.close-owner.sends-closed-per-surface
#[test]
fn messages_reach_the_owning_window_only() {
    let (sidecars, directory) = echo_sidecars();
    let (first, first_events) = owner("a", "/projects/a");
    let (second, second_events) = owner("b", "/projects/b");
    sidecars
        .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars
        .send(&second, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let event = first_events.recv_timeout(STALL).unwrap();
    assert_eq!(
        (
            event.sidecar.as_str(),
            event.surface.as_str(),
            event.body.get()
        ),
        (ECHO, "s1", r#"{"operation":"open"}"#)
    );
    assert_eq!(second_events.recv_timeout(STALL).unwrap().surface, "s2");
    let error = sidecars.send(&second, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("another window"), "{error}");
    sidecars.retain(&first, &|_| false).unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s2","root":"/projects/b","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","closed":true}"#,
            "\n",
        )
    );
}

// contract: sidecars.protocol.surface-keeps-its-first-root
#[test]
fn a_surface_keeps_the_root_it_was_opened_with() {
    let (sidecars, directory) = echo_sidecars();
    let (before, _before_events) = owner("a", "/projects/a");
    // Even after the same window changed to another project, an already opened surface sends with the first root.
    let (after, _after_events) = owner("a", "/projects/b");
    sidecars
        .send(&before, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars
        .send(&after, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
        .unwrap();
    sidecars.retain(&after, &|_| false).unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"input"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","closed":true}"#,
            "\n",
        )
    );
}

// contract: sidecars.close.keeps-other-sessions
#[test]
fn closing_a_surface_keeps_other_sessions() {
    let (sidecars, directory) = echo_sidecars();
    let (window, _events) = owner("a", "/projects/a");
    for surface in ["s1", "state:files:p1"] {
        sidecars
            .send(&window, ECHO, surface, &raw(r#"{"operation":"open"}"#))
            .unwrap();
    }
    // The surface synchronization closes only the removed surfaces.
    sidecars
        .retain(&window, &|surface| surface != "s1")
        .unwrap();
    // Even after the project of the window was removed, a session that was not closed sends with the first root.
    let (released, _released_events) = owner("a", "");
    sidecars
        .send(
            &released,
            ECHO,
            "state:files:p1",
            &raw(r#"{"operation":"watch"}"#),
        )
        .unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"state:files:p1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","closed":true}"#,
            "\n",
            r#"{"surface":"state:files:p1","root":"/projects/a","body":{"operation":"watch"}}"#,
            "\n",
        )
    );
}

// contract: sidecars.send.rejects-undeclared-sidecar, sidecars.send.rejects-after-stop
#[test]
fn undeclared_and_stopped_sidecars_are_rejected() {
    let (sidecars, _directory) = echo_sidecars();
    let (window, _events) = owner("a", "/projects/a");
    assert!(
        sidecars
            .send(&window, "other", "s1", &raw("{}"))
            .unwrap_err()
            .contains("not declared")
    );
    sidecars.stop();
    assert!(
        sidecars
            .send(&window, ECHO, "s1", &raw("{}"))
            .unwrap_err()
            .contains("stopped")
    );
}

// contract: sidecars.start.fails-on-missing-executable
#[test]
fn a_missing_executable_fails() {
    let directory = tempfile::tempdir().unwrap();
    let sidecars = create(
        &files(r#"{"executable":"echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    let (window, _events) = owner("a", "/");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains(&format!("sidecar {ECHO}")), "{error}");
}

// contract: sidecars.start.passes-log-directory
#[test]
fn a_sidecar_receives_the_log_directory() {
    let directory = tempfile::tempdir().unwrap();
    let record = directory.path().join("argv");
    let program = directory.path().join("echo");
    std::fs::write(
        &program,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nread request\nprintf '%s\\n' '{{\"surface\":\"s1\",\"body\":\"ok\"}}'\nexec cat\n",
            record.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut sidecars = create(
        &files(r#"{"executable":"echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    sidecars.stop_timeout = STALL;
    let (window, events) = owner("a", "/projects/a");
    sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap();
    events.recv_timeout(STALL).unwrap();
    let config = directory.path().canonicalize().unwrap();
    assert_eq!(
        std::fs::read_to_string(&record).unwrap(),
        format!("--log-dir\n{}\n", config.join("logs").display())
    );
}

// contract: sidecars.declaration.adds-sidecars-installed-after-start
#[test]
fn declaring_adds_sidecars_installed_after_the_start() {
    let directory = tempfile::tempdir().unwrap();
    let record = directory.path().join("requests");
    let program = directory.path().join("echo");
    std::fs::write(&program, format!("#!/bin/sh\ntee {}\n", record.display())).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut sidecars = create(&Vec::new(), directory.path()).unwrap();
    sidecars.stop_timeout = STALL;
    let (window, events) = owner("a", "/projects/a");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("is not declared by any plugin"), "{error}");
    sidecars
        .declare(&declare(
            &files(r#"{"executable":"echo","protocol":1}"#),
            directory.path(),
        ))
        .unwrap();
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let event = events.recv_timeout(STALL).unwrap();
    assert_eq!(
        (event.surface.as_str(), event.body.get()),
        ("s1", r#"{"operation":"open"}"#)
    );
    sidecars.stop();
}

// contract: sidecars.declaration.rejects-executable-escaping-package
#[test]
fn an_executable_outside_the_package_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"../escape","protocol":1}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains(&directory.path().join("sidecar.json").display().to_string()),
        "{error}"
    );
}

// contract: sidecars.declaration.rejects-absolute-executable
#[test]
fn an_absolute_executable_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"/bin/sh","protocol":1}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains("is not a path inside the package"),
        "{error}"
    );
}

// contract: sidecars.declaration.persistent-requires-config-directory
#[test]
fn persistent_transport_requires_a_config_directory() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let error = Sidecars::<FakeOwner>::new(
        &declare(&fixture, directory.path()),
        std::path::PathBuf::new(),
    )
    .err()
    .unwrap();
    assert!(error.contains("config directory"), "{error}");
}

// contract: sidecars.declaration.rejects-unsupported-protocol
#[test]
fn an_unsupported_protocol_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"echo","protocol":2}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains(&directory.path().join("sidecar.json").display().to_string()),
        "{error}"
    );
}

// contract: sidecars.declaration.rejects-unknown-transport
#[test]
fn persistent_transport_rejects_unknown_transport() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"echo","protocol":1,"transport":"ptyd"}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(error.contains("transport ptyd is not supported"), "{error}");
}

// contract: sidecars.persistent.accepts-non-canonical-config-directory
#[test]
fn persistent_transport_accepts_a_non_canonical_config_directory() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &declare(&fixture, executable_directory.path()),
        config_directory.path().join("."),
    )
    .unwrap();
    let (window, _events) = owner("a", "/projects/test");
    // There is no executable, so the service start fails, and before that the service directory is created under the
    // configuration directory.
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}"));
    assert!(error.unwrap_err().contains("sidecar"));
    assert!(
        config_directory
            .path()
            .join("services")
            .join("echo")
            .is_dir(),
        "the service directory is not under the config directory"
    );
}

// contract: sidecars.send.rejects-when-no-plugin-declares-sidecars
#[test]
fn plugins_without_sidecars_declare_none() {
    let directory = tempfile::tempdir().unwrap();
    let sidecars = create(&Files::new(), directory.path()).unwrap();
    let (window, _events) = owner("a", "/");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("is not declared by any plugin"), "{error}");
}

// contract: sidecars.send.fails-fast-when-sidecar-not-keeping-up, sidecars.send.slow-sidecar-does-not-block-others, sidecars.stop.honors-stop-timeout
#[test]
fn slow_sidecar_does_not_block_other_sends() {
    // The slow sidecar does not read stdin, and the other sidecar works normally. If more than 256 are sent to the slow
    // sidecar, it eventually fails with an "is not keeping up" error. This test checks two properties:
    // 1. Even when the channel of the slow sidecar is full, send() to the fast sidecar does not block.
    // 2. stop() keeps stop_timeout.

    let directory = tempfile::tempdir().unwrap();

    // The slow sidecar: it does not read stdin, so the pipe fills and stop kills it after the deadline. A program that
    // reads stdin, such as cat, has a read speed that depends on the load, so whether the channel fills is not
    // determined.
    let slow_program = directory.path().join("slow");
    std::fs::write(&slow_program, "#!/bin/sh\nexec sleep 600\n").unwrap();
    std::fs::set_permissions(&slow_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    // The fast sidecar: it prints the received line as it is.
    let fast_program = directory.path().join("fast");
    std::fs::write(&fast_program, "#!/bin/sh\ntee /dev/null\n").unwrap();
    std::fs::set_permissions(&fast_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    // A frontend that declares the two sidecars.
    let files: Files = vec![
        (
            "@fixture/sidecar-slow",
            r#"{"executable":"slow","protocol":1}"#.to_string(),
        ),
        (
            "@fixture/sidecar-fast",
            r#"{"executable":"fast","protocol":1}"#.to_string(),
        ),
    ];
    let mut sidecars = create(&files, directory.path()).unwrap();
    // The deadline is set to 100 ms for the test.
    sidecars.stop_timeout = Duration::from_millis(100);
    let (owner, _events) = owner("a", "/projects/test");

    // The first send to the fast sidecar starts that process. The start time is unrelated to property 1, so it is
    // started first and only recorded.
    let started = std::time::Instant::now();
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-fast",
            "s2",
            &raw(r#"{"data":"start"}"#),
        )
        .unwrap();
    println!(
        "the first fast send, which starts the process, took {:?}",
        started.elapsed()
    );

    // Send to the slow sidecar until its channel is full.
    let large_body = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut last_err = None;
    for i in 0..500 {
        if let Err(e) = sidecars.send(&owner, "@fixture/sidecar-slow", "s1", &large_body) {
            last_err = Some(e.clone());
            if e.contains("is not keeping up") {
                break; // the channel was observed to be full
            }
            panic!("send {}: unexpected error: {}", i, e);
        }
    }

    // Check that the "is not keeping up" error was finally received.
    assert!(
        last_err.is_some() && last_err.as_ref().unwrap().contains("is not keeping up"),
        "want 'is not keeping up', got {:?}",
        last_err
    );

    // Property 1: even when the channel of the slow sidecar is full, send() to the fast sidecar does not block. send()
    // only puts into the channel of the already started process and returns at once, so it must take less than 50 ms.
    let start = std::time::Instant::now();
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-fast",
            "s2",
            &raw(r#"{"data":"test"}"#),
        )
        .unwrap();
    let send_elapsed = start.elapsed();
    assert!(
        send_elapsed < Duration::from_millis(50),
        "fast send took {:?}, want < 50ms",
        send_elapsed
    );

    // Property 2: stop() keeps stop_timeout (100 ms). Asserting with a 200 ms deadline distinguishes it clearly from
    // the default 5 seconds. The earlier code measured send and stop together and asserted 110 ms, which was the
    // unreasonable claim that "the OS kills and reaps the process in 10 ms or less".
    let start = std::time::Instant::now();
    sidecars.stop();
    let stop_elapsed = start.elapsed();
    assert!(
        stop_elapsed < Duration::from_millis(200),
        "stop() took {:?}, want < 200ms (2 × stop_timeout)",
        stop_elapsed
    );
}

// contract: sidecars.stop.graceful-on-stdin-eof
#[test]
fn stop_graceful_shutdown() {
    // Verifies that, when the sidecar actually reads stdin, stop() ends normally by stdin EOF. The measurement starts
    // after the sidecar received the echo of send, and checks that it ends at once without waiting for the deadline (1
    // second).

    let directory = tempfile::tempdir().unwrap();

    // The sidecar: it echoes the received line as it is and ends normally at stdin EOF.
    let graceful_program = directory.path().join("graceful");
    std::fs::write(
        &graceful_program,
        "#!/bin/sh\nwhile read line; do echo \"$line\"; done\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&graceful_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let files: Files = vec![(
        "@fixture/sidecar-graceful",
        r#"{"executable":"graceful","protocol":1}"#.to_string(),
    )];

    let mut sidecars = create(&files, directory.path()).unwrap();
    // stop() ends by force only after the deadline passes. If it returns before the deadline, the sidecar ended by
    // itself at stdin EOF. The deadline is set to STALL, which is sufficiently longer than the process end time on a
    // loaded machine.
    sidecars.stop_timeout = STALL;
    let (owner, events) = owner("a", "/projects/test");

    // Start the sidecar.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-graceful",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();

    // Check that the sidecar actually reads stdin: wait for the echo event. In this way the start time of the shell
    // process is not included in the measurement.
    let event = events
        .recv_timeout(STALL)
        .expect("no echo event; the test stalled");
    assert_eq!(
        (event.sidecar.as_str(), event.surface.as_str()),
        ("@fixture/sidecar-graceful", "s1")
    );

    // Now measure the time of the stop() call. It must end normally at stdin EOF.
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();

    assert!(
        elapsed < sidecars.stop_timeout,
        "graceful stop took {:?}, which reached the {:?} deadline",
        elapsed,
        sidecars.stop_timeout
    );
}

// contract: sidecars.stop.closes-unread-output
#[test]
fn stop_closes_unread_output() {
    // Verifies that the protocol failure while stopping is written to the log and the host closes the read end of the
    // output that it no longer reads, so that a sidecar that writes more than the following pipe holds also ends
    // without a forced kill. The output is the close response for a surface that the host did not close. The end of
    // that process is caused by the closed pipe, so it is not reported.
    let Some(stderr) = logged_by_child("stop_closes_unread_output") else {
        records::capturing(stop_closes_unread_output_in_child);
        return;
    };
    let want =
        "error host sidecar @fixture/sidecar-talkative: failed: unexpected close answer for s1\n";
    assert!(
        stderr.contains(want),
        "log {stderr:?} does not contain {want:?}"
    );
    assert!(
        !stderr.contains("exited while stopping"),
        "log {stderr:?} reports the exit that the closed pipe caused"
    );
}

fn stop_closes_unread_output_in_child() {
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("talkative");
    std::fs::write(
        &program,
        "#!/bin/sh\nwhile read line; do echo \"$line\"; done\n\
         i=0\nwhile [ $i -lt 3000 ]; do echo '{\"surface\":\"s1\",\"closed\":true}'; i=$((i+1)); done\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let files: Files = vec![(
        "@fixture/sidecar-talkative",
        r#"{"executable":"talkative","protocol":1}"#.to_string(),
    )];
    let mut sidecars = create(&files, directory.path()).unwrap();
    // stop() ends by force only after the deadline passes. If it returns before the deadline, the sidecar wrote all of
    // its output and ended by itself.
    sidecars.stop_timeout = STALL;
    let (owner, events) = owner("a", "/projects/test");
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-talkative",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();
    let event = events
        .recv_timeout(STALL)
        .expect("no echo event; the test stalled");
    assert_eq!(event.surface, "s1");
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();
    assert!(
        elapsed < sidecars.stop_timeout,
        "stop took {elapsed:?} and reached the {:?} deadline: the host left the unread output open",
        sidecars.stop_timeout
    );
}

// contract: sidecars.stop.reads-output-to-end
#[test]
fn stop_reads_output_to_its_end() {
    // Verifies that the host reads the output to its end while stopping. The sidecar answers a close that it received
    // before the stop only after its input ended, then writes more than the pipe holds, and records finished only when
    // all writes succeeded. This is the same as the order in which the files sidecar answers the closed that the window
    // close sends when the application ends.
    let Some(stderr) = logged_by_child("stop_reads_output_to_its_end") else {
        records::capturing(|| {
            let (mut sidecars, directory) = script_sidecars(
                "#!/bin/sh\nclosed=\nwhile read line; do case \"$line\" in *'\"closed\":true'*) closed=1;; *) echo \"$line\";; esac; done\n\
             [ -n \"$closed\" ] || exit 4\necho '{\"surface\":\"s1\",\"closed\":true}' || exit 5\n\
             i=0\nwhile [ $i -lt 3000 ]; do echo '{\"surface\":\"s1\",\"body\":\"late\"}' || exit 5; i=$((i+1)); done\n\
             echo finished > DIR/finished\nexit 0\n",
            );
            sidecars.0.stop_timeout = STALL;
            let (window, events) = owner("a", "/projects/test");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                .unwrap();
            let event = events
                .recv_timeout(STALL)
                .expect("no echo event; the test stalled");
            assert_eq!(event.surface, "s1");
            sidecars.retain(&window, &|_| false).unwrap();
            let start = std::time::Instant::now();
            sidecars.stop();
            let elapsed = start.elapsed();
            assert!(
                elapsed < sidecars.stop_timeout,
                "stop took {elapsed:?} and reached the {:?} deadline",
                sidecars.stop_timeout
            );
            let finished = std::fs::read_to_string(directory.path().join("finished"));
            assert!(
                matches!(&finished, Ok(text) if text == "finished\n"),
                "the sidecar did not complete its writes on its way out: finished = {finished:?}"
            );
        });
        return;
    };
    assert!(
        !stderr.contains("error host "),
        "stop logged an error: {stderr:?}"
    );
}

// contract: sidecars.stop.reports-exit-status
#[test]
fn stop_reports_exit_status() {
    // Verifies that a sidecar that ended with a nonzero exit status or a signal while stopping is written to the log in
    // the same format by both hosts.
    let Some(stderr) = logged_by_child("stop_reports_exit_status") else {
        records::capturing(|| {
            for ending in ["exit 3", "kill -TERM $$"] {
                let (mut sidecars, _directory) = script_sidecars(&format!(
                    "#!/bin/sh\nwhile read line; do echo \"$line\"; done\n{ending}\n"
                ));
                sidecars.0.stop_timeout = STALL;
                let (window, events) = owner("a", "/projects/test");
                sidecars
                    .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                    .unwrap();
                let event = events
                    .recv_timeout(STALL)
                    .expect("no echo event; the test stalled");
                assert_eq!(event.surface, "s1");
                sidecars.stop();
            }
        });
        return;
    };
    for want in [
        "error host sidecar @fixture/sidecar-echo: exited while stopping: exit status 3\n",
        "error host sidecar @fixture/sidecar-echo: exited while stopping: signal 15\n",
    ] {
        assert!(
            stderr.contains(want),
            "log {stderr:?} does not contain {want:?}"
        );
    }
}

// contract: sidecars.stderr.lines-are-written-as-records
#[test]
fn the_standard_error_of_a_sidecar_is_written_as_records() {
    // A sidecar of standard input and output may write any text to its standard error: the host writes each line as a
    // record of level info, layer sidecar and the name of the sidecar, and the last text without a line feed too.
    let Some(stderr) = logged_by_child("the_standard_error_of_a_sidecar_is_written_as_records")
    else {
        records::capturing(|| {
            let (mut sidecars, _directory) = script_sidecars(
                "#!/bin/sh\necho 'first line' >&2\nprintf 'no line feed' >&2\nwhile read line; do echo \"$line\"; done\n",
            );
            sidecars.0.stop_timeout = STALL;
            let (window, events) = owner("a", "/projects/test");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                .unwrap();
            let event = events
                .recv_timeout(STALL)
                .expect("no echo event; the test stalled");
            assert_eq!(event.surface, "s1");
            sidecars.stop();
            // The reader of the standard error ends with the process; let it write its last record.
            std::thread::sleep(Duration::from_millis(200));
        });
        return;
    };
    for want in [
        " info sidecar @fixture/sidecar-echo: first line\n",
        " info sidecar @fixture/sidecar-echo: no line feed\n",
    ] {
        assert!(
            stderr.contains(want),
            "log {stderr:?} does not contain {want:?}"
        );
    }
}

// contract: sidecars.trace.relay-records-every-message-with-its-body
#[test]
fn the_relay_records_every_message_with_its_whole_body() {
    // The switch of the trace belongs to the process, so the check runs in a child process that nothing else shares it with.
    if std::env::var_os("SOKSAK_RELAY_TRACE_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "the_relay_records_every_message_with_its_whole_body",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("SOKSAK_RELAY_TRACE_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "the child check failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    // Every request that the host sends to a sidecar and every message that it receives is a trace event with its whole
    // body, in the order of the relay (docs/spec/diagnostics.md).
    let (mut sidecars, directory) = script_sidecars(
        "#!/bin/sh\nread request\necho '{\"surface\":\"s1\",\"body\":{\"event\":\"state\",\"text\":\"\\ud55c\"}}'\nwhile read line; do :; done\n",
    );
    sidecars.0.stop_timeout = STALL;
    let events_directory = tempfile::tempdir().unwrap();
    let writer = records::start_writer(events_directory.path());
    let _ = &directory;
    soksak_host_tauriv2::performance::command(serde_json::json!({"action": "on"})).unwrap();
    let (window, events) = owner("a", "/projects/test");
    sidecars
        .send(
            &window,
            ECHO,
            "s1",
            &raw(r#"{"operation":"input","bytes":"7ZWc"}"#),
        )
        .unwrap();
    let event = events
        .recv_timeout(STALL)
        .expect("no event; the test stalled");
    assert_eq!(event.surface, "s1");
    sidecars.stop();
    writer.flush(STALL).unwrap();
    let records_of_the_run = records::read_events(writer.path());
    soksak_host_tauriv2::event_record::use_host_event_log(None);
    let find = |name: &str| {
        records_of_the_run
            .iter()
            .find(|record| record["event"] == name)
            .cloned()
    };
    let sent = find("host.trace.sidecar.send").expect("the request was not recorded");
    assert_eq!(sent["layer"], "host");
    assert_eq!(sent["fields"]["sidecar"], ECHO);
    assert_eq!(sent["fields"]["surface"], "s1");
    assert_eq!(sent["fields"]["body"]["operation"], "input");
    assert_eq!(sent["fields"]["body"]["bytes"], "7ZWc");
    let received = find("host.trace.sidecar.receive").expect("the message was not recorded");
    assert_eq!(received["fields"]["surface"], "s1");
    assert_eq!(received["fields"]["body"]["event"], "state");
    assert_eq!(received["fields"]["body"]["text"], "한");
}

// contract: sidecars.stop.forgets-running-sidecars
#[test]
fn close_during_stop_sends_nothing() {
    // Verifies that, after stop ended the input and before the process ended, the surface close and the window close
    // send nothing. When the application ends, the windows close together with stop and close their surfaces.
    use std::io::{BufRead, Write};
    let directory = tempfile::tempdir().unwrap();
    // The sidecar: at the start it opens ended and release for writing and reading. It echoes the received line, and
    // when the input ends it writes one line to ended and stays alive until one line arrives in release. The sidecar
    // keeps both pipes open, so the line it wrote is not discarded and the side that opens them is not blocked.
    let ended = directory.path().join("ended");
    let release = directory.path().join("release");
    for fifo in [&ended, &release] {
        let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(
            unsafe { libc::mkfifo(path.as_ptr(), 0o600) },
            0,
            "mkfifo {}",
            fifo.display()
        );
    }
    let program = directory.path().join("lingering");
    std::fs::write(
        &program,
        format!(
            "#!/bin/sh\nexec 3<>{} 4<>{}\nwhile read line; do echo \"$line\"; done\n\
             echo ended >&4\nread -r released <&3\nexit 0\n",
            release.display(),
            ended.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Writes one line to release so that no sidecar remains even if the check ends midway.
    struct Release(std::path::PathBuf);
    impl Drop for Release {
        fn drop(&mut self) {
            let mut fifo = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&self.0)
                .expect("open release");
            fifo.write_all(b"x\n").expect("write release");
        }
    }
    let release = Release(release);
    let files: Files = vec![(
        "@fixture/sidecar-lingering",
        r#"{"executable":"lingering","protocol":1}"#.to_string(),
    )];
    let mut sidecars = create(&files, directory.path()).unwrap();
    sidecars.stop_timeout = STALL;
    let (owner, events) = owner("a", "/projects/test");
    for surface in ["s1", "s2"] {
        sidecars
            .send(
                &owner,
                "@fixture/sidecar-lingering",
                surface,
                &raw(r#"{"test":"data"}"#),
            )
            .unwrap();
        let event = events
            .recv_timeout(STALL)
            .expect("no echo event; the test stalled");
        assert_eq!(event.surface, surface);
    }

    std::thread::scope(|scope| {
        let stopping = scope.spawn(|| sidecars.stop());
        // When the sidecar writes to ended, stop has ended the input and the process is still running.
        let mut line = String::new();
        std::io::BufReader::new(std::fs::File::open(&ended).expect("open ended"))
            .read_line(&mut line)
            .expect("read ended");
        assert_eq!(line, "ended\n");
        sidecars.retain(&owner, &|surface| surface != "s1").unwrap();
        sidecars.retain(&owner, &|_| false).unwrap();
        assert_eq!(
            sidecars.closing(),
            Vec::<ClosingSurface>::new(),
            "closing during stop"
        );
        drop(release);
        stopping.join().expect("stop thread");
    });
}

// contract: sidecars.stop.kills-after-timeout
#[test]
fn stop_forced_kill() {
    // Verifies that a sidecar that does not end after the deadline is killed and that kill is written to the log.
    let Some(stderr) = logged_by_child("stop_forced_kill") else {
        records::capturing(stop_forced_kill_in_child);
        return;
    };
    let want = "error host sidecar @fixture/sidecar-stubborn: did not end within the stop timeout and was killed\n";
    assert!(
        stderr.contains(want),
        "log {stderr:?} does not contain {want:?}"
    );
    assert!(
        !stderr.contains("exited while stopping"),
        "log {stderr:?} reports the exit that the kill caused"
    );
}

fn stop_forced_kill_in_child() {
    let directory = tempfile::tempdir().unwrap();

    // The sidecar: it does not read stdin, so it keeps running after stdin EOF. The stdin of a background command can
    // become /dev/null depending on the shell and end at once, so it is not used.
    let stubborn_program = directory.path().join("stubborn");
    std::fs::write(&stubborn_program, "#!/bin/sh\nexec sleep 600\n").unwrap();
    std::fs::set_permissions(&stubborn_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let files: Files = vec![(
        "@fixture/sidecar-stubborn",
        r#"{"executable":"stubborn","protocol":1}"#.to_string(),
    )];

    let mut sidecars = create(&files, directory.path()).unwrap();
    // The deadline is set to 100 ms for the test.
    sidecars.stop_timeout = Duration::from_millis(100);
    let (owner, _events) = owner("a", "/projects/test");

    // Start the sidecar.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-stubborn",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();

    // Call stop(). It must be killed after the deadline.
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();

    // stop() kills after it waited for the deadline. If it returns before the deadline, it did not wait, and the upper
    // limit catches only a stop. The time for the process to end after the kill grows with the load, so success is not
    // decided by the upper limit.
    assert!(
        elapsed >= sidecars.stop_timeout && elapsed <= STALL,
        "forced kill stop took {:?}, want at least the {:?} deadline",
        elapsed,
        sidecars.stop_timeout
    );
}

/// The log is the standard error, so a check that asserts the log runs the same check in a child process and reads its
/// output. In the child process it returns None and the check runs the sidecar. In the parent process it runs the check
/// of the test name as a child and returns the standard error when that check passed.
fn logged_by_child(test: &str) -> Option<String> {
    if std::env::var_os("SOKSAK_SIDECAR_LOG_CHILD").is_some() {
        return None;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("SOKSAK_SIDECAR_LOG_CHILD", "1")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(output.status.success(), "the child check failed: {stderr}");
    Some(stderr)
}

/// The maximum size of one sidecar message line before the line feed (docs/spec/sidecars.md#messages).
const MESSAGE_LIMIT: usize = 64 << 20;

/// Ends the sidecar in drop so that no fake sidecar process remains even if the check ends or fails.
struct Stopping(Sidecars<FakeOwner>);

impl std::ops::Deref for Stopping {
    type Target = Sidecars<FakeOwner>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for Stopping {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// Creates a channel that declares a fake sidecar running script, and its directory. DIR in script is replaced with
/// that directory.
fn script_sidecars(script: &str) -> (Stopping, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("fake");
    std::fs::write(
        &program,
        script.replace("DIR", &directory.path().display().to_string()),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sidecars = create(
        &files(r#"{"executable":"fake","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    (Stopping(sidecars), directory)
}

/// A script that reads one request, sends an s1 message of size bytes before the line feed, and runs then, and the
/// number of characters of the body. The body is one string and a shell pipeline writes it, so the script process waits
/// until the write ends.
fn padded_message_script(size: usize, then: &str) -> (String, usize) {
    let (prefix, suffix) = (r#"{"surface":"s1","body":""#, r#""}"#);
    let padding = size - prefix.len() - suffix.len();
    (
        format!(
            "#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%s' '{prefix}'\nhead -c {padding} /dev/zero | tr '\\0' x\nprintf '%s\\n' '{suffix}'\n{then}\n"
        ),
        padding,
    )
}

/// The process id that the fake sidecar recorded.
fn process_id(directory: &Path) -> i32 {
    std::fs::read_to_string(directory.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// Checks that the process pid ended and was reaped.
fn assert_ended(pid: i32) {
    // SAFETY: signal 0 only checks the existence of the process and sends no signal.
    let result = unsafe { libc::kill(pid, 0) };
    let error = std::io::Error::last_os_error();
    assert!(
        result == -1 && error.raw_os_error() == Some(libc::ESRCH),
        "sidecar process {pid} still exists after its failure: kill(0) = {result}, {error}"
    );
}

// contract: sidecars.protocol.message-at-limit-is-delivered
#[test]
fn a_message_at_the_limit_is_delivered() {
    let (script, padding) = padded_message_script(MESSAGE_LIMIT, "exec cat");
    let (sidecars, _directory) = script_sidecars(&script);
    let (window, events, failures) = failing_owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let event = events
        .recv_timeout(STALL)
        .expect("no sidecar event; the test stalled");
    let body = event.body.get();
    assert_eq!(event.surface, "s1");
    assert_eq!(body.len(), padding + 2, "body length");
    assert!(
        body.starts_with('"')
            && body.ends_with('"')
            && body[1..body.len() - 1].bytes().all(|b| b == b'x'),
        "message at the limit was changed"
    );
    assert!(
        failures.try_recv().is_err(),
        "message at the limit produced a failure"
    );
}

// contract: sidecars.failure.oversize-message-terminates-and-notifies
#[test]
fn an_oversize_message_terminates_and_notifies() {
    let (script, _) = padded_message_script(MESSAGE_LIMIT + 1, "exec sleep 600");
    let (sidecars, directory) = script_sidecars(&script);
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let failure = failures
        .recv_timeout(STALL)
        .expect("no sidecar failure; the test stalled");
    assert_eq!(
        (failure.sidecar.as_str(), failure.surface.as_str()),
        (ECHO, "s1")
    );
    assert!(
        failure.reason.contains("exceeds 67108864 bytes"),
        "{failure:?}"
    );
    assert_ended(process_id(directory.path()));
}

// contract: sidecars.failure.invalid-message-terminates-and-notifies
#[test]
fn an_invalid_message_terminates_and_notifies() {
    for line in ["not json", r#"{"surface":"s1"}"#] {
        let (sidecars, directory) = script_sidecars(&format!(
            "#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%s\\n' '{line}'\nexec sleep 600\n"
        ));
        let (window, _events, failures) = failing_owner("a", "/projects/a");
        sidecars
            .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        let failure = failures
            .recv_timeout(STALL)
            .unwrap_or_else(|_| panic!("{line}: no sidecar failure; the test stalled"));
        assert_eq!(
            (failure.sidecar.as_str(), failure.surface.as_str()),
            (ECHO, "s1")
        );
        assert!(
            failure.reason.contains("invalid message"),
            "{line}: {failure:?}"
        );
        assert_ended(process_id(directory.path()));
    }
}

// contract: sidecars.failure.output-close-notifies-each-surface
#[test]
fn an_output_close_notifies_each_surface() {
    let (sidecars, directory) =
        script_sidecars("#!/bin/sh\necho $$ >> DIR/pids\nread first\nread second\nexit 3\n");
    let (first, _first_events, first_failures) = failing_owner("a", "/projects/a");
    let (second, _second_events, second_failures) = failing_owner("b", "/projects/b");
    sidecars
        .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars
        .send(&second, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    for (surface, failures) in [("s1", &first_failures), ("s2", &second_failures)] {
        let failure = failures
            .recv_timeout(STALL)
            .unwrap_or_else(|_| panic!("{surface}: no sidecar failure; the test stalled"));
        assert_eq!(
            (failure.sidecar.as_str(), failure.surface.as_str()),
            (ECHO, surface)
        );
        assert_eq!(
            failure.reason, "output closed: exit status 3",
            "{surface}: {failure:?}"
        );
    }
    // A send after a failure starts a new process.
    sidecars
        .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars.stop();
    assert!(
        first_failures.try_recv().is_err(),
        "output end while stopping produced a failure"
    );
    let pids = std::fs::read_to_string(directory.path().join("pids")).unwrap();
    let pids: Vec<&str> = pids.split_whitespace().collect();
    assert!(
        pids.len() == 2 && pids[0] != pids[1],
        "sidecar processes = {pids:?}, want two distinct processes"
    );
}

// contract: sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail
#[test]
fn closed_surface_messages_are_discarded_and_unknown_ones_fail() {
    let (sidecars, directory) = script_sidecars(
        "#!/bin/sh\necho $$ > DIR/pid\nread open1\nread open2\nread closed2\nprintf '%s\\n' '{\"surface\":\"s2\",\"body\":\"late\"}' '{\"surface\":\"s1\",\"body\":\"after\"}' '{\"surface\":\"ghost\",\"body\":\"x\"}'\nexec sleep 600\n",
    );
    let (window, events, failures) = failing_owner("a", "/projects/a");
    for surface in ["s1", "s2"] {
        sidecars
            .send(&window, ECHO, surface, &raw(r#"{"operation":"open"}"#))
            .unwrap();
    }
    // The surface synchronization closes the removed s2.
    sidecars
        .retain(&window, &|surface| surface != "s2")
        .unwrap();
    // The late message of s2 is discarded, and the s1 message after it is the first event.
    let event = events
        .recv_timeout(STALL)
        .expect("no sidecar event; the test stalled");
    assert_eq!(
        (event.surface.as_str(), event.body.get()),
        ("s1", r#""after""#)
    );
    let failure = failures
        .recv_timeout(STALL)
        .expect("no sidecar failure; the test stalled");
    assert_eq!(
        (
            failure.sidecar.as_str(),
            failure.surface.as_str(),
            failure.reason.as_str()
        ),
        (ECHO, "s1", "unknown surface ghost")
    );
    assert_ended(process_id(directory.path()));
}

/// The sidecar @fixture/sidecar-echo that runs script, and the channel that receives the value whenever closing
/// changes.
fn closing_sidecars(
    script: &str,
) -> (
    std::sync::Arc<Sidecars<FakeOwner>>,
    Receiver<Vec<ClosingSurface>>,
    tempfile::TempDir,
) {
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("closing");
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let files: Files = vec![(ECHO, r#"{"executable":"closing","protocol":1}"#.to_string())];
    let sidecars = std::sync::Arc::new(create(&files, directory.path()).unwrap());
    let (snapshot, snapshots) = channel();
    let observed = std::sync::Arc::downgrade(&sidecars);
    sidecars.on_closing_changed(move || {
        if let Some(sidecars) = observed.upgrade() {
            let _ = snapshot.send(sidecars.closing());
        }
    });
    (sidecars, snapshots, directory)
}

fn closing_of(surface: &str) -> Vec<ClosingSurface> {
    vec![ClosingSurface {
        sidecar: ECHO.to_string(),
        surface: surface.to_string(),
    }]
}

// contract: sidecars.close.answer-ends-closing
#[test]
fn closed_surface_stays_closing_until_the_sidecar_answers() {
    // It returns the received line as it is. If it returns a closed line, that is the answer to closed.
    let (sidecars, snapshots, _directory) = closing_sidecars("#!/bin/sh\ntee /dev/null\n");
    let (window, _events) = owner("a", "/projects/closing");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    sidecars.retain(&window, &|_| false).unwrap();
    assert_eq!(snapshots.recv_timeout(STALL).unwrap(), closing_of("s1"));
    assert_eq!(snapshots.recv_timeout(STALL).unwrap(), vec![]);
    sidecars.stop();
}

// contract: sidecars.close.failed-answer-is-logged
#[test]
fn failed_close_answer_is_logged() {
    // The log is the standard error, so the same check runs in a child process and its output is read.
    if std::env::var_os("SOKSAK_CLOSE_LOG_CHILD").is_some() {
        records::capturing(|| {
            let script = "#!/bin/sh\nwhile read line; do case \"$line\" in *closed*) printf '{\"surface\":\"s1\",\"closed\":true,\"error\":\"busy\"}\\n';; *) echo \"$line\";; esac; done\n";
            let (sidecars, snapshots, _directory) = closing_sidecars(script);
            let (window, _events) = owner("a", "/projects/closing");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
                .unwrap();
            sidecars.retain(&window, &|_| false).unwrap();
            assert_eq!(snapshots.recv_timeout(STALL).unwrap(), closing_of("s1"));
            assert_eq!(snapshots.recv_timeout(STALL).unwrap(), vec![]);
            sidecars.stop();
        });
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "failed_close_answer_is_logged", "--nocapture"])
        .env("SOKSAK_CLOSE_LOG_CHILD", "1")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "the child check failed: {stderr}");
    assert!(
        stderr.contains("error host sidecar @fixture/sidecar-echo: close s1: busy\n"),
        "the failed close was not logged: {stderr}"
    );
}

// contract: sidecars.declaration.replaces-changed-folder
#[test]
fn declaration_replaces_a_sidecar_whose_folder_changed() {
    // Each folder holds a sidecar that answers every request with the name of its folder.
    let root = tempfile::tempdir().unwrap();
    let folder = |name: &str| {
        let directory = root.path().join(name);
        std::fs::create_dir_all(&directory).unwrap();
        let program = directory.join("answer");
        let script = format!(
            "#!/bin/sh\nwhile read line; do printf '{{\"surface\":\"s1\",\"body\":{{\"from\":\"{name}\"}}}}\\n'; done\n"
        );
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        directory
    };
    let files: Files = vec![(ECHO, r#"{"executable":"answer","protocol":1}"#.to_string())];
    let (first, second) = (folder("first"), folder("second"));
    let sidecars = create(&files, &first).unwrap();
    let (window, messages, failures) = failing_owner("a", "/projects/replace");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    assert_eq!(
        messages.recv_timeout(STALL).unwrap().body.get(),
        r#"{"from":"first"}"#
    );
    sidecars.declare(&declare(&files, &second)).unwrap();
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":2}"#))
        .unwrap();
    assert_eq!(
        messages.recv_timeout(STALL).unwrap().body.get(),
        r#"{"from":"second"}"#,
        "the answer after the folder changed did not come from the sidecar of the new folder"
    );
    assert!(
        failures.try_recv().is_err(),
        "replacing the sidecar reported a failure"
    );
    sidecars.stop();
}

// contract: sidecars.close.repeated-close-awaits-each-answer
#[test]
fn repeated_close_awaits_each_answer() {
    // The log is standard error, so the same check runs as a child process and its output is read.
    if std::env::var_os("SOKSAK_REPEATED_CLOSE_CHILD").is_some() {
        // The sidecar echoes requests and answers both closes of s1 after it has received the second one.
        let script = "#!/bin/sh\nn=0\nwhile read line; do case \"$line\" in *closed*) n=$((n+1)); if [ $n -eq 2 ]; then printf '{\"surface\":\"s1\",\"closed\":true}\\n{\"surface\":\"s1\",\"closed\":true}\\n'; fi;; *) echo \"$line\";; esac; done\n";
        let (sidecars, snapshots, _directory) = closing_sidecars(script);
        let (window, events) = owner("a", "/projects/closing");
        for _ in 0..2 {
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
                .unwrap();
            events.recv_timeout(STALL).unwrap();
            sidecars.retain(&window, &|_| false).unwrap();
            assert_eq!(snapshots.recv_timeout(STALL).unwrap(), closing_of("s1"));
        }
        while !snapshots.recv_timeout(STALL).unwrap().is_empty() {}
        // The echo of a later request follows both answers in the output, so a failure of either answer is logged first.
        sidecars
            .send(&window, ECHO, "s2", &raw(r#"{"data":2}"#))
            .unwrap();
        events.recv_timeout(STALL).unwrap();
        sidecars.stop();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "repeated_close_awaits_each_answer",
            "--nocapture",
        ])
        .env("SOKSAK_REPEATED_CLOSE_CHILD", "1")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "the child check failed: {stderr}");
    assert!(
        !stderr.contains("failed"),
        "the second answer of a repeated close failed the sidecar: {stderr}"
    );
}

// contract: sidecars.close.unexpected-answer-fails
#[test]
fn close_answer_for_an_open_surface_fails_the_sidecar() {
    let (sidecars, _snapshots, _directory) = closing_sidecars(
        "#!/bin/sh\nread line\nprintf '{\"surface\":\"s1\",\"closed\":true}\\n'\nexec cat >/dev/null\n",
    );
    let (window, _events, failures) = failing_owner("a", "/projects/closing");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    let failure = failures.recv_timeout(STALL).unwrap();
    assert_eq!(failure.reason, "unexpected close answer for s1");
    sidecars.stop();
}

// contract: sidecars.close.process-end-clears-closing
#[test]
fn ended_sidecar_leaves_no_closing_surface() {
    // It answers the first request, and when it receives closed it ends without answering.
    let (sidecars, snapshots, _directory) =
        closing_sidecars("#!/bin/sh\nread line\necho \"$line\"\nread line\nexit 0\n");
    let (window, _events) = owner("a", "/projects/closing");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    sidecars.retain(&window, &|_| false).unwrap();
    assert_eq!(snapshots.recv_timeout(STALL).unwrap(), closing_of("s1"));
    assert_eq!(snapshots.recv_timeout(STALL).unwrap(), vec![]);
    sidecars.stop();
}

const DROPPED_LOG_CHILD: &str = "SOKSAK_DROPPED_LOG_CHILD";

// A message of a surface that no window owns is discarded and recorded with its body.
// contract: sidecars.protocol.dropped-message-is-recorded
#[test]
fn a_dropped_sidecar_message_is_recorded() {
    if let Some(config) = std::env::var_os(DROPPED_LOG_CHILD) {
        soksak_host_tauriv2::application_log::start_standard_error(
            std::path::Path::new(&config),
            "com.soksak.test",
        )
        .unwrap();
        let writer = records::start_writer(std::path::Path::new(&config));
        let (sidecars, _directory) = script_sidecars(
            "#!/bin/sh\nread open1\nread open2\nread closed2\nprintf '%s\\n' '{\"surface\":\"s2\",\"body\":\"late\"}' '{\"surface\":\"s1\",\"body\":\"after\"}'\nexec sleep 600\n",
        );
        let (window, events, _failures) = failing_owner("a", "/projects/a");
        for surface in ["s1", "s2"] {
            sidecars
                .send(&window, ECHO, surface, &raw(r#"{"operation":"open"}"#))
                .unwrap();
        }
        sidecars
            .retain(&window, &|surface| surface != "s2")
            .unwrap();
        // The message of s1 follows the discarded one, so the record of s2 is written when it arrives.
        let event = events
            .recv_timeout(STALL)
            .expect("no sidecar event; the test stalled");
        assert_eq!(event.surface, "s1");
        writer.flush(STALL).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_dropped_sidecar_message_is_recorded",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(DROPPED_LOG_CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child ended with {:?}, output {:?}",
        output.status,
        String::from_utf8_lossy(&output.stdout)
    );
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    let want = format!(
        " info host sidecar {ECHO}: message for surface s2 dropped: no window owns the surface: \"late\""
    );
    assert!(log.contains(&want), "no {want:?} in {log}");
}

// contract: sidecars.lifetime.start-and-exit-events
#[test]
fn the_lifetime_of_a_sidecar_is_recorded_as_events() {
    // The writer of the records is shared by the process, so the scenario runs in a child process that nothing else writes in.
    if let Some(config) = std::env::var_os("SOKSAK_LIFETIME_CHILD") {
        // The first process ends by itself with a status; the second ends when the host stops it.
        let (mut sidecars, _directory) = script_sidecars(
            "#!/bin/sh\nif [ ! -f DIR/ran ]; then touch DIR/ran; read first; exit 3; fi\ncat >/dev/null\n",
        );
        sidecars.0.stop_timeout = STALL;
        let writer = records::start_writer(Path::new(&config));
        let (first, _first_events, failures) = failing_owner("a", "/projects/a");
        sidecars
            .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        failures
            .recv_timeout(STALL)
            .expect("no sidecar failure; the test stalled");
        sidecars
            .send(&first, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        sidecars.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_lifetime_of_a_sidecar_is_recorded_as_events",
            "--nocapture",
        ])
        .env("SOKSAK_LIFETIME_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut pids = std::collections::BTreeSet::new();
    let seen: Vec<(String, String)> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| {
            matches!(
                event["event"].as_str(),
                Some("host.sidecar.start" | "host.sidecar.exit")
            )
        })
        .map(|event| {
            assert_eq!(event["fields"]["name"], ECHO);
            pids.insert(event["fields"]["pid"].as_u64().unwrap());
            (
                event["event"].as_str().unwrap().to_string(),
                event["fields"]["status"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            ("host.sidecar.start".to_string(), String::new()),
            ("host.sidecar.exit".to_string(), "exit status 3".to_string()),
            ("host.sidecar.start".to_string(), String::new()),
            ("host.sidecar.exit".to_string(), "exit status 0".to_string()),
        ]
    );
    assert_eq!(pids.len(), 2, "processes {pids:?}");
}

// contract: performance.sampler.names-the-sidecar-processes
#[test]
fn the_sampler_names_a_running_sidecar_until_it_ends() {
    // The writer of the records and the trace switch belong to the process, so the scenario runs in a child process.
    if let Some(config) = std::env::var_os("SOKSAK_SAMPLER_CHILD") {
        let (mut sidecars, _directory) = script_sidecars("#!/bin/sh\ncat >/dev/null\n");
        sidecars.0.stop_timeout = STALL;
        let writer = records::start_writer(Path::new(&config));
        soksak_host_tauriv2::performance::command(serde_json::json!({"action": "on"})).unwrap();
        records::wait_for_first_sample(Path::new(&config), &writer);
        let (owner, _events) = owner("a", "/projects/a");
        sidecars
            .send(&owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        soksak_host_tauriv2::performance::sample();
        sidecars.stop();
        soksak_host_tauriv2::performance::sample();
        soksak_host_tauriv2::performance::command(serde_json::json!({"action": "off"})).unwrap();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_sampler_names_a_running_sidecar_until_it_ends",
            "--nocapture",
        ])
        .env("SOKSAK_SAMPLER_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The periodic sampler of the trace runs besides the two samples of the child, so under load a third sample can fall
    // while the sidecar runs. The order of the records states the contract: a sample names the sidecar while it runs, and
    // no sample names it after its exit record.
    let events = records::read_events(&records::event_log_path(config.path()));
    let exit = events
        .iter()
        .position(|event| event["event"] == "host.sidecar.exit" && event["fields"]["name"] == ECHO)
        .expect("the sidecar has an exit record");
    let named: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event["event"] == "host.sampler.memory" && event["fields"]["name"] == ECHO
        })
        .map(|(index, _)| index)
        .collect();
    assert!(!named.is_empty(), "no sample names the running sidecar");
    assert!(
        named.iter().all(|index| *index < exit),
        "a sample names the sidecar after it ended: samples at {named:?}, exit at {exit}"
    );
}

// contract: sidecars.protocol.request-with-cids-is-recorded
#[test]
fn a_request_with_cids_is_recorded_as_an_event() {
    // The writer of the records is shared by the process, so the scenario runs in a child process that nothing else writes in.
    if let Some(config) = std::env::var_os("SOKSAK_REQUEST_CHILD") {
        let (mut sidecars, _directory) = script_sidecars("#!/bin/sh\ncat >/dev/null\n");
        sidecars.0.stop_timeout = STALL;
        let writer = records::start_writer(Path::new(&config));
        let (window, _events) = owner("a", "/projects/a");
        sidecars
            .send_with_cids(
                &window,
                ECHO,
                "s1",
                &raw(r#"{"operation":"input"}"#),
                &["b1.7".to_string(), "b1.8".to_string()],
            )
            .unwrap();
        sidecars
            .send(&window, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
            .unwrap();
        sidecars.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_request_with_cids_is_recorded_as_an_event",
            "--nocapture",
        ])
        .env("SOKSAK_REQUEST_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let requests: Vec<serde_json::Value> =
        records::read_events(&records::event_log_path(config.path()))
            .into_iter()
            .filter(|event| event["event"] == "host.sidecar.request")
            .collect();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0]["level"], "info");
    assert_eq!(requests[0]["cids"], serde_json::json!(["b1.7", "b1.8"]));
    assert_eq!(
        requests[0]["fields"],
        serde_json::json!({"name": ECHO, "surface": "s1", "bytes": 21})
    );
}

// contract: sidecars.protocol.request-line-carries-cids
#[test]
fn a_request_carries_the_correlation_identifiers() {
    let (mut sidecars, directory) = script_sidecars("#!/bin/sh\ntee DIR/requests\n");
    sidecars.0.stop_timeout = STALL;
    let (window, events) = owner("a", "/projects/a");
    sidecars
        .send_with_cids(
            &window,
            ECHO,
            "s1",
            &raw(r#"{"operation":"input"}"#),
            &["b1.7".to_string(), "b1.8".to_string()],
        )
        .unwrap();
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
        .unwrap();
    events.recv_timeout(STALL).unwrap();
    events.recv_timeout(STALL).unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        "{\"surface\":\"s1\",\"root\":\"/projects/a\",\"cids\":[\"b1.7\",\"b1.8\"],\"body\":{\"operation\":\"input\"}}\n\
         {\"surface\":\"s1\",\"root\":\"/projects/a\",\"body\":{\"operation\":\"input\"}}\n"
    );
}

/// A script that answers three requests: an error with identifiers, an answer with identifiers, and an error without, and then
/// sends a message that is no reply.
const REPLY_SCRIPT: &str = r#"#!/bin/sh
read a
printf '%s\n' '{"surface":"s1","cids":["b1.7","b1.8"],"body":{"id":1,"error":"unsupported operation"}}'
read b
printf '%s\n' '{"surface":"s1","cids":["b1.9"],"body":{"id":2,"ok":true}}'
read c
printf '%s\n' '{"surface":"s1","body":{"id":3,"error":{"reason":"no request"}}}'
printf '%s\n' '{"surface":"s1","body":{"event":"state"}}'
cat >/dev/null
"#;

/// Runs the scenario `name` of this file in a child process that nothing else writes in, with the configuration folder in the
/// variable `variable`, and returns the output of the child and the events `host.sidecar.reply` that it stored.
fn replies_of_child(name: &str, variable: &str) -> (String, Vec<serde_json::Value>) {
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env(variable, config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.sidecar.reply")
        .collect();
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        replies,
    )
}

// contract: sidecars.protocol.reply-with-cids-is-recorded
#[test]
fn a_reply_of_a_sidecar_is_recorded_with_the_identifiers_of_its_request() {
    // The writer of the records is shared by the process, so the scenario runs in a child process that nothing else writes in.
    if let Some(config) = std::env::var_os("SOKSAK_REPLY_CHILD") {
        let (mut sidecars, _directory) = script_sidecars(REPLY_SCRIPT);
        sidecars.0.stop_timeout = STALL;
        let writer = records::start_writer(Path::new(&config));
        let (window, events) = owner("a", "/projects/a");
        let body = raw(r#"{"operation":"input"}"#);
        sidecars
            .send_with_cids(
                &window,
                ECHO,
                "s1",
                &body,
                &["b1.7".to_string(), "b1.8".to_string()],
            )
            .unwrap();
        events.recv_timeout(STALL).unwrap();
        sidecars
            .send_with_cids(&window, ECHO, "s1", &body, &["b1.9".to_string()])
            .unwrap();
        events.recv_timeout(STALL).unwrap();
        sidecars.send(&window, ECHO, "s1", &body).unwrap();
        events.recv_timeout(STALL).unwrap();
        events.recv_timeout(STALL).unwrap();
        sidecars.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        return;
    }
    let (_, replies) = replies_of_child(
        "a_reply_of_a_sidecar_is_recorded_with_the_identifiers_of_its_request",
        "SOKSAK_REPLY_CHILD",
    );
    assert_eq!(replies.len(), 3, "{replies:?}");
    let want = [
        (
            "warn",
            false,
            Some("-32603: unsupported operation"),
            Some(serde_json::json!(["b1.7", "b1.8"])),
            true,
        ),
        ("info", true, None, Some(serde_json::json!(["b1.9"])), true),
        (
            "warn",
            false,
            Some("-32603: {\"reason\":\"no request\"}"),
            None,
            false,
        ),
    ];
    for (reply, (level, ok, error, cids, micros)) in replies.iter().zip(want) {
        let fields = &reply["fields"];
        assert_eq!(reply["level"], level, "{reply}");
        assert_eq!(fields["name"], ECHO, "{reply}");
        assert_eq!(fields["surface"], "s1", "{reply}");
        assert_eq!(fields["ok"], ok, "{reply}");
        assert_eq!(
            fields.get("error").and_then(|e| e.as_str()),
            error,
            "{reply}"
        );
        assert_eq!(reply.get("cids").cloned(), cids, "{reply}");
        assert_eq!(fields.get("micros").is_some(), micros, "{reply}");
    }
}

// contract: sidecars.protocol.failure-fails-the-pending-requests
#[test]
fn the_failure_of_a_sidecar_is_the_failed_reply_of_its_pending_requests() {
    if let Some(config) = std::env::var_os("SOKSAK_REPLY_FAILURE_CHILD") {
        let (mut sidecars, _directory) =
            script_sidecars("#!/bin/sh\nread first\nread second\nexit 3\n");
        sidecars.0.stop_timeout = STALL;
        let writer = records::start_writer(Path::new(&config));
        let (window, _events, failures) = failing_owner("a", "/projects/a");
        let body = raw(r#"{"operation":"input"}"#);
        sidecars
            .send_with_cids(&window, ECHO, "s1", &body, &["b1.7".to_string()])
            .unwrap();
        sidecars
            .send_with_cids(&window, ECHO, "s1", &body, &["b1.8".to_string()])
            .unwrap();
        let failure = failures.recv_timeout(STALL).unwrap();
        sidecars.stop();
        writer.flush(Duration::from_secs(5)).unwrap();
        // The parent reads the reason from the output of the child.
        println!("reason: {}", failure.reason);
        return;
    }
    let (stdout, replies) = replies_of_child(
        "the_failure_of_a_sidecar_is_the_failed_reply_of_its_pending_requests",
        "SOKSAK_REPLY_FAILURE_CHILD",
    );
    let reason = stdout
        .lines()
        .find_map(|line| line.strip_prefix("reason: "))
        .expect("the child printed the reason of the failure");
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert_eq!(replies[0]["level"], "warn");
    assert_eq!(replies[0]["cids"], serde_json::json!(["b1.7", "b1.8"]));
    assert_eq!(
        replies[0]["fields"],
        serde_json::json!({"name": ECHO, "surface": "s1", "bytes": 0, "ok": false, "error": format!("-32603: {reason}")})
    );
}

// contract: sidecars.image.closed-surface-is-answered
#[test]
fn an_image_of_a_closed_surface_is_answered_closed() {
    // The script sends a transfer image of the closed surface s2, reads the answer of the host and returns it as a message
    // of s1.
    let (sidecars, _directory) = script_sidecars(concat!(
        "#!/bin/sh\nread open1\nread open2\nread closed2\n",
        "printf '%s\\n' '{\"surface\":\"s2\",\"body\":{\"image\":{\"format\":\"bgra8\",\"generation\":3,\"height\":10,\"name\":\"view\",\"raster\":4,\"scale\":1.0,\"sequence\":5,\"token\":{\"id\":7,\"kind\":\"iosurface-global\"},\"width\":10}}}'\n",
        "read answer\nprintf '{\"surface\":\"s1\",\"body\":%s}\\n' \"$answer\"\nexec sleep 600\n",
    ));
    let (window, events, _failures) = failing_owner("a", "/projects/a");
    for surface in ["s1", "s2"] {
        sidecars
            .send(&window, ECHO, surface, &raw(r#"{"operation":"open"}"#))
            .unwrap();
    }
    sidecars
        .retain(&window, &|surface| surface != "s2")
        .unwrap();
    let event = events
        .recv_timeout(STALL)
        .expect("no answer of the image of the closed surface; the test stalled");
    let answer: serde_json::Value = serde_json::from_str(event.body.get()).unwrap();
    assert_eq!(event.surface, "s1");
    assert_eq!(
        answer,
        serde_json::json!({"surface": "s2", "body": {"image": {"error": "closed", "name": "view", "generation": 3, "raster": 4, "sequence": 5}}})
    );
}

// contract: sidecars.read.unfinished-line-ends-the-connection
#[test]
fn an_unfinished_line_at_the_end_of_the_output_is_not_a_message() {
    let mut reader =
        std::io::Cursor::new(b"{\"surface\":\"s1\"}\n{\"surface\":\"s2\",\"body\":\"cut".to_vec());
    let mut line = Vec::new();
    assert_eq!(
        read_message_line(&mut reader, 1024, &mut line).unwrap(),
        MessageLine::Complete
    );
    assert_eq!(line, b"{\"surface\":\"s1\"}\n");
    assert_eq!(
        read_message_line(&mut reader, 1024, &mut line).unwrap(),
        MessageLine::Unfinished(b"{\"surface\":\"s2\",\"body\":\"cut".len())
    );
    assert_eq!(
        read_message_line(&mut reader, 1024, &mut line).unwrap(),
        MessageLine::End
    );
    let mut long = std::io::Cursor::new(vec![b'x'; 2048]);
    assert_eq!(
        read_message_line(&mut long, 1024, &mut line).unwrap(),
        MessageLine::TooLong
    );
}

// A response to a sidecar that has ended has no receiver: its frames ended with its process, so the dropped-message path
// records the answer that it cannot send instead of an error.
// contract: sidecars.protocol.answer-to-ended-sidecar-is-recorded
#[test]
fn a_response_to_a_sidecar_that_ended_is_the_ended_error() {
    let (sidecars, _dir) = echo_sidecars();
    let body =
        serde_json::value::RawValue::from_string(r#"{"image":{"error":"closed"}}"#.to_string())
            .unwrap();
    match sidecars.send_response(ECHO, "s1", "view", &body) {
        Err(soksak_host_tauriv2::sidecars::ResponseError::Ended(text)) => {
            assert_eq!(text, format!("sidecar {ECHO} is not running"));
        }
        other => panic!("{other:?}"),
    }
}

// The sidecars that a page reload reconnects for a surface skip a sidecar that no plugin declares: the plugin of that
// sidecar was removed, so the surface ended with it, and a send to it fails and stopped the start of the page.
// contract: surfaces.reload.reconnects-only-declared-sidecars
#[test]
fn a_page_reload_reconnects_only_the_declared_sidecars_of_a_surface() {
    let declared = |name: &str| name != "@scope/sidecar-removed";
    assert_eq!(
        soksak_host_tauriv2::windows::reconnect_targets(
            "s1",
            vec![
                "@scope/sidecar-removed".to_string(),
                "@scope/sidecar-image".to_string()
            ],
            &[
                (
                    "@scope/sidecar-persistent".to_string(),
                    vec!["s1".to_string()]
                ),
                ("@scope/sidecar-image".to_string(), vec!["s1".to_string()])
            ],
            declared,
        ),
        vec![
            "@scope/sidecar-image".to_string(),
            "@scope/sidecar-persistent".to_string()
        ]
    );
}

// A page reload reconnects a running persistent sidecar only for the surfaces that have sent to it: a send to it from
// another surface, such as a surface of another card beside the surface that sent, would make that surface a sidecar session of
// the persistent sidecar, which the Wails host does not count.
// contract: diagnostics.objects.sidecar-sessions-agree
#[test]
fn a_page_reload_does_not_reconnect_a_persistent_sidecar_for_a_surface_that_never_sent_to_it() {
    assert_eq!(
        soksak_host_tauriv2::windows::reconnect_targets(
            "tab-other",
            Vec::new(),
            &[(
                "@scope/sidecar-persistent".to_string(),
                vec!["tab-sender".to_string()]
            )],
            |_| true,
        ),
        Vec::<String>::new()
    );
}
