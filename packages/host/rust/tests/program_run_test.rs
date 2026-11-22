//! Tests of the program runs of plugin pages (docs/spec/native-surfaces.md#program-runs). Each test starts real programs
//! without a shell and carries the contract row that it checks.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use soksak_host::program_run::{
    Declaration, Declarations, End, Finished, ProgramRuns, RUNS_PER_SURFACE, Request, Slot,
};

#[path = "support/folder.rs"]
mod folder;

const SURFACE: &str = "surface-a";
const PLUGIN: &str = "plugin-a";

fn environment(project: &Path) -> Vec<(OsString, OsString)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("SOKSAK_CONFIG_DIR".into(), project.join("config").into_os_string()),
    ]
}

fn declared(program: &str, slots: Vec<Slot>) -> Declarations {
    Declarations::from([(
        "run".to_string(),
        Declaration {
            program: program.to_string(),
            slots,
        },
    )])
}

fn runs_with(declarations: Declarations) -> Arc<ProgramRuns> {
    let runs = Arc::new(ProgramRuns::new());
    runs.declare(SURFACE, PLUGIN, declarations);
    runs
}

fn request(id: u64, name: &str, args: &[&str], project: &Path) -> Request {
    Request {
        surface: SURFACE.to_string(),
        plugin: PLUGIN.to_string(),
        id,
        name: name.to_string(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        project: Some(project.to_path_buf()),
        environment: environment(project),
    }
}

fn script(project: &Path, relative: &str, body: &str) {
    let path = project.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A program that starts a child in the background, writes the identifier of the child to its first argument and waits.
const HOLDING_BODY: &str = "sleep 60 & echo $! > \"$1\"\nwait";

fn start_holding(
    runs: &Arc<ProgramRuns>,
    project: &Path,
    id: u64,
    marker: &Path,
) -> JoinHandle<Result<Finished, String>> {
    let runs = Arc::clone(runs);
    let request = request(id, "run", &[marker.to_str().unwrap()], project);
    std::thread::spawn(move || runs.run(request))
}

fn wait_for_child(marker: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(marker)
            && let Some(pid) = text.strip_suffix('\n')
        {
            return pid.parse().unwrap();
        }
        assert!(Instant::now() < deadline, "the program did not start {}", marker.display());
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn process_alive(pid: u32) -> bool {
    Command::new("/bin/ps")
        .args(["-p", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn assert_ends_with_group_kill(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(pid) {
        assert!(Instant::now() < deadline, "the child {pid} of the program still runs");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// contract: program.run.exit-reply
#[test]
fn a_program_that_exits_replies_with_its_status_and_output() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", "echo ok\necho warn >&2\nexit 3");
    let runs = runs_with(declared("bin/tool", vec![]));
    let finished = runs.run(request(1, "run", &[], project.path())).unwrap();
    assert_eq!(finished.end, None);
    assert_eq!(finished.code, Some(3));
    assert_eq!(finished.signal, None);
    assert_eq!(finished.stdout.text, "ok\n");
    assert_eq!(finished.stderr.text, "warn\n");
    assert!(!finished.stdout.truncated && !finished.stderr.truncated);
}

// contract: program.run.argument-vector-without-shell
#[test]
fn arguments_reach_the_program_unchanged_without_a_shell() {
    let project = folder::Folder::new();
    let slots = vec![
        Slot::Text("%s\n".to_string()),
        Slot::Pattern(".*".to_string()),
        Slot::Pattern(".*".to_string()),
        Slot::Pattern(".*".to_string()),
    ];
    let runs = runs_with(declared("/usr/bin/printf", slots));
    let finished = runs
        .run(request(1, "run", &["%s\n", "$HOME", ";", "a b"], project.path()))
        .unwrap();
    assert_eq!(finished.stdout.text, "$HOME\n;\na b\n");
}

// contract: program.run.working-directory-is-project
#[test]
fn the_working_directory_of_a_run_is_the_project_folder() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/bin/pwd", vec![]));
    let finished = runs.run(request(1, "run", &[], project.path())).unwrap();
    let printed = Path::new(finished.stdout.text.trim_end()).canonicalize().unwrap();
    assert_eq!(printed, project.path().canonicalize().unwrap());
}

// contract: program.run.path-lookup-as-terminal
#[test]
fn a_bare_name_is_found_through_the_path_of_the_run_environment() {
    let project = folder::Folder::new();
    script(project.path(), "tools/soksak-run-tool", "echo found");
    let runs = runs_with(declared("soksak-run-tool", vec![]));
    let mut found = request(1, "run", &[], project.path());
    let tools = project.path().join("tools");
    found.environment[0].1 = format!("{}:/usr/bin:/bin", tools.display()).into();
    assert_eq!(runs.run(found).unwrap().stdout.text, "found\n");

    let runs = runs_with(declared("soksak-no-such-tool", vec![]));
    let error = runs.run(request(2, "run", &[], project.path())).unwrap_err();
    assert_eq!(error, "program not found: soksak-no-such-tool");
}

// contract: program.run.relative-path-from-project
#[test]
fn a_path_with_a_separator_resolves_from_the_project_folder() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", "echo relative");
    let runs = runs_with(declared("bin/tool", vec![]));
    assert_eq!(
        runs.run(request(1, "run", &[], project.path())).unwrap().stdout.text,
        "relative\n"
    );
    let runs = runs_with(declared("/usr/bin/printf", vec![Slot::Text("absolute\n".to_string())]));
    assert_eq!(
        runs.run(request(2, "run", &["absolute\n"], project.path()))
            .unwrap()
            .stdout
            .text,
        "absolute\n"
    );
}

// contract: program.run.environment-as-sidecar
#[test]
fn the_program_receives_exactly_the_environment_of_the_run() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/usr/bin/env", vec![]));
    let mut run = request(1, "run", &[], project.path());
    run.environment = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("SOKSAK_CONFIG_DIR".into(), "/cfg".into()),
    ];
    let finished = runs.run(run).unwrap();
    assert_eq!(
        finished.stdout.text,
        "PATH=/usr/bin:/bin\nSOKSAK_CONFIG_DIR=/cfg\n"
    );
}

// contract: program.run.standard-input-is-null
#[test]
fn a_program_that_reads_standard_input_receives_end_of_file() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/bin/cat", vec![]));
    let finished = runs.run(request(1, "run", &[], project.path())).unwrap();
    assert_eq!(finished.code, Some(0));
    assert_eq!(finished.stdout.text, "");
    assert_eq!(finished.stdout.bytes, 0);
}

// contract: program.run.output-bound-truncates
#[test]
fn output_beyond_the_bound_is_discarded_and_marked() {
    let project = folder::Folder::new();
    let slots = vec![
        Slot::Text("-c".to_string()),
        Slot::Text("1048577".to_string()),
        Slot::Text("/dev/zero".to_string()),
    ];
    let runs = runs_with(declared("/usr/bin/head", slots));
    let finished = runs
        .run(request(1, "run", &["-c", "1048577", "/dev/zero"], project.path()))
        .unwrap();
    assert_eq!(finished.end, None);
    assert_eq!(finished.stdout.text.len(), 1 << 20);
    assert_eq!(finished.stdout.bytes, (1 << 20) + 1);
    assert!(finished.stdout.truncated);
    assert!(!finished.stderr.truncated);
}

// contract: program.run.output-not-utf8-fails
#[test]
fn a_kept_stderr_that_is_not_utf8_fails_the_run() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", "printf '\\377' >&2");
    let runs = runs_with(declared("bin/tool", vec![]));
    let error = runs.run(request(1, "run", &[], project.path())).unwrap_err();
    assert_eq!(error, "program run: stderr is not UTF-8");
}

// contract: program.run.start-failure-text
#[test]
fn a_program_file_that_the_system_refuses_to_start_fails_the_run() {
    let project = folder::Folder::new();
    let path = project.path().join("bin/tool");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "not a program\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let runs = runs_with(declared("bin/tool", vec![]));
    let error = runs.run(request(1, "run", &[], project.path())).unwrap_err();
    assert!(
        error.starts_with("program bin/tool: start failed: "),
        "unexpected refusal: {error}"
    );
}

// contract: program.run.refuses-undeclared-name
#[test]
fn a_name_that_the_declaration_lacks_is_refused_before_a_start() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/bin/cat", vec![]));
    let error = runs
        .run(request(1, "missing", &[], project.path()))
        .unwrap_err();
    assert_eq!(error, "program missing is not declared by plugin-a");
}

