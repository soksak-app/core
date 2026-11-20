//! The surface of a process (docs/spec/sidecars.md#process-identity), checked with real processes. The process sidecar is this
//! test binary: a script in the folder of the declaration runs the test `process_sidecar_role` of this binary with
//! PROCESS_SIDECAR set, and that test starts real shells for surfaces and answers the process queries. The test harness writes its
//! own lines to standard output, so the script moves standard output to descriptor 3, where the role writes its lines, and sends
//! the output of the harness to standard error.

#[path = "support/folder.rs"]
mod folder;
#[path = "support/sidecar_recorder.rs"]
mod sidecar_recorder;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use serde_json::value::RawValue;
use serde_json::{Value, json};
use sidecar_recorder::{SendAsRecorder, SidecarRecorder, owner};
use soksak_host::sidecars::{ProcessSurfaceError, SidecarDeclaration, Sidecars};

/// The variable that runs `process_sidecar_role` as the process sidecar.
const PROCESS_SIDECAR: &str = "SOKSAK_PROCESS_SIDECAR_ROLE";
const SIDECAR: &str = "@fixture/process-sidecar";

/// The start time of `pid` in milliseconds since the Unix epoch, as the process sidecar records it.
fn started(pid: u32) -> i64 {
    soksak_host::platform::current()
        .and_then(|platform| platform.process_entry(pid))
        .unwrap()
        .unwrap_or_else(|| panic!("process {pid} is not in the process table"))
        .started
}

