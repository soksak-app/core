//! Checks the MCP registration and the setup parts (docs/spec/cli.md#mcp-registration, docs/spec/cli.md#setup-parts) with the
//! fixture program docs/spec/cases/setup/fixture.sh copied as the claude and sudo commands. Each test runs the built sok from an
//! application bundle folder of a disposable home, with an environment that holds only the variables that the test sets.

use std::path::{Path, PathBuf};

use serde_json::Value;

#[path = "support/agents.rs"]
mod agents;
#[path = "support/folder.rs"]
mod folder;
#[path = "support/policy.rs"]
mod policy;

use agents::{Machine, add_call, calls, entry, path_of, run_sok, skill_text};
use folder::Folder;

// contract: cli.mcp.install-requires-the-claude-command
#[test]
fn mcp_install_requires_the_claude_command() {
    let machine = Machine::new("mcp-no-claude");
    let sok = machine.bundle_sok("Test.app");
    let file = machine.home.join(".claude.json");
    std::fs::write(&file, b"{\"numStartups\":2}\n").expect("config");
    let run = run_sok(
        &sok,
        &["mcp", "install"],
        &[("HOME", &machine.home_text()), ("PATH", "/usr/bin:/bin")],
    );
    assert_eq!(
        (run.code, run.stdout.as_str(), run.stderr.as_str()),
        (
            1,
            "",
            format!("sok: the claude command is not on PATH; register the MCP server \"{} mcp\" (standard input and output) with the agent\n", sok.display()).as_str()
        )
    );
    assert_eq!(
        std::fs::read(&file).expect("config"),
        b"{\"numStartups\":2}\n"
    );
}

// contract: cli.mcp.install-registers-once
#[test]
fn mcp_install_registers_once() {
    let machine = Machine::new("mcp-once");
    let sok = machine.bundle_sok("Test.app");
    let path = machine.claude_path();
    let variables = [("HOME", machine.home_text()), ("PATH", path)];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let first = run_sok(&sok, &["mcp", "install"], &variables);
    assert_eq!(
        (first.code, first.stderr.as_str()),
        (0, ""),
        "{}",
        first.stdout
    );
    assert_eq!(
        first.json(),
        serde_json::json!({"registration": entry(&sok), "state": "registered"})
    );
    assert_eq!(calls(&machine), vec![add_call(&sok)]);
    let second = run_sok(&sok, &["mcp", "install"], &variables);
    assert_eq!(second.code, 0, "{}", second.stderr);
    assert_eq!(
        second.json(),
        serde_json::json!({"registration": entry(&sok), "state": "current"})
    );
    assert_eq!(calls(&machine), vec![add_call(&sok)]);
}

// contract: cli.mcp.install-registers-the-running-sok
#[test]
fn mcp_install_registers_the_running_sok() {
    let machine = Machine::new("mcp-running");
    let first = machine.bundle_sok("First.app");
    let second = machine.bundle_sok("Second.app");
    let path = path_of(&[
        first.parent().expect("first folder"),
        second.parent().expect("second folder"),
        &machine.tools(&["claude"]),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ]);
    let home = machine.home_text();
    let variables = [("HOME", home.as_str()), ("PATH", path.as_str())];
    let run_install = run_sok(&second, &["mcp", "install"], &variables);
    assert_eq!(run_install.code, 0, "{}", run_install.stderr);
    assert_eq!(
        run_install.json(),
        serde_json::json!({"registration": entry(&second), "state": "registered"})
    );
    assert_eq!(calls(&machine), vec![add_call(&second)]);
    let check = run_sok(&second, &["setup", "check"], &variables);
    let parts = check.json()["parts"].clone();
    let mcp = parts
        .as_array()
        .expect("parts")
        .iter()
        .find(|part| part["part"] == "mcp")
        .expect("mcp part")
        .clone();
    assert_eq!(mcp["state"], "ok", "{mcp}");
    // A second install from the same bundle with the current registration changes nothing.
    let again = run_sok(&second, &["mcp", "install"], &variables);
    assert_eq!(
        again.json(),
        serde_json::json!({"registration": entry(&second), "state": "current"})
    );
    assert_eq!(calls(&machine), vec![add_call(&second)]);
    // An install from the first bundle replaces the registration of the second one.
    let from_first = run_sok(&first, &["mcp", "install"], &variables);
    assert_eq!(
        from_first.json(),
        serde_json::json!({"registration": entry(&first), "state": "registered"})
    );
    assert_eq!(
        calls(&machine),
        vec![
            add_call(&second),
            "claude mcp remove --scope user soksak".to_string(),
            add_call(&first),
        ]
    );
}