// contract: program.run.refuses-argument-count
#[test]
fn two_arguments_for_one_slot_are_refused() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/bin/cat", vec![Slot::Pattern(".*".to_string())]));
    let error = runs
        .run(request(1, "run", &["a", "b"], project.path()))
        .unwrap_err();
    assert_eq!(error, "program run takes 1 arguments, 2 given");
}

// contract: program.run.refuses-argument-outside-pattern
#[test]
fn an_argument_that_does_not_match_its_pattern_in_full_is_refused() {
    let project = folder::Folder::new();
    let slots = vec![
        Slot::Text("a".to_string()),
        Slot::Pattern("[0-9]+".to_string()),
    ];
    let runs = runs_with(declared("/bin/cat", slots));
    let error = runs
        .run(request(1, "run", &["a", "12x"], project.path()))
        .unwrap_err();
    assert_eq!(error, "program run argument 2 12x does not match its pattern");
}

// contract: program.run.refuses-pattern-that-does-not-compile
#[test]
fn a_pattern_that_does_not_compile_is_refused() {
    let error = soksak_host::program_run::parse_declarations(&serde_json::json!({
        "run": {"program": "/bin/cat", "args": [{"pattern": "("}]}
    }))
    .unwrap_err();
    assert!(
        error.starts_with("programs.run pattern does not compile: "),
        "unexpected refusal: {error}"
    );
}

