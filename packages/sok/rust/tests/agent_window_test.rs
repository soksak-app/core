//! Checks the window of an agent (docs/spec/cli.md#the-window-of-an-agent): `SOKSAK_CONFIG_DIR` names the configuration directory,
//! the surface that `agent.surface` answers selects its window, `sok context` prints both, and a sok hands its command to the sok of the
//! application of `SOKSAK_CONFIG_DIR`. The endpoint tests play the cases of docs/spec/cases/endpoint with the case player.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

#[path = "support/folder.rs"]
mod folder;

#[path = "support/case_player.rs"]
mod case_player;

#[path = "support/policy.rs"]
mod policy;

use case_player::{play_case, play_case_with_raw, play_case_with_text};
use folder::Folder;

/// Runs sok in this process with the variables of an agent, and returns the status and the outputs. `logged` runs it with the
/// record of the tool; two such runs of one process in one second would name the same event file, so one test uses it.
fn run_with(logged: bool, args: &[&str], config_dir: Option<&str>) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        core_version: "0.0.2",
        config_dir_variable: config_dir,
    };
    let code = if logged {
        soksak_sok::run_logged(&args, &mut stdout, &mut stderr, &options)
    } else {
        soksak_sok::run(&args, &mut stdout, &mut stderr, &options)
    };
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

fn run(args: &[&str], config_dir: Option<&str>) -> (i32, String, String) {
    run_with(false, args, config_dir)
}

/// The events of the event files of the configuration directory, in the order of the files and their lines.
fn events(config: &Path) -> Vec<Value> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(config.join("logs"))
        .expect("logs")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect();
    files.sort();
    files
        .iter()
        .flat_map(|file| {
            std::fs::read_to_string(file)
                .expect("event file")
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).expect("event"))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event["event"] == name)
        .collect()
}

// contract: cli.config-dir.environment-names-the-directory
#[test]
fn config_dir_variable_names_the_directory() {
    let project = Folder::new("config-project");
    let player = play_case_with_text("sok-several-windows", "project", project.text());
    let dir = player.dir();
    policy::store_every_level(Path::new(&dir));
    // The first connection of the case: two windows and no selection end the command before its method.
    let (code, _, stderr) = run_with(true, &["status", "core.screen"], Some(&dir));
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.starts_with("sok: the application has 2 windows (main, project-a); select one with --window or --project\n"),
        "{stderr}"
    );
    let recorded = events(Path::new(&dir));
    assert_eq!(named(&recorded, "sok.command").len(), 1, "{recorded:?}");
    // --config-dir takes precedence over the variable: the second connection of the case goes to the named directory.
    let other = Folder::new("config-other");
    let (code, _, stderr) = run(
        &[
            "status",
            "core.screen",
            "--project",
            project.text(),
            "--config-dir",
            &dir,
        ],
        Some(other.text()),
    );
    assert_eq!((code, stderr.as_str()), (0, ""));
    assert!(!other.path().join("logs").exists());
    drop(player);
}

// contract: cli.window.own-surface-selects-its-window
#[test]
fn own_surface_selects_its_window() {
    let player = play_case("sok-surface-window");
    let dir = player.dir();
    for window in ["project-a", "main"] {
        let (code, stdout, stderr) = run(&["status", "core.screen", "--config-dir", &dir], None);
        assert_eq!((code, stderr.as_str()), (0, ""), "{window}: {stdout}");
    }
    let (code, _, stderr) = run(
        &[
            "status",
            "core.screen",
            "--window",
            "project-a",
            "--config-dir",
            &dir,
        ],
        None,
    );
    assert_eq!((code, stderr.as_str()), (0, ""));
    let (code, _, stderr) = run(&["status", "core.screen", "--config-dir", &dir], None);
    assert_eq!((code, stderr.as_str()), (0, ""));
    assert_eq!(
        player.methods(),
        [
            "agent.surface",
            "surface.window",
            "status.get",
            "agent.surface",
            "surface.window",
            "status.get",
            "status.get",
            "agent.surface",
            "windows.list",
            "status.get"
        ]
    );
    drop(player);
}

// contract: cli.window.surface-in-no-window-fails
#[test]
fn surface_in_no_window_fails() {
    let player = play_case("sok-surface-in-no-window");
    let dir = player.dir();
    let (code, stdout, stderr) = run(&["status", "core.screen", "--config-dir", &dir], None);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "",
            "sok: surface terminal-9 of this process is in no window of the application\n"
        )
    );
    drop(player);
}