// contract: cli.mcp.install-registers-a-moved-executable-again
#[test]
fn mcp_install_registers_a_moved_executable_again() {
    let earlier = [
        serde_json::json!({"type": "stdio", "command": "/Volumes/Old/Old.app/Contents/MacOS/sok", "args": ["mcp"]}),
        serde_json::json!({"type": "stdio", "command": "<sok>", "args": ["mcp", "--window", "main"]}),
        serde_json::json!({"type": "stdio", "command": "<sok>", "args": ["mcp"], "env": {"A": "1"}}),
    ];
    for registration in earlier {
        let machine = Machine::new("mcp-moved");
        let sok = machine.bundle_sok("Test.app");
        let mut registration = registration;
        if registration["command"] == "<sok>" {
            registration["command"] = Value::from(sok.display().to_string());
        }
        std::fs::write(
            machine.home.join(".claude.json"),
            serde_json::json!({"mcpServers": {"soksak": registration}}).to_string(),
        )
        .expect("config");
        let path = machine.claude_path();
        let run = run_sok(
            &sok,
            &["mcp", "install"],
            &[("HOME", &machine.home_text()), ("PATH", &path)],
        );
        assert_eq!(run.code, 0, "{}", run.stderr);
        assert_eq!(
            run.json(),
            serde_json::json!({"registration": entry(&sok), "state": "registered"})
        );
        assert_eq!(
            calls(&machine),
            vec![
                "claude mcp remove --scope user soksak".to_string(),
                add_call(&sok)
            ]
        );
    }
}

// contract: cli.mcp.install-reads-the-claude-config-dir
#[test]
fn mcp_install_reads_the_claude_config_dir() {
    let machine = Machine::new("mcp-config-dir");
    let sok = machine.bundle_sok("Test.app");
    let config = machine.root.path().join("claude-config");
    std::fs::create_dir(&config).expect("config");
    let path = machine.claude_path();
    let config_text = config.display().to_string();
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", path),
        ("CLAUDE_CONFIG_DIR", config_text.clone()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let install = run_sok(&sok, &["mcp", "install"], &variables);
    assert_eq!(install.code, 0, "{}", install.stderr);
    assert!(config.join(".claude.json").is_file());
    assert!(!machine.home.join(".claude.json").exists());
    let check = run_sok(&sok, &["setup", "check"], &variables);
    let parts = check.json()["parts"].clone();
    let mcp = parts
        .as_array()
        .expect("parts")
        .iter()
        .find(|part| part["part"] == "mcp")
        .expect("mcp part")
        .clone();
    assert_eq!(
        (mcp["file"].clone(), mcp["state"].clone()),
        (
            Value::from(config.join(".claude.json").display().to_string()),
            Value::from("ok")
        )
    );
}

// contract: cli.mcp.install-reports-claude-failures
#[test]
fn mcp_install_reports_claude_failures() {
    let old = serde_json::json!({"mcpServers": {"soksak": {"type": "stdio", "command": "/Old.app/Contents/MacOS/sok", "args": ["mcp"]}}}).to_string();
    // (earlier file, fault variable of the fixture, expected error without the sok: prefix)
    let cases: [(Option<&str>, (&str, &str), &str); 4] = [
        (
            None,
            ("SETUP_FIXTURE_FAIL", "add"),
            "claude mcp add failed with status 7: fixture add refused",
        ),
        (
            Some(&old),
            ("SETUP_FIXTURE_FAIL", "add"),
            "claude mcp add failed with status 7: fixture add refused; the earlier registration /Old.app/Contents/MacOS/sok was removed",
        ),
        (
            Some(&old),
            ("SETUP_FIXTURE_FAIL", "remove"),
            "claude mcp remove failed with status 7: fixture remove refused",
        ),
        (
            None,
            ("SETUP_FIXTURE_SKIP_WRITE", "1"),
            "claude mcp add did not write the registration to <file>",
        ),
    ];
    for (earlier, (fault, value), expected) in cases {
        let machine = Machine::new("mcp-failure");
        let sok = machine.bundle_sok("Test.app");
        let file = machine.home.join(".claude.json");
        if let Some(earlier) = earlier {
            std::fs::write(&file, earlier).expect("config");
        }
        let path = machine.claude_path();
        let run = run_sok(
            &sok,
            &["mcp", "install"],
            &[
                ("HOME", &machine.home_text()),
                ("PATH", &path),
                (fault, value),
            ],
        );
        let expected = expected.replace("<file>", &file.display().to_string());
        assert_eq!(
            (run.code, run.stdout.as_str(), run.stderr.as_str()),
            (1, "", format!("sok: {expected}\n").as_str())
        );
    }
    let machine = Machine::new("mcp-unparsed");
    let sok = machine.bundle_sok("Test.app");
    let file = machine.home.join(".claude.json");
    std::fs::write(&file, b"{\"mcpServers\": ").expect("config");
    let path = machine.claude_path();
    let run = run_sok(
        &sok,
        &["mcp", "install"],
        &[("HOME", &machine.home_text()), ("PATH", &path)],
    );
    assert_eq!(
        (run.code, run.stderr.as_str()),
        (
            1,
            format!(
                "sok: {} is not valid JSON at line 1 column 15\n",
                file.display()
            )
            .as_str()
        )
    );
    std::fs::write(&file, b"[1]").expect("config");
    let run = run_sok(
        &sok,
        &["mcp", "install"],
        &[("HOME", &machine.home_text()), ("PATH", &path)],
    );
    assert_eq!(
        run.stderr,
        format!("sok: {} is not a JSON object\n", file.display())
    );
    std::fs::write(&file, b"{\"mcpServers\": 3}").expect("config");
    let run = run_sok(
        &sok,
        &["mcp", "install"],
        &[("HOME", &machine.home_text()), ("PATH", &path)],
    );
    assert_eq!(
        run.stderr,
        format!("sok: {}: mcpServers is not an object\n", file.display())
    );
    assert_eq!(calls(&machine), Vec::<String>::new());
}

/// The setup of a test: the environment, a sok and a path entry folder of the test.
struct TestSetup {
    environment: soksak_sok::setup::Environment,
    sok: PathBuf,
    paths: PathBuf,
}

impl TestSetup {
    fn setup(&self) -> soksak_sok::setup::Setup<'_> {
        soksak_sok::setup::Setup {
            environment: &self.environment,
            sok: &self.sok,
            identifier: "com.soksak.test",
            paths_dir: Ok(&self.paths),
        }
    }
}

