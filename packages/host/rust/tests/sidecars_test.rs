//! Sidecar channel tests. They use a fake window and sidecars that run the sidecar fixture with control texts.

#[path = "support/child.rs"]
mod child;
#[path = "support/folder.rs"]
mod folder;

use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "support/records.rs"]
mod records;

use serde_json::value::RawValue;
use soksak_host::sidecars::{
    ClosingSurface, Failure, Message, MessageLine, Owner, SidecarDeclaration, Sidecars,
    read_message_line,
};

/// The writer of the records is process-wide, so the tests that attach it run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

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
            error: None,
            version: "0.0.1".to_string(),
            dependents: Vec::new(),
        })
        .collect()
}

/// The declaration of the sidecar name whose sidecar.json is data, with its files in directory.
fn declaration_in(name: &str, directory: &Path, data: &str) -> SidecarDeclaration {
    SidecarDeclaration {
        name: name.to_string(),
        folder: directory.to_path_buf(),
        data: data.as_bytes().to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
    }
}

fn create(files: &Files, directory: &Path) -> Result<Sidecars<FakeOwner>, String> {
    Sidecars::new(&declare(files, directory), directory.to_path_buf())
}

const ECHO: &str = "@fixture/sidecar-echo";

/// Constructs the sidecars with one @fixture/sidecar-echo whose sidecar.json is manifest, and returns the error of a send
/// to it. An invalid declaration leaves the sidecar undeclared without failing the construction, and the send names the
/// sidecar and the path of its sidecar.json (docs/spec/sidecars.md#declaration-and-startup).
fn refusal(manifest: &str, config: &Path) -> String {
    let directory = folder::Folder::new();
    let sidecars = Sidecars::<FakeOwner>::new(
        &declare(&files(manifest), directory.path()),
        config.to_path_buf(),
    )
    .unwrap();
    let (window, _events) = owner("a", "/projects/a");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    let path = directory.path().join("sidecar.json").display().to_string();
    assert!(
        error.starts_with(&format!("sidecar {ECHO}: {path}: ")),
        "{error}"
    );
    sidecars.stop();
    error
}