// contract: cli.context.prints-the-agent-context
#[test]
fn context_prints_the_agent_context() {
    let player = play_case("sok-context");
    let dir = player.dir();
    let (code, stdout, stderr) = run(&["context"], Some(&dir));
    assert_eq!((code, stderr.as_str()), (0, ""));
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).expect("context"),
        serde_json::json!({"configDirectory": dir, "surface": "terminal-1", "window": "project-a"})
    );
    let (code, stdout, stderr) = run(&["context"], Some(&dir));
    assert_eq!((code, stderr.as_str()), (0, ""), "a process of no surface");
    assert_eq!(
        stdout,
        format!(
            "{{\n  \"configDirectory\": \"{dir}\",\n  \"surface\": null,\n  \"window\": null\n}}\n"
        )
    );
    drop(player);
    let config = Folder::new("context-none");
    let (code, stdout, stderr) = run(&["context"], Some(config.text()));
    assert_eq!(
        (code, stdout.as_str(), stderr),
        (
            1,
            "",
            format!(
                "sok: {}/endpoint.json does not exist; the application is not running\n",
                config.text()
            )
        ),
        "without an application"
    );
}

/// Runs the sok at the path with only the given variables in its environment.
fn run_sok(sok: &Path, args: &[&str], variables: &[(&str, &str)]) -> (i32, String, String) {
    let mut command = Command::new(sok);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in variables {
        command.env(name, value);
    }
    let output = command.output().expect("run sok");
    (
        output.status.code().expect("status"),
        String::from_utf8(output.stdout).expect("stdout"),
        String::from_utf8(output.stderr).expect("stderr"),
    )
}

// contract: cli.config-dir.hands-the-command-to-the-application-sok
#[test]
fn hands_the_command_to_the_application_sok() {
    let root = Folder::new("handoff");
    let home = root.path().join("home");
    let config = root.path().join("config");
    let macos = root.path().join("App.app/Contents/MacOS");
    for folder in [&home, &config, &macos] {
        std::fs::create_dir_all(folder).expect("folder");
    }
    policy::store_every_level(&config);
    let application_sok = macos.join("sok");
    std::fs::hard_link(env!("CARGO_BIN_EXE_sok"), &application_sok).expect("link sok");
    let running = Path::new(env!("CARGO_BIN_EXE_sok"))
        .canonicalize()
        .expect("running sok");
    let to = application_sok.canonicalize().expect("application sok");
    let config_text = config.display().to_string();
    let home_text = home.display().to_string();
    let variables = [
        ("HOME", home_text.as_str()),
        ("SOKSAK_CONFIG_DIR", config_text.as_str()),
    ];
    // Without endpoint.json the running sok runs the command, and a command that needs the application fails with the missing file.
    let (code, _, stderr) = run_sok(&running, &["status", "core.screen"], &variables);
    assert_eq!(
        (code, stderr.clone()),
        (
            1,
            format!(
                "sok: {}/endpoint.json does not exist; the application is not running\n",
                config_text
            )
        )
    );
    assert_eq!(named(&events(&config), "sok.exec").len(), 0);
    std::fs::write(
        config.join("endpoint.json"),
        serde_json::json!({
            "address": config.join("endpoint.sock").display().to_string(),
            "pid": std::process::id(),
            "transport": "unix",
            "executable": macos.join("soksak").display().to_string(),
        })
        .to_string(),
    )
    .expect("endpoint.json");
    // plugin list reads only the configuration directory, so the handed command succeeds without a running application.
    let (code, handed, stderr) = run_sok(&running, &["plugin", "list"], &variables);
    assert_eq!((code, stderr.as_str()), (0, ""));
    assert!(!handed.is_empty());
    let recorded = events(&config);
    let exec = named(&recorded, "sok.exec");
    assert_eq!(exec.len(), 1, "{recorded:?}");
    assert_eq!(
        (
            exec[0]["level"].clone(),
            exec[0]["fields"]["from"].clone(),
            exec[0]["fields"]["to"].clone(),
            exec[0]["fields"]["config"].clone()
        ),
        (
            Value::from("info"),
            Value::from(running.display().to_string()),
            Value::from(to.display().to_string()),
            Value::from(config_text.clone())
        ),
        "{}",
        exec[0]
    );
    // The first run stored its failed status command; the handed-over plugin list stores its command twice with the status 0, once
    // from the sok that handed over and once from the application sok.
    let commands = named(&recorded, "sok.command");
    let statuses: Vec<(Value, Value)> = commands
        .iter()
        .map(|event| {
            (
                event["fields"]["name"].clone(),
                event["fields"]["status"].clone(),
            )
        })
        .collect();
    assert_eq!(
        statuses,
        vec![
            (Value::from("status"), Value::from(1)),
            (Value::from("plugin"), Value::from(0)),
            (Value::from("plugin"), Value::from(0))
        ],
        "{recorded:?}"
    );
    // With --config-dir no replacement happens.
    let (code, stdout, stderr) = run_sok(
        &running,
        &["plugin", "list", "--config-dir", &config_text],
        &variables,
    );
    assert_eq!((code, stdout, stderr.as_str()), (0, handed, ""));
    assert_eq!(named(&events(&config), "sok.exec").len(), 1);
}