fn test_setup(machine: &Machine, bundle: &str) -> TestSetup {
    let sok = machine.bundle_sok(bundle);
    let paths = machine.root.path().join("paths.d");
    std::fs::create_dir(&paths).expect("paths.d");
    TestSetup {
        environment: soksak_sok::setup::Environment {
            home: Some(machine.home_text()),
            path: Some(path_of(&[
                &machine.tools(&["claude"]),
                Path::new("/usr/bin"),
                Path::new("/bin"),
            ])),
            claude_config_dir: None,
            variables: Default::default(),
        },
        sok,
        paths,
    }
}

fn parts_value(parts: &[soksak_sok::setup::Part]) -> Value {
    serde_json::to_value(parts).expect("parts")
}

// contract: cli.setup.check-reports-each-part
#[test]
fn setup_check_reports_each_part() {
    let machine = Machine::new("setup-check");
    let test = test_setup(&machine, "Test's App.app");
    let claude = machine.folder(".claude");
    let agents = machine.folder(".agents");
    std::fs::create_dir_all(agents.join("skills/soksak")).expect("skills");
    std::fs::write(agents.join("skills/soksak/SKILL.md"), b"old\n").expect("old");
    std::fs::write(
        machine.home.join(".claude.json"),
        serde_json::json!({"mcpServers": {"soksak": {"type": "stdio", "command": "/Old.app/Contents/MacOS/sok", "args": ["mcp"]}}}).to_string(),
    )
    .expect("config");
    let quoted = format!(
        "'{}'",
        test.sok.display().to_string().replace('\'', "'\\''")
    );
    assert!(quoted.contains("Test'\\''s App.app"), "{quoted}");
    let entry = test.paths.join("com.soksak.test");
    let parts = soksak_sok::setup::check(&test.setup()).expect("check");
    let expected = serde_json::json!([
        {"part": "path", "file": entry.display().to_string(), "state": "missing", "step": format!("sudo {quoted} path install"), "reason": "absent"},
        {"part": "skill", "file": claude.join("skills/soksak/SKILL.md").display().to_string(), "state": "missing", "step": format!("{quoted} skill install"), "reason": "absent"},
        {"part": "skill", "file": agents.join("skills/soksak/SKILL.md").display().to_string(), "state": "missing", "step": format!("{quoted} skill install"), "reason": "differs"},
        {"part": "mcp", "file": machine.home.join(".claude.json").display().to_string(), "state": "missing", "step": format!("{quoted} mcp install"), "reason": "differs"},
    ]);
    assert_eq!(parts_value(&parts), expected);
    assert_eq!(
        soksak_sok::setup::not_current(&parts, &[]),
        Some(format!(
            "setup parts are not current: path {}, skill {}, skill {}, mcp {}",
            entry.display(),
            claude.join("skills/soksak/SKILL.md").display(),
            agents.join("skills/soksak/SKILL.md").display(),
            machine.home.join(".claude.json").display()
        ))
    );
    // The check changed nothing.
    assert!(!claude.join("skills").exists());
    assert_eq!(
        std::fs::read(agents.join("skills/soksak/SKILL.md")).expect("old"),
        b"old\n"
    );
    // A path entry that differs, an unreadable skill file, and every part ok.
    std::fs::write(&entry, b"/elsewhere\n").expect("entry");
    std::fs::remove_file(agents.join("skills/soksak/SKILL.md")).expect("remove");
    std::fs::create_dir(agents.join("skills/soksak/SKILL.md")).expect("folder as file");
    let parts = soksak_sok::setup::check(&test.setup()).expect("check");
    let value = parts_value(&parts);
    assert_eq!(value[0]["reason"], "differs");
    assert_eq!(value[2]["state"], "error");
    assert_eq!(
        value[2]["error"],
        format!(
            "{}: is a directory",
            agents.join("skills/soksak/SKILL.md").display()
        )
    );
    std::fs::remove_dir(agents.join("skills/soksak/SKILL.md")).expect("remove folder");
    std::fs::write(
        &entry,
        format!("{}\n", test.sok.parent().expect("folder").display()),
    )
    .expect("entry");
    let installed = soksak_sok::setup::install(
        &test.setup(),
        &[soksak_sok::setup::Kind::Skill, soksak_sok::setup::Kind::Mcp],
        false,
    )
    .expect("install");
    assert_eq!(installed.error, None);
    let parts = soksak_sok::setup::check(&test.setup()).expect("check");
    assert!(
        parts
            .iter()
            .all(|part| part.state == soksak_sok::setup::State::Ok),
        "{}",
        parts_value(&parts)
    );
    assert_eq!(soksak_sok::setup::not_current(&parts, &[]), None);
}