/// Ends `child` and waits for it; the end of a sleep that the role or a test started is not a failure.
fn end(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The process sidecar: a body {"start": "surface"} starts a shell for the surface whose child sleeps and answers {"root",
/// "child"}; {"start": "helper"} starts a sleep for no surface and answers {"helper"}; a process query is answered from the
/// processes that it started, which it records before it answers the line that started them.
#[test]
fn process_sidecar_role() {
    if std::env::var_os(PROCESS_SIDECAR).is_none() {
        return;
    }
    // SAFETY: the script of the role opens descriptor 3 on the standard output of the sidecar, and nothing else owns it.
    let mut output = unsafe { std::fs::File::from_raw_fd(3) };
    let mut write = |value: Value| {
        let mut line = serde_json::to_vec(&value).unwrap();
        line.push(b'\n');
        output.write_all(&line).unwrap();
    };
    let mut records: HashMap<u32, (Option<String>, i64)> = HashMap::new();
    let mut children = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if let Some(process) = line.get("process").and_then(Value::as_u64) {
            let request = &line["request"];
            match records.get(&(process as u32)) {
                Some((Some(surface), at)) => write(
                    json!({"process": process, "request": request, "surface": surface, "started": at}),
                ),
                _ => write(json!({"process": process, "request": request, "surface": null})),
            }
            continue;
        }
        let surface = line["surface"].as_str().unwrap().to_string();
        if line.get("closed").is_some() {
            write(json!({"surface": surface, "closed": true}));
            continue;
        }
        match line["body"]["start"].as_str() {
            Some("surface") => {
                let mut shell = Command::new("/bin/sh")
                    .args(["-c", "/bin/sleep 600 & echo $!; wait"])
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap();
                let root = shell.id();
                records.insert(root, (Some(surface.clone()), started(root)));
                let mut first = String::new();
                BufReader::new(shell.stdout.take().unwrap())
                    .read_line(&mut first)
                    .unwrap();
                let child: u32 = first.trim().parse().unwrap();
                children.push(shell);
                write(json!({"surface": surface, "body": {"root": root, "child": child}}));
            }
            Some("helper") => {
                let helper = Command::new("/bin/sleep").arg("600").spawn().unwrap();
                records.insert(helper.id(), (None, started(helper.id())));
                write(json!({"surface": surface, "body": {"helper": helper.id()}}));
                children.push(helper);
            }
            other => panic!("unknown start {other:?}"),
        }
    }
    for child in children {
        end(child);
    }
    // The harness would write its result to the output of the sidecar after the test, so the role ends here.
    std::process::exit(0);
}

/// Declares the process sidecar in `folder` with the declaration `manifest`, whose executable is `role`.
fn process_sidecars(folder: &Path, manifest: &str) -> Sidecars<SidecarRecorder> {
    let script = format!(
        "#!/bin/sh\nexec 3>&1 1>&2\n{PROCESS_SIDECAR}=1 exec '{}' --exact process_sidecar_role --nocapture --test-threads=1\n",
        std::env::current_exe().unwrap().display()
    );
    let role = folder.join("role");
    std::fs::write(&role, script).unwrap();
    std::fs::set_permissions(&role, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    Sidecars::new(
        &[SidecarDeclaration {
            name: SIDECAR.to_string(),
            folder: folder.to_path_buf(),
            data: manifest.as_bytes().to_vec(),
            error: None,
            version: "0.0.1".to_string(),
            dependents: Vec::new(),
        }],
        folder.to_path_buf(),
    )
    .unwrap()
}

const WITH_PROCESSES: &str =
    r#"{"executable":"role","displayName":"soksak://sidecar/probe","protocol":1,"processes":true}"#;
const WITHOUT_PROCESSES: &str =
    r#"{"executable":"role","displayName":"soksak://sidecar/probe","protocol":1}"#;

/// Sends {"start": kind} for `surface` and returns the pids of the answer.
fn started_pids(
    sidecars: &Sidecars<SidecarRecorder>,
    surface: &str,
    kind: &str,
) -> HashMap<String, u32> {
    let (window, messages) = owner(surface, "/projects/a");
    let body = RawValue::from_string(format!(r#"{{"start":"{kind}"}}"#)).unwrap();
    sidecars.send_as(&window, SIDECAR, surface, &body).unwrap();
    let message = messages.recv().unwrap();
    assert_eq!(message.surface, surface);
    serde_json::from_str(message.body.get()).unwrap()
}

/// The text of a refusal of `process_surface`; another result fails the test.
fn refusal(result: Result<String, ProcessSurfaceError>) -> String {
    match result {
        Err(ProcessSurfaceError::Refused(text)) => text,
        other => panic!("process_surface = {other:?}, want a refusal"),
    }
}

// contract: sidecars.process-identity.answers-the-surface-of-the-process-chain
#[test]
fn the_surface_of_a_process_is_the_surface_of_the_nearest_sidecar_child() {
    let folder = folder::Folder::new();
    let sidecars = process_sidecars(folder.path(), WITH_PROCESSES);
    let first = started_pids(&sidecars, "tab-a", "surface");
    let second = started_pids(&sidecars, "tab-b", "surface");
    for (pid, want) in [
        (first["root"], "tab-a"),
        (first["child"], "tab-a"),
        (second["child"], "tab-b"),
    ] {
        assert_eq!(
            sidecars.process_surface(pid),
            Ok(want.to_string()),
            "process {pid}"
        );
    }
    sidecars.stop();
}

// contract: sidecars.process-identity.refuses-a-process-outside-every-surface
#[test]
fn the_surface_of_a_process_outside_every_surface_is_refused() {
    let folder = folder::Folder::new();
    let sidecars = process_sidecars(folder.path(), WITH_PROCESSES);
    started_pids(&sidecars, "tab-a", "surface");
    let outside = Command::new("/bin/sleep").arg("600").spawn().unwrap();
    let pid = outside.id();
    let text = refusal(sidecars.process_surface(pid));
    end(outside);
    assert_eq!(
        text,
        format!(
            "process {pid} is not a process of a surface: no parent process of it is a running sidecar of the application that started it for a surface"
        )
    );
    sidecars.stop();
}

// contract: sidecars.process-identity.refuses-a-helper-of-the-sidecar
#[test]
fn the_surface_of_a_process_that_the_sidecar_started_for_no_surface_is_refused() {
    let folder = folder::Folder::new();
    let sidecars = process_sidecars(folder.path(), WITH_PROCESSES);
    let helper = started_pids(&sidecars, "tab-a", "helper")["helper"];
    assert_eq!(
        refusal(sidecars.process_surface(helper)),
        format!(
            "process {helper} is not a process of a surface: sidecar {SIDECAR} did not start process {helper} for a surface"
        )
    );
    sidecars.stop();
}

// contract: sidecars.process-identity.asks-only-a-sidecar-that-declares-processes
#[test]
fn the_surface_of_a_process_of_a_sidecar_without_processes_is_refused() {
    let folder = folder::Folder::new();
    let sidecars = process_sidecars(folder.path(), WITHOUT_PROCESSES);
    let child = started_pids(&sidecars, "tab-a", "surface")["child"];
    assert_eq!(
        refusal(sidecars.process_surface(child)),
        format!(
            "process {child} is a process of sidecar {SIDECAR}, which declares no processes of surfaces"
        )
    );
    sidecars.stop();
}