/// The window_describe steps of the case mcp-window-describe, which `sok describe` prints alike.
fn window_describe_steps() -> Vec<Value> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .map(|folder| folder.join("docs/spec/cases/endpoint"))
        .find(|folder| folder.is_dir())
        .expect("docs/spec/cases/endpoint of the repository");
    let text = std::fs::read_to_string(directory.join("mcp-window-describe.json"))
        .expect("read mcp-window-describe");
    let case: Value = serde_json::from_str(&text).expect("the case is JSON");
    case["mcp"]["steps"].as_array().expect("steps").clone()
}

/// The flags of sok describe for the arguments of window_describe, in the order of their names.
fn describe_flags(arguments: &Value) -> Vec<String> {
    let mut arguments = arguments.as_object().expect("arguments").clone();
    let mut flags = Vec::new();
    for name in ["after", "full", "limit", "surface", "window"] {
        match arguments.remove(name) {
            None | Some(Value::Bool(false)) => {}
            Some(Value::Bool(true)) => flags.push(format!("--{name}")),
            Some(Value::Number(number)) => flags.extend([format!("--{name}"), number.to_string()]),
            Some(Value::String(text)) => flags.extend([format!("--{name}"), text]),
            Some(other) => panic!("argument {name} is {other}"),
        }
    }
    assert!(
        arguments.is_empty(),
        "window_describe arguments without a flag: {arguments:?}"
    );
    flags
}

// contract: cli.describe.lists-every-entry, cli.describe.compact-form-and-pages
#[test]
fn describe_prints_the_pages_of_window_describe() {
    let player = play_case("sok-describe");
    let config = player.dir();
    for (n, step) in window_describe_steps().iter().enumerate() {
        let mut args = vec![
            "describe".to_string(),
            "--config-dir".to_string(),
            config.clone(),
        ];
        args.extend(describe_flags(&step["arguments"]));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = run(&args, None);
        match step["error"].as_str() {
            Some("limit must be an integer from 1 to 500") => assert!(
                code == 2
                    && stdout.is_empty()
                    && stderr.starts_with("sok: --limit must be an integer from 1 to 500\n"),
                "step {n} {args:?}: code {code} stdout {stdout:?} stderr {stderr:?}"
            ),
            Some(error) => assert!(
                code == 1 && stdout.is_empty() && stderr == format!("sok: {error}\n"),
                "step {n} {args:?}: code {code} stdout {stdout:?} stderr {stderr:?}"
            ),
            None => {
                let printed: Value = serde_json::from_str(&stdout).unwrap_or_else(|error| {
                    panic!("step {n} {args:?}: code {code} stdout {stdout:?} stderr {stderr:?}: {error}")
                });
                assert!(
                    code == 0 && stdout.ends_with("}\n"),
                    "step {n} {args:?}: code {code} stderr {stderr:?}"
                );
                assert_eq!(
                    printed, step["result"],
                    "step {n} {args:?} printed\n{stdout}"
                );
            }
        }
    }
    // The pages of --limit 2 hold each row of the description once, the first page alone the window, and total is their number.
    let mut keys = Vec::new();
    let mut after = String::new();
    for page in 0.. {
        let mut args = vec!["describe", "--config-dir", &config, "--limit", "2"];
        if !after.is_empty() {
            args.extend(["--after", &after]);
        }
        let (code, stdout, stderr) = run(&args, None);
        let printed: Value = serde_json::from_str(&stdout).unwrap_or_else(|error| {
            panic!("page {page}: code {code} stdout {stdout:?} stderr {stderr:?}: {error}")
        });
        assert_eq!(code, 0, "page {page}: stderr {stderr:?}");
        let whole = ["window", "layout", "plugins", "agent"]
            .iter()
            .all(|member| printed.get(member).is_some());
        assert!(
            (page == 0) == whole && printed["total"] == 7,
            "page {page}: {stdout}"
        );
        for row in printed["rows"].as_array().expect("rows") {
            keys.push(row["key"].as_str().expect("key").to_string());
        }
        match printed["next"].as_str() {
            Some(next) => after = next.to_string(),
            None => break,
        }
    }
    assert_eq!(
        keys,
        [
            "host status host.window",
            "host command host.window.reload",
            "core status core.screen",
            "core command core.layout.open",
            "core element core.tab",
            "terminal-1 command terminal.input",
            "unregistered command browser.reload",
        ]
    );
    assert_eq!(player.methods().len(), 30, "{:?}", player.methods());
}