// contract: cli.setup.install-installs-missing-parts
#[test]
fn setup_install_installs_missing_parts() {
    let machine = Machine::new("setup-install");
    let test = test_setup(&machine, "Test.app");
    let claude = machine.folder(".claude");
    std::fs::write(
        test.paths.join("com.soksak.test"),
        format!("{}\n", test.sok.parent().expect("folder").display()),
    )
    .expect("entry");
    use soksak_sok::setup::Kind;
    let skill_only =
        soksak_sok::setup::install(&test.setup(), &[Kind::Skill], false).expect("install skill");
    let changed = |parts: &[soksak_sok::setup::Part]| -> Vec<(String, String, bool)> {
        parts
            .iter()
            .map(|part| {
                (
                    part.part.to_string(),
                    serde_json::to_value(part.state)
                        .expect("state")
                        .as_str()
                        .expect("state")
                        .to_string(),
                    part.changed.expect("changed"),
                )
            })
            .collect()
    };
    assert_eq!(
        changed(&skill_only.parts),
        vec![
            ("path".into(), "ok".into(), false),
            ("skill".into(), "ok".into(), true),
            ("mcp".into(), "missing".into(), false),
        ]
    );
    assert!(!machine.home.join(".claude.json").exists());
    let all = soksak_sok::setup::install(&test.setup(), &Kind::ALL, false).expect("install");
    assert_eq!(
        changed(&all.parts),
        vec![
            ("path".into(), "ok".into(), false),
            ("skill".into(), "ok".into(), false),
            ("mcp".into(), "ok".into(), true),
        ]
    );
    let repeated = soksak_sok::setup::install(&test.setup(), &Kind::ALL, false).expect("install");
    assert_eq!(
        changed(&repeated.parts),
        vec![
            ("path".into(), "ok".into(), false),
            ("skill".into(), "ok".into(), false),
            ("mcp".into(), "ok".into(), false),
        ]
    );
    let config: Value =
        serde_json::from_slice(&std::fs::read(machine.home.join(".claude.json")).expect("config"))
            .expect("config JSON");
    assert_eq!(config["mcpServers"]["soksak"], entry(&test.sok));
    assert_eq!(
        std::fs::read(claude.join("skills/soksak/SKILL.md")).expect("skill"),
        skill_text()
    );
}