/// Declares the sidecar fixture @fixture/sidecar-echo, which prints the received line as it is and leaves it in the
/// request record file.
fn echo_sidecars() -> (Sidecars<FakeOwner>, folder::Folder) {
    let directory = folder::Folder::new();
    let record = directory.path().join("requests");
    // The sidecar records the lines that remain on its way out, so it ignores the terminate signal of the stop and ends
    // with its input.
    directory.fixture(
        "echo",
        &format!("ignore-term\non any tee {}\n", record.display()),
    );
    let sidecars = create(
        &files(r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
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
    let event = first_events.recv().unwrap();
    assert_eq!(
        (
            event.sidecar.as_str(),
            event.surface.as_str(),
            event.body.get()
        ),
        (ECHO, "s1", r#"{"operation":"open"}"#)
    );
    assert_eq!(second_events.recv().unwrap().surface, "s2");
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
    let (before, before_events) = owner("a", "/projects/a");
    // Even after the same window changed to another project, an already opened surface sends with the first root.
    let (after, _after_events) = owner("a", "/projects/b");
    sidecars
        .send(&before, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    // The echo is the event that the sidecar ignores the terminate signal of the stop, so it records every line.
    before_events.recv().unwrap();
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
    let (window, events) = owner("a", "/projects/a");
    for surface in ["s1", "state:files:p1"] {
        sidecars
            .send(&window, ECHO, surface, &raw(r#"{"operation":"open"}"#))
            .unwrap();
    }
    // The echo is the event that the sidecar ignores the terminate signal of the stop, so it records every line.
    events.recv().unwrap();
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

// contract: sidecars.close.reaches-holding-sidecar
#[test]
fn close_reaches_only_the_sidecar_that_holds_the_surface() {
    const SECOND: &str = "@fixture/sidecar-second";
    let first = folder::Folder::new();
    let second = folder::Folder::new();
    for (dir, record) in [
        (&first, first.path().join("requests")),
        (&second, second.path().join("requests")),
    ] {
        dir.fixture(
            "echo",
            &format!("ignore-term\non any tee {}\n", record.display()),
        );
    }
    let declare_in = |name: &str, folder: &Path| SidecarDeclaration {
        name: name.to_string(),
        folder: folder.to_path_buf(),
        data: br#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
    };
    let declarations = vec![
        declare_in(ECHO, first.path()),
        declare_in(SECOND, second.path()),
    ];
    let sidecars = Sidecars::new(&declarations, first.path().to_path_buf()).unwrap();
    let (window, events) = owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars
        .send(&window, SECOND, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    // The echo of each sidecar is the event that it ignores the terminate signal of the stop, so it records every line.
    let mut echoed: Vec<String> = (0..2).map(|_| events.recv().unwrap().sidecar).collect();
    echoed.sort();
    assert_eq!(echoed, [ECHO.to_string(), SECOND.to_string()]);
    // The surface synchronization closes the removed s1 only.
    sidecars
        .retain(&window, &|surface| surface != "s1")
        .unwrap();
    sidecars.stop();
    // Only the sidecar that received s1 is told that it closed; the other sidecar gets no closed notice for it.
    assert_eq!(
        std::fs::read_to_string(first.path().join("requests")).unwrap(),
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","closed":true}"#,
            "\n",
        )
    );
    assert_eq!(
        std::fs::read_to_string(second.path().join("requests")).unwrap(),
        concat!(
            r#"{"surface":"s2","root":"/projects/a","body":{"operation":"open"}}"#,
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
    let directory = folder::Folder::new();
    let sidecars = create(
        &files(r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#),
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
    let directory = folder::Folder::new();
    let record = directory.path().join("argv");
    directory.fixture(
        "echo",
        &format!(
            "record-argv {}\nskip-line\nwrite {{\"surface\":\"s1\",\"body\":\"ok\"}}\non any echo\n",
            record.display()
        ),
    );
    let created = create(
        &files(r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    // The application stops its sidecars when it exits (docs/spec/sidecars.md#messages), so the check stops them in drop,
    // even when it fails.
    let sidecars = Stopping(created);
    let (window, events) = owner("a", "/projects/a");
    sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap();
    events.recv().unwrap();
    let config = directory.path().canonicalize().unwrap();
    assert_eq!(
        std::fs::read_to_string(&record).unwrap(),
        format!("--log-dir\n{}\n", config.join("logs").display())
    );
}

// contract: sidecars.declaration.adds-sidecars-installed-after-start
#[test]
fn declaring_adds_sidecars_installed_after_the_start() {
    let directory = folder::Folder::new();
    let record = directory.path().join("requests");
    directory.fixture(
        "echo",
        &format!("ignore-term\non any tee {}\n", record.display()),
    );
    let sidecars = create(&Vec::new(), directory.path()).unwrap();
    let (window, events) = owner("a", "/projects/a");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("is not declared by any plugin"), "{error}");
    sidecars
        .declare(&declare(
            &files(r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#),
            directory.path(),
        ))
        .unwrap();
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let event = events.recv().unwrap();
    assert_eq!(
        (event.surface.as_str(), event.body.get()),
        ("s1", r#"{"operation":"open"}"#)
    );
    sidecars.stop();
}

// contract: sidecars.declaration.rejects-executable-escaping-package
#[test]
fn an_executable_outside_the_package_is_not_declared() {
    let config = folder::Folder::new();
    let error = refusal(
        r#"{"executable":"../escape","displayName":"soksak://sidecar/probe","protocol":1}"#,
        config.path(),
    );
    assert!(
        error.ends_with("executable ../escape is not a path inside the package"),
        "{error}"
    );
}

// contract: sidecars.declaration.rejects-absolute-executable
#[test]
fn an_absolute_executable_is_not_declared() {
    let config = folder::Folder::new();
    let error = refusal(
        r#"{"executable":"/bin/sh","displayName":"soksak://sidecar/probe","protocol":1}"#,
        config.path(),
    );
    assert!(
        error.ends_with("executable /bin/sh is not a path inside the package"),
        "{error}"
    );
}

// contract: sidecars.declaration.persistent-requires-config-directory
#[test]
fn persistent_transport_requires_a_config_directory() {
    let directory = folder::Folder::new();
    let fixture = files(
        r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}"#,
    );
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
fn an_unsupported_protocol_is_not_declared() {
    let config = folder::Folder::new();
    let error = refusal(
        r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":2}"#,
        config.path(),
    );
    assert!(error.ends_with("protocol 2 is not supported"), "{error}");
}

// contract: sidecars.declaration.rejects-host-read-operations
#[test]
fn a_declaration_with_host_read_operations_is_not_declared() {
    let config = folder::Folder::new();
    let error = refusal(
        r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"hostReadOperations":["list"]}"#,
        config.path(),
    );
    assert!(error.ends_with("hostReadOperations is removed"), "{error}");
}

// contract: sidecars.declaration.rejects-unknown-transport
#[test]
fn an_unknown_transport_is_not_declared() {
    let config = folder::Folder::new();
    let error = refusal(
        r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"ptyd"}"#,
        config.path(),
    );
    assert!(
        error.ends_with("transport ptyd is not supported"),
        "{error}"
    );
}

// contract: sidecars.declaration.invalid-sidecar-leaves-others-declared
#[test]
fn an_invalid_declaration_leaves_the_other_sidecars_declared() {
    const EARLIER: &str = "@fixture/sidecar-earlier";
    let directory = folder::Folder::new();
    directory.fixture("echo", "ignore-term\non any echo\n");
    // The invalid declaration has a folder of its own. The host refuses it before it starts a program.
    let earlier = folder::Folder::new();
    let declarations = || {
        vec![
            declaration_in(
                ECHO,
                directory.path(),
                r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#,
            ),
            declaration_in(
                EARLIER,
                earlier.path(),
                r#"{"executable":"echo","protocol":1}"#,
            ),
        ]
    };
    let path = earlier.path().join("sidecar.json").display().to_string();
    let refused = format!("sidecar {EARLIER}: {path}: displayName is required");
    let sidecars = Sidecars::new(&declarations(), directory.path().to_path_buf()).unwrap();
    let (window, events) = owner("a", "/projects/a");
    assert_eq!(
        sidecars
            .send(&window, EARLIER, "s2", &raw("{}"))
            .unwrap_err(),
        refused
    );
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    assert_eq!(events.recv().unwrap().surface, "s1");
    // A declaration after the start keeps the valid sidecar running and the invalid one undeclared.
    sidecars.declare(&declarations()).unwrap();
    assert_eq!(
        sidecars
            .send(&window, EARLIER, "s2", &raw("{}"))
            .unwrap_err(),
        refused
    );
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"next"}"#))
        .unwrap();
    assert_eq!(events.recv().unwrap().body.get(), r#"{"operation":"next"}"#);
    sidecars.stop();
}

// contract: sidecars.persistent.accepts-non-canonical-config-directory
#[test]
fn persistent_transport_accepts_a_non_canonical_config_directory() {
    let executable_directory = folder::Folder::new();
    let config_directory = folder::Folder::new();
    let fixture = files(
        r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}"#,
    );
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
    let directory = folder::Folder::new();
    let sidecars = create(&Files::new(), directory.path()).unwrap();
    let (window, _events) = owner("a", "/");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("is not declared by any plugin"), "{error}");
}

// contract: sidecars.send.fails-fast-when-sidecar-not-keeping-up, sidecars.send.slow-sidecar-does-not-block-others
#[test]
fn slow_sidecar_does_not_block_other_sends() {
    // The slow sidecar does not read stdin, and the other sidecar works normally. If more than 256 are sent to the slow
    // sidecar, it eventually fails with an "is not keeping up" error. Even when the channel of the slow sidecar is full,
    // send() to the fast sidecar does not block.

    // The slow sidecar: it does not read stdin, so the pipe fills and it ends at the terminate signal of the stop. A
    // program that reads stdin, such as cat, has a read speed that depends on the load, so whether the channel fills is
    // not determined.
    let slow = folder::Folder::new();
    slow.fixture("slow", "sleep 600\n");

    // The fast sidecar: it prints the received line as it is.
    let fast = folder::Folder::new();
    fast.fixture("fast", "on any tee /dev/null\n");

    // A frontend that declares the two sidecars.
    let declarations = vec![
        declaration_in(
            "@fixture/sidecar-slow",
            slow.path(),
            r#"{"executable":"slow","displayName":"soksak://sidecar/probe","protocol":1}"#,
        ),
        declaration_in(
            "@fixture/sidecar-fast",
            fast.path(),
            r#"{"executable":"fast","displayName":"soksak://sidecar/probe","protocol":1}"#,
        ),
    ];
    let sidecars = Sidecars::new(&declarations, slow.path().to_path_buf()).unwrap();
    let (owner, _events) = owner("a", "/projects/test");

    // The first send to the fast sidecar starts that process, so the send of property 1 goes to a running process.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-fast",
            "s2",
            &raw(r#"{"data":"start"}"#),
        )
        .unwrap();

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

    // Property 1: even when the channel of the slow sidecar is full, send() to the fast sidecar does not block. The slow
    // sidecar reads nothing until the stop, so a send that waits for its channel does not return, and the check stops at
    // the limit of its runner.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-fast",
            "s2",
            &raw(r#"{"data":"test"}"#),
        )
        .unwrap();

    // The slow sidecar does not read its input and ends at the terminate signal of the stop.
    sidecars.stop();
}

// contract: sidecars.stop.graceful-on-stdin-eof
#[test]
fn stop_graceful_shutdown() {
    // Verifies that, when the sidecar actually reads stdin, stop() ends by the exit of the sidecar at stdin EOF.

    let directory = folder::Folder::new();

    // The sidecar: it echoes the received line as it is and ends normally at stdin EOF. It ignores the terminate signal
    // of the stop, so it ends by its input.
    directory.fixture("graceful", "ignore-term\non any echo\nat-eof exit 0\n");

    let files: Files = vec![(
        "@fixture/sidecar-graceful",
        r#"{"executable":"graceful","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_string(),
    )];

    let sidecars = create(&files, directory.path()).unwrap();
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

    // Check that the sidecar actually reads stdin: wait for the echo event.
    let event = events.recv().expect("no echo event; the test stalled");
    assert_eq!(
        (event.sidecar.as_str(), event.surface.as_str()),
        ("@fixture/sidecar-graceful", "s1")
    );

    // The stop ends by the exit of the sidecar at the end of its input; a stop that does not end stops at the limit of
    // the runner.
    sidecars.stop();
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
    let directory = folder::Folder::new();
    directory.fixture(
        "talkative",
        "ignore-term\non any echo\nat-eof flood 3000 {\"surface\":\"s1\",\"closed\":true}\nat-eof exit 0\n",
    );
    let files: Files = vec![(
        "@fixture/sidecar-talkative",
        r#"{"executable":"talkative","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_string(),
    )];
    let sidecars = create(&files, directory.path()).unwrap();
    let (owner, events) = owner("a", "/projects/test");
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-talkative",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();
    let event = events.recv().expect("no echo event; the test stalled");
    assert_eq!(event.surface, "s1");
    // A stop that waits on the unread output does not return, and the check stops at the limit of its runner.
    sidecars.stop();
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
            let (sidecars, directory) = fixture_sidecars(
                r#"ignore-term
on match *"closed":true* keep DIR/closed
on any echo
at-eof write {"surface":"s1","closed":true}
at-eof flood 3000 {"surface":"s1","body":"late"}
at-eof append DIR/finished finished
at-eof exit 0
"#,
            );
            let (window, events) = owner("a", "/projects/test");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                .unwrap();
            let event = events.recv().expect("no echo event; the test stalled");
            assert_eq!(event.surface, "s1");
            sidecars.retain(&window, &|_| false).unwrap();
            sidecars.stop();
            let finished = std::fs::read_to_string(directory.path().join("finished"));
            assert!(
                matches!(&finished, Ok(text) if text == "finished\n"),
                "the sidecar did not complete its writes on its way out: finished = {finished:?}"
            );
            // The sidecar records the close that it received before its input ended.
            let closed = std::fs::read_to_string(directory.path().join("closed")).unwrap();
            assert!(
                closed.contains(r#""closed":true"#),
                "the sidecar received no close before its input ended: {closed:?}"
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
            for ending in ["exit 3", "signal HUP"] {
                let (sidecars, _directory) =
                    fixture_sidecars(&format!("ignore-term\non any echo\nat-eof {ending}\n"));
                let (window, events) = owner("a", "/projects/test");
                sidecars
                    .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                    .unwrap();
                let event = events.recv().expect("no echo event; the test stalled");
                assert_eq!(event.surface, "s1");
                sidecars.stop();
            }
        });
        return;
    };
    for want in [
        "error host sidecar @fixture/sidecar-echo: exited while stopping: exit status 3\n",
        "error host sidecar @fixture/sidecar-echo: exited while stopping: signal 1\n",
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
            let (sidecars, _directory) =
                fixture_sidecars("stderr first line\nstderr-raw no line feed\non any echo\n");
            let (window, events) = owner("a", "/projects/test");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                .unwrap();
            let event = events.recv().expect("no echo event; the test stalled");
            assert_eq!(event.surface, "s1");
            // The stop ends after the last record of the standard error.
            sidecars.stop();
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
    let (sidecars, directory) = fixture_sidecars(
        r#"skip-line
write {"surface":"s1","body":{"event":"state","text":"한"}}
on any drop
"#,
    );
    let events_directory = folder::Folder::new();
    let writer = records::start_writer(events_directory.path());
    let _ = &directory;
    soksak_host::performance::command(serde_json::json!({"action": "on"})).unwrap();
    let (window, events) = owner("a", "/projects/test");
    sidecars
        .send(
            &window,
            ECHO,
            "s1",
            &raw(r#"{"operation":"input","bytes":"7ZWc"}"#),
        )
        .unwrap();
    let event = events.recv().expect("no event; the test stalled");
    assert_eq!(event.surface, "s1");
    sidecars.stop();
    // Turning the trace off joins the sampler, so no process that it started outlives the check.
    soksak_host::performance::command(serde_json::json!({"action": "off"})).unwrap();
    writer.flush().unwrap();
    let records_of_the_run = records::read_events(writer.path());
    soksak_host::event_record::use_host_event_log(None);
    assert!(
        !soksak_host::performance::sampler_running(),
        "the check left the sampler of the trace running"
    );
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
    let directory = folder::Folder::new();
    // The sidecar: it echoes the received line, and when the input ends it writes one line to ended and then waits for
    // one line in release. The write to ended waits until the check opens ended for reading, and the wait for release
    // ends when the check writes a line to it. It ignores the terminate signal of the stop, so it ends with its input
    // and its release.
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
    directory.fixture(
        "lingering",
        &format!(
            "ignore-term\non any echo\nat-eof append {} ended\nat-eof wait {}\nat-eof exit 0\n",
            ended.display(),
            release.display()
        ),
    );
    // Holds release open from before the start of the sidecar until the end of the check, so that the line written to it
    // waits in the pipe until the sidecar opens it: a line written to a FIFO that no process holds open is discarded. It
    // writes the line once, at the release of the check or at its end, so that no sidecar remains even if the check ends
    // midway.
    struct Release {
        fifo: std::fs::File,
        sent: bool,
    }
    impl Release {
        fn send(&mut self) {
            if !self.sent {
                self.sent = true;
                self.fifo.write_all(b"x\n").expect("write release");
            }
        }
    }
    impl Drop for Release {
        fn drop(&mut self) {
            self.send();
        }
    }
    let mut release = Release {
        fifo: std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&release)
            .expect("open release"),
        sent: false,
    };
    let files: Files = vec![(
        "@fixture/sidecar-lingering",
        r#"{"executable":"lingering","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_string(),
    )];
    let sidecars = create(&files, directory.path()).unwrap();
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
        let event = events.recv().expect("no echo event; the test stalled");
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
        release.send();
        stopping.join().expect("stop thread");
    });
}

// A sidecar that ignores the end of its input ends at the terminate signal of the stop: the stop ends by that exit, and
// the host writes neither an error line nor an "exited while stopping" line for it.
// contract: sidecars.stop.terminates-the-process-group
#[test]
fn a_stop_terminates_a_sidecar_that_ignores_its_input() {
    let Some(stderr) = logged_by_child("a_stop_terminates_a_sidecar_that_ignores_its_input") else {
        records::capturing(|| {
            // The sidecar does not read stdin, so it keeps running after stdin EOF.
            let (sidecars, directory) = fixture_sidecars("hold DIR/hold\n");
            let _hold = hold_fifo(directory.path(), "hold");
            let (window, _events) = owner("a", "/projects/test");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"test":"data"}"#))
                .unwrap();
            // A stop that waits for no exit and kills does not return before the exit, and a stop that waits forever
            // stops at the limit of the runner.
            sidecars.stop();
        });
        return;
    };
    assert!(
        !stderr.contains("error host ") && !stderr.contains("exited while stopping"),
        "the stop by the terminate signal wrote {stderr:?}"
    );
}

// A stop other than the quit returns before the process exits: a declaration that removes a running sidecar returns
// while the sidecar, which ignores the terminate signal and holds its exit until the check opens its gate, still runs,
// and the host reaps it at its exit (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.stop.returns-at-once-outside-the-quit
#[test]
fn a_stop_outside_the_quit_returns_before_the_exit() {
    use std::io::Write;
    let (sidecars, directory) =
        fixture_sidecars("ignore-term\nrecord-pid DIR/started\nskip-line\nwait DIR/gate\nexit 3\n");
    let started = child_fifo(directory.path(), "started");
    let mut gate = hold_fifo(directory.path(), "gate");
    let (window, _events) = owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let pid = child_pid(&started);
    let _killed = Killed(pid);
    // A declaration that waits for the exit does not return before the gate opens, and the check stops at the limit of
    // its runner.
    sidecars.declare(&[]).unwrap();
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        0,
        "the declaration returned after the stopping sidecar {pid} ended: {}",
        std::io::Error::last_os_error()
    );
    gate.write_all(b"open\n").unwrap();
    require_gone(pid);
    sidecars.stop();
}

// The stop of the quit writes, for each process that it waits for, the record of that wait
// (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.stop.records-what-the-quit-waits-for
#[test]
fn the_quit_records_the_processes_that_it_waits_for() {
    const STARTED: &str = "the check started the sidecar as process ";
    let Some(stderr) = logged_by_child("the_quit_records_the_processes_that_it_waits_for") else {
        records::capturing(|| {
            let (sidecars, directory) = fixture_sidecars("record-pid DIR/started\non any echo\n");
            let started = child_fifo(directory.path(), "started");
            let (window, _events) = owner("a", "/projects/a");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
                .unwrap();
            // The parent reads the process id from the standard error of this child.
            eprintln!("{STARTED}{}", child_pid(&started));
            sidecars.stop();
        });
        return;
    };
    let pid = stderr
        .lines()
        .find_map(|line| line.strip_prefix(STARTED))
        .unwrap_or_else(|| panic!("the child named no process in {stderr:?}"));
    let want = format!("info host sidecar {ECHO}: the quit waits for the exit of process {pid}\n");
    assert!(
        stderr.contains(&want),
        "log {stderr:?} does not contain {want:?}"
    );
}

// The quit stop refuses the exit while a sidecar that it stops runs, ends at the exit of that sidecar, and accepts the
// exit after it; without a sidecar to stop it accepts the exit at once (docs/spec/hosts.md#process-lifecycle).
// contract: sidecars.stop.quit-exits-after-its-sidecars
#[test]
fn the_quit_stop_exits_after_its_sidecars() {
    const STARTED: &str = "the check started the sidecar as process ";
    let Some(stderr) = logged_by_child("the_quit_stop_exits_after_its_sidecars") else {
        records::capturing(|| {
            use std::io::Write;
            // The sidecar ignores the terminate signal and the end of its input and exits when the check opens its
            // gate.
            let (sidecars, directory) = fixture_sidecars(
                "ignore-term\nrecord-pid DIR/started\nskip-line\nwait DIR/gate\nexit 0\n",
            );
            let started = child_fifo(directory.path(), "started");
            let mut gate = hold_fifo(directory.path(), "gate");
            let (window, _events) = owner("a", "/projects/a");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
                .unwrap();
            let pid = child_pid(&started);
            let _killed = Killed(pid);
            eprintln!("{STARTED}{pid}");
            let (end, ended) = channel::<()>();
            assert!(
                !sidecars.quit_stop(false, move || end.send(()).unwrap()),
                "the quit stop accepted the exit while its sidecar runs"
            );
            // The gate holds the sidecar, so no exit can end the stop before the gate opens.
            assert!(
                ended.try_recv().is_err(),
                "the quit stop ended while its sidecar runs"
            );
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                0,
                "the quit stop ended the sidecar {pid} that it waits for"
            );
            gate.write_all(b"open\n").unwrap();
            ended.recv().unwrap();
            require_gone(pid);
            assert!(
                sidecars.quit_stop(false, || panic!("the end of an ended quit stop ran again")),
                "the quit stop refused the exit after its sidecars exited"
            );
            let (empty, _empty_directory) = fixture_sidecars("on any echo\n");
            assert!(
                empty.quit_stop(false, || panic!(
                    "the quit stop without a sidecar ran its end"
                )),
                "the quit stop without a sidecar refused the exit"
            );
        });
        return;
    };
    let pid = stderr
        .lines()
        .find_map(|line| line.strip_prefix(STARTED))
        .unwrap_or_else(|| panic!("the child named no process in {stderr:?}"));
    let want = format!("info host sidecar {ECHO}: the quit waits for the exit of process {pid}\n");
    assert!(
        stderr.contains(&want),
        "log {stderr:?} does not contain {want:?}"
    );
}

// A quit request while the quit stop runs force-kills the process group of each sidecar that has not exited and records
// it; the stop then ends by that exit (docs/spec/hosts.md#process-lifecycle).
// contract: sidecars.stop.second-quit-kills-what-remains
#[test]
fn a_second_quit_kills_the_sidecars_that_the_quit_stop_waits_for() {
    const STARTED: &str = "the check started the sidecar as process ";
    let Some(stderr) =
        logged_by_child("a_second_quit_kills_the_sidecars_that_the_quit_stop_waits_for")
    else {
        records::capturing(|| {
            // The sidecar ignores the terminate signal and the end of its input, and the check never opens its gate.
            let (sidecars, directory) = fixture_sidecars(
                "ignore-term\nrecord-pid DIR/started\nskip-line\nwait DIR/gate\nexit 0\n",
            );
            let started = child_fifo(directory.path(), "started");
            let _gate = hold_fifo(directory.path(), "gate");
            let (window, _events) = owner("a", "/projects/a");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
                .unwrap();
            let pid = child_pid(&started);
            let _killed = Killed(pid);
            eprintln!("{STARTED}{pid}");
            let (end, ended) = channel::<()>();
            assert!(
                !sidecars.quit_stop(false, move || end.send(()).unwrap()),
                "the quit stop accepted the exit while its sidecar runs"
            );
            assert!(
                !sidecars.quit_stop(false, || panic!("the second quit ran a second end")),
                "the second quit accepted the exit while the sidecar runs"
            );
            // A second quit that kills nothing leaves the stop waiting, and the check stops at the limit of its runner.
            ended.recv().unwrap();
            require_gone(pid);
            assert!(
                sidecars.quit_stop(false, || {}),
                "the quit stop refused the exit after the kill"
            );
        });
        return;
    };
    let pid = stderr
        .lines()
        .find_map(|line| line.strip_prefix(STARTED))
        .unwrap_or_else(|| panic!("the child named no process in {stderr:?}"));
    let want = format!("info host sidecar {ECHO}: the second quit kills process {pid}\n");
    assert!(
        stderr.contains(&want),
        "log {stderr:?} does not contain {want:?}"
    );
    // The exit by the force-kill signal of the second quit is the quit itself.
    assert!(
        !stderr.contains("exited while stopping"),
        "log {stderr:?} reports the exit that the second quit caused"
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

/// Ends the sidecar in drop so that no sidecar process remains even if the check ends or fails.
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

/// Declares the sidecar fixture as the sidecar @fixture/sidecar-echo in a new folder, with the control text control. DIR in
/// control is replaced with the path of that folder.
fn fixture_sidecars(control: &str) -> (Stopping, folder::Folder) {
    let directory = folder::Folder::new();
    directory.fixture(
        "fixture",
        &control.replace("DIR", &directory.path().display().to_string()),
    );
    let sidecars = create(
        &files(r#"{"executable":"fixture","displayName":"soksak://sidecar/probe","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    (Stopping(sidecars), directory)
}

/// A control text that reads one request, sends an s1 message of size bytes before the line feed, and then runs then. The
/// body of the message is a string of padding characters x, and the function returns the number of those characters.
fn padded_message_control(size: usize, then: &str) -> (String, usize) {
    let (prefix, suffix) = (r#"{"surface":"s1","body":""#, r#""}"#);
    let padding = size - prefix.len() - suffix.len();
    (
        format!("record-pid DIR/pid\nskip-line\npad s1 {padding}\n{then}\n"),
        padding,
    )
}

/// The process id that the sidecar recorded.
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
    let (control, padding) = padded_message_control(MESSAGE_LIMIT, "drain /dev/null");
    let (sidecars, _directory) = fixture_sidecars(&control);
    let (window, events, failures) = failing_owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let event = events.recv().expect("no sidecar event; the test stalled");
    let body = event.body.get();
    assert_eq!(event.surface, "s1");
    assert_eq!(body.len(), padding + 2, "body length");
    assert!(
        body.starts_with('"')
            && body.ends_with('"')
            && body[1..body.len() - 1].bytes().all(|b| b == b'x'),
        "message at the limit was changed"
    );
    if let Ok(failure) = failures.try_recv() {
        panic!("message at the limit produced a failure: {failure:?}");
    }
}

// contract: sidecars.failure.oversize-message-terminates-and-notifies
#[test]
fn an_oversize_message_terminates_and_notifies() {
    let (control, _) = padded_message_control(MESSAGE_LIMIT + 1, "sleep 600");
    let (sidecars, directory) = fixture_sidecars(&control);
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let failure = failures
        .recv()
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
        let (sidecars, directory) = fixture_sidecars(&format!(
            "record-pid DIR/pid\nskip-line\nwrite {line}\nsleep 600\n"
        ));
        let (window, _events, failures) = failing_owner("a", "/projects/a");
        sidecars
            .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        let failure = failures
            .recv()
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
    // Each process answers its first line after it recorded its pid, so the answer is the event that the pid is recorded.
    let (sidecars, directory) = fixture_sidecars(
        r#"append-pid DIR/pids
skip-line
write {"surface":"s1","body":"recorded"}
skip-line
exit 3
"#,
    );
    let (first, first_events, first_failures) = failing_owner("a", "/projects/a");
    let (second, _second_events, second_failures) = failing_owner("b", "/projects/b");
    sidecars
        .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    first_events.recv().unwrap();
    sidecars
        .send(&second, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    for (surface, failures) in [("s1", &first_failures), ("s2", &second_failures)] {
        let failure = failures
            .recv()
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
    // The new process recorded its pid when it answers, before the stop ends it.
    first_events.recv().unwrap();
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
    let (sidecars, directory) = fixture_sidecars(
        r#"record-pid DIR/pid
skip-line
skip-line
skip-line
write {"surface":"s2","body":"late"}
write {"surface":"s1","body":"after"}
write {"surface":"ghost","body":"x"}
sleep 600
"#,
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
    let event = events.recv().expect("no sidecar event; the test stalled");
    assert_eq!(
        (event.surface.as_str(), event.body.get()),
        ("s1", r#""after""#)
    );
    let failure = failures
        .recv()
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

/// The sidecar @fixture/sidecar-echo that runs the control text, and the channel that receives the value whenever closing
/// changes.
fn closing_sidecars(
    control: &str,
) -> (
    std::sync::Arc<Sidecars<FakeOwner>>,
    Receiver<Vec<ClosingSurface>>,
    folder::Folder,
) {
    let directory = folder::Folder::new();
    directory.fixture("closing", control);
    let files: Files = vec![(
        ECHO,
        r#"{"executable":"closing","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_string(),
    )];
    let sidecars = std::sync::Arc::new(create(&files, directory.path()).unwrap());
    let (snapshot, snapshots) = channel();
    sidecars.on_status_changed(move |value| {
        snapshot
            .send(value.closing)
            .expect("closing snapshot receiver ended");
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
    let (sidecars, snapshots, _directory) = closing_sidecars("on any tee /dev/null\n");
    let (window, _events) = owner("a", "/projects/closing");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    sidecars.retain(&window, &|_| false).unwrap();
    assert_eq!(snapshots.recv().unwrap(), closing_of("s1"));
    assert_eq!(snapshots.recv().unwrap(), vec![]);
    sidecars.stop();
}

// contract: sidecars.close.failed-answer-is-logged
#[test]
fn failed_close_answer_is_logged() {
    // The log is the standard error, so the same check runs in a child process and its output is read.
    if std::env::var_os("SOKSAK_CLOSE_LOG_CHILD").is_some() {
        records::capturing(|| {
            let control = r#"on match *closed* reply {"surface":"s1","closed":true,"error":"busy"}
on any echo
"#;
            let (sidecars, snapshots, _directory) = closing_sidecars(control);
            let (window, _events) = owner("a", "/projects/closing");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
                .unwrap();
            sidecars.retain(&window, &|_| false).unwrap();
            assert_eq!(snapshots.recv().unwrap(), closing_of("s1"));
            assert_eq!(snapshots.recv().unwrap(), vec![]);
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

// The log holds the failure when the closing entry ends, so a reader of the log after that status finds it. The
// mark goes through the same writer, so the order of the two lines in the standard error is the order of the calls.
// contract: sidecars.close.failed-answer-is-logged
#[test]
fn failed_close_answer_is_logged_before_the_closing_entry_ends() {
    if std::env::var_os("SOKSAK_CLOSE_ORDER_CHILD").is_some() {
        records::capturing(|| {
            let control = r#"on match *closed* reply {"surface":"s1","closed":true,"error":"busy"}
on any drop
"#;
            let (sidecars, _snapshots, _directory) = closing_sidecars(control);
            let (ended, end) = channel();
            sidecars.on_status_changed(move |value| {
                if value.closing.is_empty() {
                    soksak_host::application_log::log_error("mark", "the closing entry ended");
                    let _ = ended.send(());
                }
            });
            let (window, _events) = owner("a", "/projects/closing");
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
                .unwrap();
            sidecars.retain(&window, &|_| false).unwrap();
            end.recv().unwrap();
            sidecars.stop();
        });
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "failed_close_answer_is_logged_before_the_closing_entry_ends",
            "--nocapture",
        ])
        .env("SOKSAK_CLOSE_ORDER_CHILD", "1")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "the child check failed: {stderr}");
    let failure = stderr
        .find("close s1: busy")
        .expect("the failure is logged");
    let mark = stderr
        .find("the closing entry ended")
        .expect("the mark is logged");
    assert!(
        failure < mark,
        "the closing entry ended before the failure was logged: {stderr}"
    );
}

// contract: sidecars.declaration.replaces-changed-folder
#[test]
fn declaration_replaces_a_sidecar_whose_folder_changed() {
    // Each folder holds a sidecar that answers every request with the name of its folder.
    let root = folder::Folder::new();
    let folder = |name: &str| {
        let directory = root.path().join(name);
        std::fs::create_dir_all(&directory).unwrap();
        folder::install_fixture(
            &directory,
            "answer",
            &format!("on any reply {{\"surface\":\"s1\",\"body\":{{\"from\":\"{name}\"}}}}\n"),
        );
        directory
    };
    let files: Files = vec![(
        ECHO,
        r#"{"executable":"answer","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_string(),
    )];
    let (first, second) = (folder("first"), folder("second"));
    let sidecars = create(&files, &first).unwrap();
    let (window, messages, failures) = failing_owner("a", "/projects/replace");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    assert_eq!(messages.recv().unwrap().body.get(), r#"{"from":"first"}"#);
    sidecars.declare(&declare(&files, &second)).unwrap();
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":2}"#))
        .unwrap();
    assert_eq!(
        messages.recv().unwrap().body.get(),
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
        let control = r#"on 2 drop
on 4 flood 2 {"surface":"s1","closed":true}
on any echo
"#;
        let (sidecars, snapshots, _directory) = closing_sidecars(control);
        let (window, events) = owner("a", "/projects/closing");
        for _ in 0..2 {
            sidecars
                .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
                .unwrap();
            events.recv().unwrap();
            sidecars.retain(&window, &|_| false).unwrap();
            assert_eq!(snapshots.recv().unwrap(), closing_of("s1"));
        }
        while !snapshots.recv().unwrap().is_empty() {}
        // The echo of a later request follows both answers in the output, so a failure of either answer is logged first.
        sidecars
            .send(&window, ECHO, "s2", &raw(r#"{"data":2}"#))
            .unwrap();
        events.recv().unwrap();
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
        r#"skip-line
write {"surface":"s1","closed":true}
on any drop
"#,
    );
    let (window, _events, failures) = failing_owner("a", "/projects/closing");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    let failure = failures.recv().unwrap();
    assert_eq!(failure.reason, "unexpected close answer for s1");
    sidecars.stop();
}

// contract: sidecars.close.process-end-clears-closing
#[test]
fn ended_sidecar_leaves_no_closing_surface() {
    // It answers the first request, and when it receives closed it ends without answering.
    let (sidecars, snapshots, _directory) = closing_sidecars("on 1 echo\non 2 exit 0\n");
    let (window, _events) = owner("a", "/projects/closing");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"data":1}"#))
        .unwrap();
    sidecars.retain(&window, &|_| false).unwrap();
    assert_eq!(snapshots.recv().unwrap(), closing_of("s1"));
    assert_eq!(snapshots.recv().unwrap(), vec![]);
    sidecars.stop();
}

const DROPPED_LOG_CHILD: &str = "SOKSAK_DROPPED_LOG_CHILD";

// A message of a surface that no window owns is discarded and recorded with its body.
// contract: sidecars.protocol.dropped-message-is-recorded
#[test]
fn a_dropped_sidecar_message_is_recorded() {
    if let Some(config) = std::env::var_os(DROPPED_LOG_CHILD) {
        soksak_host::application_log::start_standard_error(
            std::path::Path::new(&config),
            "com.soksak.test",
        )
        .unwrap();
        let writer = records::start_writer(std::path::Path::new(&config));
        let (sidecars, _directory) = fixture_sidecars(
            r#"skip-line
skip-line
skip-line
write {"surface":"s2","body":"late"}
write {"surface":"s1","body":"after"}
drain /dev/null
"#,
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
        let event = events.recv().expect("no sidecar event; the test stalled");
        assert_eq!(event.surface, "s1");
        writer.flush().unwrap();
        // The sidecar ends at its stop, which ends by that exit; a stop that does not end stops at the limit of the
        // runner.
        sidecars.stop();
        return;
    }
    let config = folder::Folder::new();
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
    child::require_success(&output, config.path());
    let log = records::text_of(&records::read_events(&records::event_log_path(
        config.path(),
    )));
    let want = format!(
        " warn host sidecar {ECHO}: message for surface s2 dropped: no window owns the surface: \"late\""
    );
    assert!(log.contains(&want), "no {want:?} in {log}");
}

// contract: sidecars.lifetime.start-and-exit-events
#[test]
fn the_lifetime_of_a_sidecar_is_recorded_as_events() {
    // The writer of the records is shared by the process, so the scenario runs in a child process that nothing else writes in.
    if let Some(config) = std::env::var_os("SOKSAK_LIFETIME_CHILD") {
        // The first process ends by itself with a status; the second ends when the host stops it. It ignores the
        // terminate signal of the stop, so it ends with its input and its status is 0. It answers its first line after
        // it set the trap, so the answer is the event that it ignores the signal.
        let (sidecars, _directory) = fixture_sidecars(
            r#"if-present DIR/ran second
touch DIR/ran
skip-line
exit 3
label second
ignore-term
skip-line
write {"surface":"s2","body":"trapped"}
drain /dev/null
"#,
        );
        let writer = records::start_writer(Path::new(&config));
        let (first, first_events, failures) = failing_owner("a", "/projects/a");
        sidecars
            .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        failures
            .recv()
            .expect("no sidecar failure; the test stalled");
        sidecars
            .send(&first, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        first_events.recv().unwrap();
        sidecars.stop();
        writer.flush().unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_lifetime_of_a_sidecar_is_recorded_as_events",
            "--nocapture",
        ])
        .env("SOKSAK_LIFETIME_CHILD", config.path())
        .output()
        .unwrap();
    child::require_success(&output, config.path());
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
        let (sidecars, _directory) = fixture_sidecars("drain /dev/null\n");
        let writer = records::start_writer(Path::new(&config));
        soksak_host::performance::command(serde_json::json!({"action": "on"})).unwrap();
        records::wait_for_first_sample(Path::new(&config), &writer);
        let (owner, _events) = owner("a", "/projects/a");
        sidecars
            .send(&owner, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
            .unwrap();
        soksak_host::performance::sample();
        sidecars.stop();
        soksak_host::performance::sample();
        soksak_host::performance::command(serde_json::json!({"action": "off"})).unwrap();
        writer.flush().unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_sampler_names_a_running_sidecar_until_it_ends",
            "--nocapture",
        ])
        .env("SOKSAK_SAMPLER_CHILD", config.path())
        .output()
        .unwrap();
    child::require_success(&output, config.path());
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
        let (sidecars, _directory) = fixture_sidecars("drain /dev/null\n");
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
        writer.flush().unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_request_with_cids_is_recorded_as_an_event",
            "--nocapture",
        ])
        .env("SOKSAK_REQUEST_CHILD", config.path())
        .output()
        .unwrap();
    child::require_success(&output, config.path());
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
    let (sidecars, directory) = fixture_sidecars("on any tee DIR/requests\n");
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
    events.recv().unwrap();
    events.recv().unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        "{\"surface\":\"s1\",\"root\":\"/projects/a\",\"cids\":[\"b1.7\",\"b1.8\"],\"body\":{\"operation\":\"input\"}}\n\
         {\"surface\":\"s1\",\"root\":\"/projects/a\",\"body\":{\"operation\":\"input\"}}\n"
    );
}

/// A control text that answers three requests: an error with identifiers, an answer with identifiers, and an error without,
/// and then sends a message that is no reply.
const REPLY_CONTROL: &str = r#"skip-line
write {"surface":"s1","cids":["b1.7","b1.8"],"body":{"id":1,"error":"unsupported operation"}}
skip-line
write {"surface":"s1","cids":["b1.9"],"body":{"id":2,"ok":true}}
skip-line
write {"surface":"s1","body":{"id":3,"error":{"reason":"no request"}}}
write {"surface":"s1","body":{"event":"state"}}
drain /dev/null
"#;

/// Runs the scenario `name` of this file in a child process that nothing else writes in, with the configuration folder in the
/// variable `variable`, and returns the output of the child and the events `host.sidecar.reply` that it stored.
fn replies_of_child(name: &str, variable: &str) -> (String, Vec<serde_json::Value>) {
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env(variable, config.path())
        .output()
        .unwrap();
    child::require_success(&output, config.path());
    let replies = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.sidecar.reply")
        .collect();
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        replies,
    )
}

// contract: sidecars.protocol.reply-cids-reach-the-owner
#[test]
fn a_message_of_a_sidecar_reaches_its_owner_with_the_identifiers_of_its_request() {
    let (sidecars, _directory) = fixture_sidecars(REPLY_CONTROL);
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
    assert_eq!(events.recv().unwrap().cids, ["b1.7", "b1.8"]);
    sidecars
        .send_with_cids(&window, ECHO, "s1", &body, &["b1.9".to_string()])
        .unwrap();
    assert_eq!(events.recv().unwrap().cids, ["b1.9"]);
    sidecars.send(&window, ECHO, "s1", &body).unwrap();
    assert!(events.recv().unwrap().cids.is_empty());
}

// contract: sidecars.protocol.reply-with-cids-is-recorded
#[test]
fn a_reply_of_a_sidecar_is_recorded_with_the_identifiers_of_its_request() {
    // The writer of the records is shared by the process, so the scenario runs in a child process that nothing else writes in.
    if let Some(config) = std::env::var_os("SOKSAK_REPLY_CHILD") {
        let (sidecars, _directory) = fixture_sidecars(REPLY_CONTROL);
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
        events.recv().unwrap();
        sidecars
            .send_with_cids(&window, ECHO, "s1", &body, &["b1.9".to_string()])
            .unwrap();
        events.recv().unwrap();
        sidecars.send(&window, ECHO, "s1", &body).unwrap();
        events.recv().unwrap();
        events.recv().unwrap();
        sidecars.stop();
        writer.flush().unwrap();
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
        let (sidecars, _directory) = fixture_sidecars("skip-line\nskip-line\nexit 3\n");
        let writer = records::start_writer(Path::new(&config));
        let (window, _events, failures) = failing_owner("a", "/projects/a");
        let body = raw(r#"{"operation":"input"}"#);
        sidecars
            .send_with_cids(&window, ECHO, "s1", &body, &["b1.7".to_string()])
            .unwrap();
        sidecars
            .send_with_cids(&window, ECHO, "s1", &body, &["b1.8".to_string()])
            .unwrap();
        let failure = failures.recv().unwrap();
        sidecars.stop();
        writer.flush().unwrap();
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
    // The sidecar sends a transfer image of the closed surface s2, reads the answer of the host and returns it as a message
    // of s1.
    let (sidecars, _directory) = fixture_sidecars(concat!(
        "skip-line\nskip-line\nskip-line\n",
        "write {\"surface\":\"s2\",\"body\":{\"image\":{\"format\":\"bgra8\",\"generation\":3,\"height\":10,\"name\":\"view\",\"raster\":4,\"scale\":1.0,\"sequence\":5,\"token\":{\"id\":7,\"kind\":\"iosurface-global\"},\"width\":10}}}\n",
        "on 1 reply-raw s1\non any drop\n",
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
        .recv()
        .expect("no answer of the image of the closed surface; the test stalled");
    let answer: serde_json::Value = serde_json::from_str(event.body.get()).unwrap();
    assert_eq!(event.surface, "s1");
    assert_eq!(
        answer,
        serde_json::json!({"surface": "s2", "body": {"image": {"error": "closed", "name": "view", "generation": 3, "raster": 4, "sequence": 5}}})
    );
    // The sidecar ends at its stop, which ends by that exit; a stop that does not end stops at the limit of the runner.
    sidecars.stop();
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
        Err(soksak_host::sidecars::ResponseError::Ended(text)) => {
            assert_eq!(text, format!("sidecar {ECHO} is not running"));
        }
        other => panic!("{other:?}"),
    }
}

// contract: sidecars.trace.first-answer-after-spawn-is-recorded
#[test]
fn standard_io_sidecar_first_answer_after_spawn_is_recorded() {
    // The switch of the trace belongs to the process, so the check runs in a child process that nothing else shares it with.
    if std::env::var_os("SOKSAK_READY_TRACE_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "standard_io_sidecar_first_answer_after_spawn_is_recorded",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("SOKSAK_READY_TRACE_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "the child check failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let (sidecars, directory) = fixture_sidecars(
        r#"record-pid DIR/pid
skip-line
write {"surface":"s1","body":{"event":"state"}}
on any drop
"#,
    );
    let events_directory = folder::Folder::new();
    let writer = records::start_writer(events_directory.path());
    soksak_host::performance::command(serde_json::json!({"action": "on"})).unwrap();
    let (window, events) = owner("a", "/projects/test");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
        .unwrap();
    events.recv().expect("no event; the test stalled");
    sidecars.stop();
    // Turning the trace off joins the sampler, so no process that it started outlives the check.
    soksak_host::performance::command(serde_json::json!({"action": "off"})).unwrap();
    writer.flush().unwrap();
    let records_of_the_run = records::read_events(writer.path());
    soksak_host::event_record::use_host_event_log(None);
    assert!(
        !soksak_host::performance::sampler_running(),
        "the check left the sampler of the trace running"
    );
    let ready = records_of_the_run
        .iter()
        .find(|record| record["event"] == "host.trace.sidecar.ready")
        .expect("the first answer after the spawn was not recorded");
    assert_eq!(ready["level"], "debug");
    assert_eq!(ready["fields"]["sidecar"], ECHO);
    assert_eq!(
        ready["fields"]["pid"].as_i64(),
        Some(i64::from(process_id(directory.path())))
    );
    assert!(
        ready["fields"]["ms"].as_f64().is_some_and(|ms| ms >= 0.0),
        "ms = {}, want a number of milliseconds from the spawn",
        ready["fields"]["ms"]
    );
}

/// The restart control: each request gets an invalid message, unless the file ok exists in the folder; then the process
/// answers its first request with that request and runs without failing.
const RESTART_CONTROL: &str = r#"if-absent DIR/ok invalid
echo-line
sleep 600
label invalid
skip-line
write not json
sleep 600
"#;

/// A clock that a restart-limit check moves. Its time is the base plus the offset that the check set.
#[derive(Clone)]
struct RestartClock {
    base: std::time::Instant,
    offset: Arc<Mutex<Duration>>,
}

impl RestartClock {
    fn new() -> Self {
        Self {
            base: std::time::Instant::now(),
            offset: Arc::new(Mutex::new(Duration::ZERO)),
        }
    }

    fn set(&self, offset: Duration) {
        *self.offset.lock().unwrap() = offset;
    }

    fn read(&self) -> std::time::Instant {
        self.base + *self.offset.lock().unwrap()
    }
}

/// Creates a channel that declares the sidecar fixture with the restart control, which plugin-a lists in dependencies,
/// with the injected clock, and its folder.
fn restart_sidecars(clock: &RestartClock) -> (Stopping, folder::Folder) {
    let directory = folder::Folder::new();
    directory.fixture(
        "fixture",
        &RESTART_CONTROL.replace("DIR", &directory.path().display().to_string()),
    );
    let declarations = vec![SidecarDeclaration {
        name: ECHO.to_string(),
        folder: directory.path().to_path_buf(),
        data: br#"{"executable":"fixture","displayName":"soksak://sidecar/probe","protocol":1}"#
            .to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: vec!["plugin-a".to_string()],
    }];
    let clock = clock.clone();
    let sidecars = Sidecars::new(&declarations, directory.path().to_path_buf())
        .unwrap()
        .with_clock(move || clock.read());
    (Stopping(sidecars), directory)
}

/// Moves the clock to offset and sends an open request of surface from window.
fn send_at(
    clock: &RestartClock,
    sidecars: &Stopping,
    window: &FakeOwner,
    surface: &str,
    offset: Duration,
) -> Result<(), String> {
    clock.set(offset);
    sidecars.send(window, ECHO, surface, &raw(r#"{"operation":"open"}"#))
}

/// Waits for the next failure of the window and checks that it is an invalid message of sidecar s1.
fn require_invalid_failure(failures: &Receiver<Failure>, offset: Duration) {
    let failure = failures
        .recv()
        .expect("no sidecar failure; the test stalled");
    assert!(
        failure.sidecar == ECHO
            && failure.surface == "s1"
            && failure.reason.contains("invalid message"),
        "failure at {offset:?} = {failure:?}"
    );
}

/// Checks that err is the refusal of a sidecar at its restart limit.
fn require_restart_limit(result: Result<(), String>, offset: Duration) {
    let error = result.expect_err("send was not refused");
    assert_eq!(
        error,
        format!("sidecar {ECHO}: restart limit"),
        "send at {offset:?}"
    );
}

// contract: sidecars.restart.three-failures-restart
#[test]
fn restarts_after_three_failures_within_the_window() {
    let clock = RestartClock::new();
    let (sidecars, directory) = restart_sidecars(&clock);
    let (window, events, failures) = failing_owner("a", "/projects/a");
    for seconds in [0, 10, 20] {
        let offset = Duration::from_secs(seconds);
        send_at(&clock, &sidecars, &window, "s1", offset).unwrap();
        require_invalid_failure(&failures, offset);
    }
    // After three failures within 300 seconds the next send starts a process, which runs without failing.
    std::fs::write(directory.path().join("ok"), b"").unwrap();
    send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(30)).unwrap();
    // The answer comes after the check of the file, so the restarted process writes no invalid message after it, and a
    // failure that its start caused is delivered before it.
    events.recv().unwrap();
    assert!(failures.try_recv().is_err(), "the restarted sidecar failed");
    // The restarted sidecar does not read its input and ends at the terminate signal of the stop.
    sidecars.stop();
}

// contract: sidecars.restart.fourth-failure-stops
#[test]
fn stops_at_the_fourth_failure_within_the_window() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let clock = RestartClock::new();
    let (sidecars, _directory) = restart_sidecars(&clock);
    let writer_folder = folder::Folder::new();
    let writer = records::start_writer(writer_folder.path());
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    for seconds in [0, 10, 20, 30] {
        let offset = Duration::from_secs(seconds);
        send_at(&clock, &sidecars, &window, "s1", offset).unwrap();
        require_invalid_failure(&failures, offset);
    }
    // The fourth failure stops the restarts: the next send starts no process and fails with the reason restart limit.
    require_restart_limit(
        send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(40)),
        Duration::from_secs(40),
    );
    let refused = failures.recv().expect("no refusal failure");
    assert!(
        refused.sidecar == ECHO && refused.surface == "s1" && refused.reason == "restart limit",
        "refused send failure = {refused:?}"
    );
    sidecars.stop();
    writer.flush().unwrap();
    let events = records::read_events(&records::event_log_path(writer_folder.path()));
    assert!(
        events.iter().any(
            |event| event["event"] == "host.sidecar.restart-limit" && event["level"] == "error"
        ),
        "the stop recorded no host.sidecar.restart-limit error event"
    );
}

// contract: sidecars.restart.old-failure-not-counted
#[test]
fn counts_only_failures_within_the_window() {
    let clock = RestartClock::new();
    let (sidecars, _directory) = restart_sidecars(&clock);
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    // The failure at 0 seconds is more than 300 seconds before the failure at 305 seconds, so it is not counted there.
    for seconds in [0, 10, 20, 305] {
        let offset = Duration::from_secs(seconds);
        send_at(&clock, &sidecars, &window, "s1", offset).unwrap();
        require_invalid_failure(&failures, offset);
    }
    // At 305 seconds three failures are counted, so the send at 306 seconds starts a process; its failure is the fourth counted.
    send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(306)).unwrap();
    require_invalid_failure(&failures, Duration::from_secs(306));
    require_restart_limit(
        send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(307)),
        Duration::from_secs(307),
    );
}

// contract: sidecars.restart.surface-open-resets-the-record
#[test]
fn surface_open_clears_the_restart_limit() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let _trace = records::trace_on();
    let clock = RestartClock::new();
    let (sidecars, directory) = restart_sidecars(&clock);
    let writer_folder = folder::Folder::new();
    let writer = records::start_writer(writer_folder.path());
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    for seconds in [0, 10, 20, 30] {
        let offset = Duration::from_secs(seconds);
        send_at(&clock, &sidecars, &window, "s1", offset).unwrap();
        require_invalid_failure(&failures, offset);
    }
    require_restart_limit(
        send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(40)),
        Duration::from_secs(40),
    );
    failures.recv().expect("no refusal failure");
    // The creation of a surface of a plugin that does not list the sidecar leaves the stop in place.
    sidecars.surface_opened("plugin-b", "s2");
    require_restart_limit(
        send_at(&clock, &sidecars, &window, "s2", Duration::from_secs(41)),
        Duration::from_secs(41),
    );
    failures.recv().expect("no refusal failure");
    // The creation of a surface of plugin-a, which lists the sidecar, clears the record; the next send starts the process.
    std::fs::write(directory.path().join("ok"), b"").unwrap();
    sidecars.surface_opened("plugin-a", "s2");
    send_at(&clock, &sidecars, &window, "s2", Duration::from_secs(42)).unwrap();
    send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(43)).unwrap();
    // The restarted sidecar does not read its input and ends at the terminate signal of the stop.
    sidecars.stop();
    writer.flush().unwrap();
    let events = records::read_events(&records::event_log_path(writer_folder.path()));
    let reset = events
        .iter()
        .find(|event| event["event"] == "host.trace.sidecar.restart-reset")
        .expect("the opened surface recorded no host.trace.sidecar.restart-reset");
    assert_eq!(reset["fields"]["sidecar"], ECHO, "restart-reset {reset}");
    assert_eq!(reset["fields"]["surface"], "s2", "restart-reset {reset}");
}

// contract: sidecars.restart.enable-clears-stops
#[test]
fn enable_clears_the_restart_limit_of_its_sidecars() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let _trace = records::trace_on();
    let clock = RestartClock::new();
    let (sidecars, directory) = restart_sidecars(&clock);
    let writer_folder = folder::Folder::new();
    let writer = records::start_writer(writer_folder.path());
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    for seconds in [0, 10, 20, 30] {
        let offset = Duration::from_secs(seconds);
        send_at(&clock, &sidecars, &window, "s1", offset).unwrap();
        require_invalid_failure(&failures, offset);
    }
    require_restart_limit(
        send_at(&clock, &sidecars, &window, "s1", Duration::from_secs(40)),
        Duration::from_secs(40),
    );
    failures.recv().expect("no refusal failure");
    // The enable of a plugin that does not list the sidecar leaves the stop in place.
    sidecars.plugin_enabled("plugin-b");
    require_restart_limit(
        send_at(&clock, &sidecars, &window, "s2", Duration::from_secs(41)),
        Duration::from_secs(41),
    );
    failures.recv().expect("no refusal failure");
    // The enable of plugin-a, which lists the sidecar, clears the record; the next send starts the process.
    std::fs::write(directory.path().join("ok"), b"").unwrap();
    sidecars.plugin_enabled("plugin-a");
    send_at(&clock, &sidecars, &window, "s2", Duration::from_secs(42)).unwrap();
    sidecars.stop();
    writer.flush().unwrap();
    let events = records::read_events(&records::event_log_path(writer_folder.path()));
    let reset = events
        .iter()
        .find(|event| {
            event["event"] == "host.trace.sidecar.restart-reset"
                && event["fields"]["plugin"] == "plugin-a"
        })
        .expect("the enable of plugin-a recorded no host.trace.sidecar.restart-reset");
    assert_eq!(reset["fields"]["sidecar"], ECHO, "restart-reset {reset}");
}

/// Waits for the next failure of the window and checks that it is an invalid message of surface.
fn require_invalid_failure_of(failures: &Receiver<Failure>, surface: &str, offset: Duration) {
    let failure = failures
        .recv()
        .expect("no sidecar failure; the test stalled");
    assert!(
        failure.sidecar == ECHO
            && failure.surface == surface
            && failure.reason.contains("invalid message"),
        "failure of {surface} at {offset:?} = {failure:?}"
    );
}

// contract: sidecars.restart.refuses-already-open-surface
#[test]
fn refuses_an_already_open_surface() {
    let clock = RestartClock::new();
    let (sidecars, _directory) = restart_sidecars(&clock);
    let (first, _first_events, first_failures) = failing_owner("a", "/projects/b");
    let (second, _second_events, second_failures) = failing_owner("b", "/projects/a");
    // s3 is open: its request failed the first process, which is not the process that stops.
    send_at(&clock, &sidecars, &first, "s3", Duration::ZERO).unwrap();
    require_invalid_failure_of(&first_failures, "s3", Duration::ZERO);
    for seconds in [10, 20, 30] {
        let offset = Duration::from_secs(seconds);
        send_at(&clock, &sidecars, &second, "s1", offset).unwrap();
        require_invalid_failure_of(&second_failures, "s1", offset);
    }
    // The fourth failure stopped the sidecar. s3 is open, so its next request is refused too.
    require_restart_limit(
        send_at(&clock, &sidecars, &first, "s3", Duration::from_secs(40)),
        Duration::from_secs(40),
    );
    let refused = first_failures.recv().expect("no refusal failure");
    assert!(
        refused.surface == "s3" && refused.reason == "restart limit",
        "refused send failure = {refused:?}"
    );
}

// contract: sidecars.disconnect.record-end
#[test]
fn a_disconnect_record_names_how_the_connection_ended() {
    let fields = soksak_host::sidecars::disconnect_fields("svc", 42, false, "", "eof", 2);
    assert_eq!(
        fields["end"], "eof",
        "the disconnect record names how the connection ended"
    );
    assert_eq!(
        fields["waiting"], 2,
        "the disconnect record counts the requests that waited"
    );
}

/// Makes the FIFO DIR/name to which the sidecar writes the process id of a process that it started.
fn child_fifo(directory: &Path, name: &str) -> std::path::PathBuf {
    let path = directory.join(name);
    let text = std::ffi::CString::new(path.display().to_string()).unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(text.as_ptr(), 0o600) },
        0,
        "mkfifo {}: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
    path
}

/// Makes the FIFO DIR/name and holds its write end while the returned file lives. A fixture process that reads it ends at the
/// end of the check, also when the check is killed, because the kernel then closes the write end.
fn hold_fifo(directory: &Path, name: &str) -> std::fs::File {
    let path = child_fifo(directory, name);
    // A read-write open does not wait for a reader, and the check holds the only writer.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap()
}

/// The process id that the sidecar writes to the FIFO path; the read ends when the sidecar closes its write.
fn child_pid(path: &Path) -> i32 {
    let text = std::fs::read_to_string(path).unwrap();
    let pid = text.trim().parse::<i32>().unwrap();
    assert!(pid > 0, "the sidecar wrote {text:?} as a process id");
    pid
}

/// Kills the process when the check ends, so that no process of a check remains.
struct Killed(i32);

impl Drop for Killed {
    fn drop(&mut self) {
        unsafe { libc::kill(self.0, libc::SIGKILL) };
    }
}

/// Waits for the exit of the process pid, as a process of an ended process group exits; a process that is gone already has
/// exited too (ESRCH).
fn require_gone(pid: i32) {
    let queue = unsafe { libc::kqueue() };
    assert!(queue >= 0, "kqueue: {}", std::io::Error::last_os_error());
    let change = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_ONESHOT,
        fflags: libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    let mut event: libc::kevent = unsafe { std::mem::zeroed() };
    let result = loop {
        let count = unsafe { libc::kevent(queue, &change, 1, &mut event, 1, std::ptr::null()) };
        if count >= 0 {
            break Ok(count);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINTR) {
            break Err(error);
        }
    };
    unsafe { libc::close(queue) };
    match result {
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
        Err(error) => panic!("watch the exit of process {pid}: {error}"),
        Ok(1)
            if event.flags & libc::EV_ERROR != 0 && event.data != libc::ESRCH as libc::intptr_t =>
        {
            panic!(
                "watch the exit of process {pid}: {}",
                std::io::Error::from_raw_os_error(event.data as i32)
            )
        }
        Ok(_) => {}
    }
}

// The end of a sidecar is the exit of its process: a process that it started keeps its output open, and the exit still fails the
// running sidecar and ends its process group (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
#[test]
fn a_sidecar_that_exits_fails_while_its_child_keeps_the_output() {
    let (sidecars, directory) = fixture_sidecars(
        r#"record-pid DIR/pid
holder DIR/hold DIR/child
skip-line
exit 3
"#,
    );
    let _hold = hold_fifo(directory.path(), "hold");
    let fifo = child_fifo(directory.path(), "child");
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let child = child_pid(&fifo);
    let killed = Killed(child);
    // A host that waits for the end of the output delivers no failure, and the check stops at the limit of its runner.
    let failure = failures
        .recv()
        .expect("the sidecar ended without a failure");
    assert_eq!(failure.surface, "s1");
    assert_eq!(failure.reason, "output closed: exit status 3");
    require_gone(child);
    drop(killed);
    sidecars.stop();
}

// A process that left the process group of the sidecar and keeps its output open does not hold the end of the sidecar
// (docs/spec/sidecars.md#declaration-and-startup).
// The first perl process exits only after the second one left the group: it reads its end of a pipe whose write end the second
// process closes after setsid. Without that order the sidecar could read the request and exit while the second process was
// still in the group, the end of the group killed it before it wrote its process id, and the check waited for that id.
// contract: sidecars.end.is-the-process-exit
#[test]
fn a_sidecar_that_exits_fails_while_a_process_outside_its_group_keeps_the_output() {
    let (sidecars, directory) = fixture_sidecars(
        r#"record-pid DIR/pid
detached DIR/hold DIR/child
skip-line
exit 3
"#,
    );
    let _hold = hold_fifo(directory.path(), "hold");
    let fifo = child_fifo(directory.path(), "child");
    let (window, _events, failures) = failing_owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let child = child_pid(&fifo);
    let killed = Killed(child);
    let failure = failures
        .recv()
        .expect("the sidecar ended without a failure");
    assert_eq!(failure.surface, "s1");
    assert_eq!(failure.reason, "output closed: exit status 3");
    drop(killed);
    sidecars.stop();
}

// A stop ends by the exit of the sidecar and ends its process group, also when a process that the sidecar started keeps its
// output open (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
#[test]
fn a_stop_ends_by_the_sidecar_exit_and_ends_its_process_group() {
    let (sidecars, directory) = fixture_sidecars(
        r#"record-pid DIR/pid
holder DIR/hold DIR/child
drain /dev/null
"#,
    );
    let _hold = hold_fifo(directory.path(), "hold");
    let fifo = child_fifo(directory.path(), "child");
    let (window, _events) = owner("a", "/projects/a");
    sidecars
        .send(&window, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let child = child_pid(&fifo);
    let _killed = Killed(child);
    // A stop that waits for the end of the output does not return, and the check stops at the limit of its runner.
    sidecars.stop();
    require_gone(child);
}