// contract: cli.exposures.query-filters-entries
#[test]
fn a_query_keeps_the_entries_that_hold_each_word() {
    let player = play_case("sok-exposures-query");
    let config = player.dir();
    let names = |stdout: &str, member: &str| -> Vec<String> {
        let printed: Value = serde_json::from_str(stdout)
            .unwrap_or_else(|error| panic!("stdout {stdout:?}: {error}"));
        let lists: Vec<(String, Value)> = if member.is_empty() {
            vec![(String::new(), printed)]
        } else {
            printed
                .as_object()
                .expect("an object")
                .iter()
                .map(|(kind, entries)| (kind.clone(), entries.clone()))
                .collect()
        };
        let mut found = Vec::new();
        for (kind, entries) in lists {
            assert!(
                member.is_empty() || kind == member,
                "{stdout} holds the list {kind}"
            );
            for entry in entries.as_array().expect("a list") {
                assert!(
                    member == "status" || member == "element" || entry.get("params").is_some(),
                    "the entry {entry} is not the whole declaration"
                );
                found.push(entry["name"].as_str().expect("name").to_string());
            }
        }
        found
    };
    for (args, member, want) in [
        (
            &["exposures", "--kind", "command", "--query", "PROJECT open"][..],
            "commands",
            &["core.project.open"][..],
        ),
        (
            &["exposures", "--kind", "status", "--query", " \t "],
            "status",
            &["core.screen", "host.window"],
        ),
        (
            &["commands", "--query", "window\n again"],
            "",
            &["host.window.reload"],
        ),
        (
            &["exposures", "--kind", "command", "--query", "änderung"],
            "commands",
            &[],
        ),
        (
            &[
                "exposures",
                "--kind",
                "command",
                "--query",
                "Änderung DATEI",
            ],
            "commands",
            &["editor.Änderung"],
        ),
        (
            &["exposures", "--kind", "element", "--query", "SCREEN tab"],
            "element",
            &["core.tab"],
        ),
    ] {
        let mut all: Vec<&str> = args.to_vec();
        all.extend(["--config-dir", &config]);
        let (code, stdout, stderr) = run(&all, None);
        assert!(
            code == 0 && stderr.is_empty(),
            "{args:?}: code {code} stdout {stdout:?} stderr {stderr:?}"
        );
        assert_eq!(names(&stdout, member), want, "{args:?} printed {stdout}");
    }
    let (code, stdout, stderr) = run(
        &["exposures", "--kind", "screen", "--config-dir", &config],
        None,
    );
    assert!(
        code == 2
            && stdout.is_empty()
            && stderr.starts_with("sok: --kind must be status, command or element\n"),
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.describe.refuses-a-lone-surrogate
#[test]
fn describe_refuses_a_lone_surrogate_escape() {
    let snapshot = concat!(
        r#"{"window":{"window":"main","title":"soksak","project":null},"layout":{"space":"space-1","focused":null,"root":null},"#,
        r#""plugins":[],"groups":[{"owner":"core","status":[{"name":"core.screen","description":"Current screen.","schema":{},"#,
        r#""value":"a\ud800b"}],"commands":[],"element":[]}],"unregistered":[]}"#
    );
    let player = play_case_with_raw("sok-describe-lone-surrogate", "snapshot", snapshot);
    let config = player.dir();
    let (code, stdout, stderr) = run(&["describe", "--config-dir", &config], None);
    assert!(
        code == 1
            && stdout.is_empty()
            && stderr
                == "sok: status core.screen of group core: the value holds a lone surrogate escape\n",
        "code {code} stdout {stdout:?} stderr {stderr:?}"
    );
}

// contract: cli.context.prints-the-agent-context
#[test]
fn context_takes_only_the_configuration_directory() {
    let config = Folder::new("context-flags");
    for (args, want) in [
        (
            vec!["context", "main"],
            "sok: context takes no argument: main\n",
        ),
        (
            vec!["context", "--kind", "status"],
            "sok: context takes only --config-dir\n",
        ),
        (
            vec!["context", "--window", "main"],
            "sok: context takes only --config-dir\n",
        ),
        (
            vec!["context", "--full"],
            "sok: context takes only --config-dir\n",
        ),
    ] {
        let (code, stdout, stderr) = run(&args, Some(config.text()));
        assert!(
            code == 2 && stdout.is_empty() && stderr.starts_with(want),
            "{args:?}: code {code} stdout {stdout:?} stderr {stderr:?}"
        );
    }
}

// A view and mcp refuse a positional argument before they connect, and name the option form of the window (cli.md, the window
// is the --window or --project option).
// contract: cli.positional-window.refused-with-option-form
#[test]
fn a_positional_window_is_refused_with_the_option_form() {
    let config = Folder::new("positional-window");
    let option = "--window <name> or --project <directory>";
    for (args, command) in [
        (vec!["describe", "main"], "describe"),
        (vec!["commands", "main", "--query", "project"], "commands"),
        (vec!["exposures", "main", "--kind", "command"], "exposures"),
        (vec!["mcp", "main"], "mcp"),
    ] {
        let want = format!("sok: {command} takes no argument besides {option}\n");
        let (code, stdout, stderr) = run(&args, Some(config.text()));
        assert!(
            code == 2 && stdout.is_empty() && stderr.starts_with(&want),
            "{args:?}: code {code} stdout {stdout:?} stderr {stderr:?}, want prefix {want:?}"
        );
    }
}

// contract: cli.describe.summary-and-full
#[test]
fn describe_summary_holds_summary_statuses_and_full_holds_every_status() {
    let player = play_case("sok-describe-summary-and-full");
    let (_, summary, stderr) = run(&["describe", "--config-dir", &player.dir()], None);
    assert!(
        summary.contains("\"probe.busy\""),
        "summary lacks the summary status: {stderr} {summary}"
    );
    assert!(
        !summary.contains("\"probe.detail\""),
        "summary holds a status that is not a summary: {summary}"
    );
    let (_, full, stderr) = run(&["describe", "--full", "--config-dir", &player.dir()], None);
    assert!(
        full.contains("\"probe.detail\"") && full.contains("\"probe.busy\""),
        "full lacks the tab statuses: {stderr} {full}"
    );
}

// contract: cli.status.read-recorded
#[test]
fn each_status_read_is_recorded() {
    let player = play_case("sok-status-value");
    let dir = player.dir();
    policy::store_every_level(Path::new(&dir));
    let (code, _, stderr) = run_with(
        true,
        &["status", "core.screen", "--window", "main"],
        Some(&dir),
    );
    assert_eq!(code, 0, "{stderr}");
    let recorded = events(Path::new(&dir));
    let reads = named(&recorded, "sok.status.read");
    assert_eq!(reads.len(), 1, "{recorded:?}");
    let fields = &reads[0]["fields"];
    assert!(
        fields["window"] == "main"
            && fields["name"] == "core.screen"
            && fields["ok"] == true
            && fields["micros"].is_u64()
            && fields["surface"].is_null(),
        "{}",
        reads[0]
    );
}

// contract: cli.status.read-recorded
#[test]
fn a_watch_records_its_status_read() {
    let player = play_case("sok-watch-ends-after-change");
    let dir = player.dir();
    policy::store_every_level(Path::new(&dir));
    let (code, _, stderr) = run_with(
        true,
        &[
            "status",
            "core.screen",
            "--window",
            "main",
            "--surface",
            "tab-1",
            "--watch",
        ],
        Some(&dir),
    );
    assert_eq!(
        (code, stderr.as_str()),
        (1, "sok: status core.screen ended: surface-closed\n"),
        "{stderr}"
    );
    let recorded = events(Path::new(&dir));
    let reads = named(&recorded, "sok.status.read");
    assert_eq!(reads.len(), 1, "{recorded:?}");
    let fields = &reads[0]["fields"];
    assert!(
        fields["window"] == "main"
            && fields["name"] == "core.screen"
            && fields["surface"] == "tab-1"
            && fields["ok"] == true,
        "{}",
        reads[0]
    );
}