/// The events of the name in the main event files of the tool in the logs folder of config, in the order of the runs, whose boot
/// starts with the start time, and of each file.
fn tool_events(config: &Path, name: &str) -> Vec<Value> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(config.join("logs"))
        .expect("logs")
        .map(|entry| entry.expect("log entry").path())
        .filter(|file| {
            let file_name = file.file_name().expect("name").to_string_lossy();
            file_name.starts_with("sok-")
                && file_name.ends_with(".jsonl")
                && !file_name.ends_with(".debug.jsonl")
        })
        .collect();
    files.sort();
    let mut events = Vec::new();
    for file in files {
        for line in std::fs::read_to_string(&file).expect("event file").lines() {
            let event: Value = serde_json::from_str(line).expect("event");
            if event["event"] == name {
                events.push(event);
            }
        }
    }
    events
}

// The path entry command that setup install runs through sudo opens no event file, so the run of the person stores its result as
// sok.setup.path (docs/spec/cli.md#event-log): ok when sudo succeeded, and the error when it failed.
// contract: cli.setup.install-records-the-path-step
#[test]
fn setup_install_records_the_path_step() {
    let machine = Machine::new("setup-path-step");
    let test = test_setup(&machine, "Test.app");
    let entry = test.paths.join("com.soksak.test").display().to_string();
    let config = Folder::new("setup-path-step-config");
    policy::store_every_level(config.path());
    // The fixture sudo exits with 0 without writing the entry, so the part stays missing; without sudo on PATH the step fails.
    let without = machine.root.path().join("empty");
    std::fs::create_dir(&without).expect("empty folder");
    for path in [machine.tools(&["sudo"]), without] {
        let environment = soksak_sok::setup::Environment {
            home: Some(machine.home_text()),
            path: Some(path.display().to_string()),
            claude_config_dir: None,
            variables: Default::default(),
        };
        let setup = soksak_sok::setup::Setup {
            environment: &environment,
            sok: &test.sok,
            identifier: "com.soksak.test",
            paths_dir: Ok(&test.paths),
        };
        let install = |_: &[String],
                       _: &mut dyn std::io::Write,
                       _: &mut dyn std::io::Write,
                       _: &soksak_sok::Options|
         -> i32 {
            match soksak_sok::setup::install(&setup, &[soksak_sok::setup::Kind::Path], true) {
                Ok(installed) if installed.error.is_none() => 0,
                Ok(_) => 1,
                Err(error) => panic!("setup install: {error}"),
            }
        };
        let options = soksak_sok::Options {
            identifier: "com.soksak.test",
            paths_dir: Ok(&test.paths),
            core_version: "0.0.2",
            config_dir_variable: None,
        };
        let args: Vec<String> = ["setup", "install", "path", "--config-dir", config.text()]
            .iter()
            .map(|arg| arg.to_string())
            .collect();
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let code = soksak_sok::logged(&args, &mut stdout, &mut stderr, &options, &install);
        assert_eq!(
            code,
            1,
            "{}: stderr {:?}",
            path.display(),
            String::from_utf8_lossy(&stderr)
        );
    }
    let steps = tool_events(config.path(), "sok.setup.path");
    assert_eq!(steps.len(), 2, "sok.setup.path events {steps:?}");
    assert_eq!(
        (&steps[0]["level"], &steps[0]["fields"]),
        (
            &Value::from("info"),
            &serde_json::json!({"file": entry, "ok": true})
        ),
        "the step that succeeded"
    );
    assert_eq!(
        (&steps[1]["level"], &steps[1]["fields"]),
        (
            &Value::from("warn"),
            &serde_json::json!({"file": entry, "ok": false, "error": "the sudo command is not on PATH"})
        ),
        "the step that failed"
    );
}