// contract: program.run.refuses-without-project
#[test]
fn a_run_from_a_window_without_a_project_is_refused() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/bin/cat", vec![]));
    let mut run = request(1, "run", &[], project.path());
    run.project = None;
    assert_eq!(
        runs.run(run).unwrap_err(),
        "program run: the window shows no project"
    );
}

// contract: program.run.refuses-fifth-open-run
#[test]
fn the_fifth_open_run_of_a_surface_is_refused_and_the_first_four_continue() {
    assert_eq!(RUNS_PER_SURFACE, 4);
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let markers: Vec<PathBuf> = (1..=4)
        .map(|id| project.path().join(format!("marker-{id}")))
        .collect();
    let handles: Vec<_> = markers
        .iter()
        .enumerate()
        .map(|(index, marker)| start_holding(&runs, project.path(), index as u64 + 1, marker))
        .collect();
    for marker in &markers {
        wait_for_child(marker);
    }
    let fifth = runs
        .run(request(5, "run", &[markers[0].to_str().unwrap()], project.path()))
        .unwrap_err();
    assert_eq!(fifth, "program run: 4 runs are open on surface surface-a");
    assert!(handles.iter().all(|handle| !handle.is_finished()));
    runs.end_surface(SURFACE);
    for handle in handles {
        let finished = handle.join().unwrap().unwrap();
        assert_eq!(finished.end, Some(End::SurfaceClosed));
    }
}

// contract: program.run.refuses-argument-not-equal-text
#[test]
fn a_literal_argument_that_differs_from_its_text_is_refused() {
    let project = folder::Folder::new();
    let runs = runs_with(declared("/bin/cat", vec![Slot::Text("a".to_string())]));
    let error = runs
        .run(request(1, "run", &["b"], project.path()))
        .unwrap_err();
    assert_eq!(error, "program run argument 1 b does not equal its text");
}

// contract: program.run.refuses-open-call-id
#[test]
fn a_view_call_identifier_that_names_an_open_run_is_refused() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let marker = project.path().join("marker-open");
    let handle = start_holding(&runs, project.path(), 1, &marker);
    wait_for_child(&marker);
    let again = runs
        .run(request(1, "run", &[marker.to_str().unwrap()], project.path()))
        .unwrap_err();
    assert_eq!(again, "program run: call 1 is already open on surface surface-a");
    runs.end_surface(SURFACE);
    let finished = handle.join().unwrap().unwrap();
    assert_eq!(finished.end, Some(End::SurfaceClosed));
}

// contract: program.run.cancel-ends-the-group
#[test]
fn a_cancel_sends_the_kill_to_the_group_and_sends_no_reply() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let marker = project.path().join("child");
    let handle = start_holding(&runs, project.path(), 1, &marker);
    let child = wait_for_child(&marker);
    runs.cancel(SURFACE, 1);
    let finished = handle.join().unwrap().unwrap();
    assert_eq!(finished.end, Some(End::Cancelled));
    assert_eq!(finished.code, None);
    assert_eq!(finished.signal.as_deref(), Some("SIGKILL"));
    assert_ends_with_group_kill(child);
}