// contract: cli.setup.install-leaves-the-path-entry-without-a-terminal
#[test]
fn setup_install_leaves_the_path_entry_without_a_terminal() {
    let machine = Machine::new("setup-terminal");
    let sok = machine.bundle_sok("Test.app");
    machine.folder(".claude");
    // The fixture sudo on PATH records a call in the log, so a run of sudo would be seen.
    let tools = machine.tools(&["claude", "sudo"]);
    let path = path_of(&[&tools, Path::new("/usr/bin"), Path::new("/bin")]);
    let run = run_sok(
        &sok,
        &["setup", "install"],
        &[("HOME", &machine.home_text()), ("PATH", &path)],
    );
    let platform = soksak_sok::platform::current().expect("platform");
    // default: a platform without a path entry folder lists no path part.
    let entry = platform
        .paths_dir()
        .ok()
        .map(|folder| folder.join(soksak_sok::identity::identity()));
    let parts = run.json()["parts"].clone();
    let states: Vec<(Value, Value, Value)> = parts
        .as_array()
        .expect("parts")
        .iter()
        .map(|part| {
            (
                part["part"].clone(),
                part["state"].clone(),
                part["changed"].clone(),
            )
        })
        .collect();
    let mut expected = vec![
        (Value::from("skill"), Value::from("ok"), Value::from(true)),
        (Value::from("mcp"), Value::from("ok"), Value::from(true)),
    ];
    let Some(entry) = entry else {
        assert_eq!((states, run.code), (expected, 0), "{}", run.stderr);
        return;
    };
    expected.insert(
        0,
        (
            Value::from("path"),
            Value::from("missing"),
            Value::from(false),
        ),
    );
    assert_eq!(states, expected);
    assert_eq!(
        (run.code, run.stderr.as_str()),
        (
            1,
            format!(
                "sok: setup parts are not current: path {}\n",
                entry.display()
            )
            .as_str()
        )
    );
    assert_eq!(calls(&machine), vec![add_call(&sok)]);
}

// contract: cli.setup.environment-prints-the-variables
#[test]
fn setup_environment_prints_the_variables() {
    let machine = Machine::new("setup-environment");
    let sok = machine.bundle_sok("Test.app");
    let home = machine.home_text();
    let run_unset = run_sok(
        &sok,
        &["setup", "environment"],
        &[("HOME", &home), ("PATH", "/usr/bin:/bin"), ("OTHER", "a=b")],
    );
    assert_eq!((run_unset.code, run_unset.stderr.as_str()), (0, ""));
    let read =
        soksak_sok::setup::Environment::from_line(run_unset.stdout.trim_end()).expect("line");
    assert_eq!(
        (
            read.home.as_deref(),
            read.path.as_deref(),
            read.claude_config_dir.as_deref()
        ),
        (Some(home.as_str()), Some("/usr/bin:/bin"), None)
    );
    // environment holds every variable of the run, also one that the setup operations do not read.
    assert_eq!(
        (
            read.variables.get("HOME").map(String::as_str),
            read.variables.get("PATH").map(String::as_str),
            read.variables.get("OTHER").map(String::as_str),
            read.variables.get("CLAUDE_CONFIG_DIR")
        ),
        (
            Some(home.as_str()),
            Some("/usr/bin:/bin"),
            Some("a=b"),
            None
        ),
        "{}",
        run_unset.stdout
    );
    let run_set = run_sok(
        &sok,
        &["setup", "environment"],
        &[("CLAUDE_CONFIG_DIR", "/c d")],
    );
    assert!(
        run_set.stdout.starts_with(
            "{\"HOME\":null,\"PATH\":null,\"CLAUDE_CONFIG_DIR\":\"/c d\",\"environment\":{"
        ),
        "{}",
        run_set.stdout
    );
    let read = soksak_sok::setup::Environment::from_line(run_set.stdout.trim_end()).expect("line");
    assert_eq!(
        (
            read.claude_config_dir.as_deref(),
            read.variables.get("CLAUDE_CONFIG_DIR").map(String::as_str)
        ),
        (Some("/c d"), Some("/c d"))
    );
    // A line without environment is the earlier form, which the reader refuses.
    assert!(
        soksak_sok::setup::Environment::from_line(
            r#"{"HOME":null,"PATH":null,"CLAUDE_CONFIG_DIR":null}"#
        )
        .is_err()
    );
}