// contract: program.run.view-end-ends-the-run
#[test]
fn the_end_of_the_view_ends_its_open_runs_with_process_ended() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let marker = project.path().join("child");
    let handle = start_holding(&runs, project.path(), 1, &marker);
    let child = wait_for_child(&marker);
    runs.end_view(SURFACE);
    let finished = handle.join().unwrap().unwrap();
    assert_eq!(finished.end, Some(End::ProcessEnded));
    assert_eq!(finished.signal.as_deref(), Some("SIGKILL"));
    assert_ends_with_group_kill(child);
}

// contract: program.run.surface-close-ends-the-run
#[test]
fn the_close_of_a_surface_ends_its_open_runs_with_surface_closed() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let marker = project.path().join("child");
    let handle = start_holding(&runs, project.path(), 1, &marker);
    wait_for_child(&marker);
    runs.end_surface(SURFACE);
    let finished = handle.join().unwrap().unwrap();
    assert_eq!(finished.end, Some(End::SurfaceClosed));
    let refused = runs
        .run(request(2, "run", &[marker.to_str().unwrap()], project.path()))
        .unwrap_err();
    assert_eq!(refused, "program run is not declared by plugin-a");
}

// contract: program.run.window-close-ends-the-run
#[test]
fn the_end_of_a_window_ends_its_open_runs_with_window_closed() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let marker = project.path().join("child");
    let handle = start_holding(&runs, project.path(), 1, &marker);
    wait_for_child(&marker);
    runs.end_window();
    let finished = handle.join().unwrap().unwrap();
    assert_eq!(finished.end, Some(End::WindowClosed));
}

// contract: program.run.declaration-is-checked-at-the-boundary
#[test]
fn a_declaration_is_read_with_its_slots_and_refuses_an_invalid_member() {
    let declarations = soksak_host::program_run::parse_declarations(&serde_json::json!({
        "lint": {"program": "bin/lint", "args": ["src", {"pattern": "[a-z]+"}]},
        "version": {"program": "/usr/bin/true"},
    }))
    .unwrap();
    assert_eq!(declarations["lint"].program, "bin/lint");
    assert_eq!(
        declarations["lint"].slots,
        vec![Slot::Text("src".to_string()), Slot::Pattern("[a-z]+".to_string())]
    );
    assert!(declarations["version"].slots.is_empty());

    let refused = |value: serde_json::Value| soksak_host::program_run::parse_declarations(&value).unwrap_err();
    assert_eq!(
        refused(serde_json::json!({"Lint": {"program": "x"}})),
        "programs.Lint name is not of the form [a-z][a-z0-9-]*"
    );
    assert_eq!(
        refused(serde_json::json!({"lint": {"program": "x", "extra": 1}})),
        "programs.lint has an unknown member extra"
    );
    assert_eq!(
        refused(serde_json::json!({"lint": {"program": "x", "args": [{"pattern": "a", "x": 1}]}})),
        "programs.lint args.0 is neither a text nor an object with the single member pattern"
    );
    let uncompiled = refused(serde_json::json!({"lint": {"program": "x", "args": [{"pattern": "("}]}}));
    assert!(
        uncompiled.starts_with("programs.lint pattern does not compile: "),
        "unexpected refusal: {uncompiled}"
    );
}

// contract: program.run.surface-close-ends-the-run
#[test]
fn a_placement_that_leaves_out_a_surface_ends_its_open_runs() {
    let project = folder::Folder::new();
    script(project.path(), "bin/tool", HOLDING_BODY);
    let runs = runs_with(declared("bin/tool", vec![Slot::Pattern(".*".to_string())]));
    let marker = project.path().join("child");
    let handle = start_holding(&runs, project.path(), 1, &marker);
    wait_for_child(&marker);
    runs.retain(&["another-surface"]);
    let finished = handle.join().unwrap().unwrap();
    assert_eq!(finished.end, Some(End::SurfaceClosed));
    let refused = runs
        .run(request(2, "run", &[marker.to_str().unwrap()], project.path()))
        .unwrap_err();
    assert_eq!(refused, "program run is not declared by plugin-a");
}
