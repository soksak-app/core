//! Checks the session restart hook (docs/spec/agent-roles.md#session-restart-hook): the install and removal of its entries in the hook
//! file of each user agent folder, the guard of its command, and `sok role identity`. Each test runs the built sok from an application
//! bundle folder of a disposable home, as the setup tests do.

use std::path::Path;

use serde_json::{Value, json};

#[path = "support/agents.rs"]
mod agents;
#[path = "support/case_player.rs"]
mod case_player;
#[path = "support/folder.rs"]
mod folder;

use agents::{Machine, run_sok};
use case_player::play_case;

/// The mark that ends the command of each soksak hook entry.
const HOOK_MARK: &str = " role identity --soksak-hook";

/// The settings file of the Claude folder of the machine.
fn settings_file(machine: &Machine) -> std::path::PathBuf {
    machine.home.join(".claude").join("settings.json")
}

/// The commands of the hook entries of the file that carry the mark of soksak, per event.
fn soksak_commands(file: &Path) -> Vec<(String, String)> {
    let document: Value =
        serde_json::from_slice(&std::fs::read(file).expect("hook file")).expect("json");
    let mut found = Vec::new();
    if let Some(events) = document.get("hooks").and_then(Value::as_object) {
        for (event, groups) in events {
            for group in groups.as_array().into_iter().flatten() {
                for hook in group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let command = hook.get("command").and_then(Value::as_str).unwrap_or("");
                    if command.ends_with(HOOK_MARK) {
                        found.push((event.clone(), command.to_string()));
                    }
                }
            }
        }
    }
    found
}

/// A settings file that a person wrote, with a model, a Stop hook, a PreToolUse hook, and an old soksak entry under Stop.
const PERSON_HOOKS: &str = concat!(
    "{\n",
    "  \"model\": \"opus\",\n",
    "  \"hooks\": {\n",
    "    \"Stop\": [\n",
    "      {\"matcher\": \"\", \"hooks\": [{\"type\": \"command\", \"command\": \"echo person-stop\"}]},\n",
    "      {\"matcher\": \"\", \"hooks\": [{\"type\": \"command\", \"command\": \"[ -n \\\"$SOKSAK_CONFIG_DIR\\\" ] || exit 0; exec /old/sok role identity --soksak-hook\"}]}\n",
    "    ],\n",
    "    \"PreToolUse\": [\n",
    "      {\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \"command\": \"echo person-pre\"}]}\n",
    "    ]\n",
    "  }\n",
    "}\n",
);

/// The part of a settings file that the person wrote, for comparison.
fn person_values(data: &[u8]) -> Value {
    let document: Value = serde_json::from_slice(data).expect("json");
    let hooks = &document["hooks"];
    let stop: Vec<Value> = hooks["Stop"]
        .as_array()
        .expect("stop")
        .iter()
        .filter(|group| {
            !group["hooks"][0]["command"]
                .as_str()
                .unwrap_or("")
                .ends_with(HOOK_MARK)
        })
        .cloned()
        .collect();
    json!({"model": document["model"], "Stop": stop, "PreToolUse": hooks["PreToolUse"]})
}

// contract: cli.setup.hook-install-keeps-the-persons-hooks
#[test]
fn hook_install_keeps_the_persons_hooks_and_drops_stale_entries() {
    let machine = Machine::new("hook-keeps");
    let sok = machine.bundle_sok("Test.app");
    std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
    std::fs::write(settings_file(&machine), PERSON_HOOKS).expect("settings");
    let original = std::fs::read(settings_file(&machine)).expect("settings");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let run = run_sok(&sok, &["setup", "install", "hook"], &variables);
    assert_eq!((run.code, run.stderr.as_str()), (0, ""), "{}", run.stdout);
    let after = std::fs::read(settings_file(&machine)).expect("settings");
    assert_eq!(person_values(&original), person_values(&after));
    let marked = soksak_commands(&settings_file(&machine));
    let want = format!(
        "[ -n \"$SOKSAK_CONFIG_DIR\" ] || exit 0; exec {}{}",
        sok.display(),
        HOOK_MARK
    );
    assert_eq!(marked, vec![("SessionStart".to_string(), want)]);
}

// contract: cli.setup.hook-install-twice-gives-identical-bytes
#[test]
fn hook_install_twice_gives_identical_bytes() {
    let machine = Machine::new("hook-twice");
    let sok = machine.bundle_sok("Test.app");
    std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
    std::fs::write(settings_file(&machine), PERSON_HOOKS).expect("settings");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    assert_eq!(
        run_sok(&sok, &["setup", "install", "hook"], &variables).code,
        0
    );
    let first = std::fs::read(settings_file(&machine)).expect("settings");
    assert_eq!(
        run_sok(&sok, &["setup", "install", "hook"], &variables).code,
        0
    );
    let second = std::fs::read(settings_file(&machine)).expect("settings");
    assert_eq!(first, second);
}

// contract: cli.setup.hook-remove-keeps-the-persons-hooks
#[test]
fn hook_remove_restores_the_canonical_file() {
    let machine = Machine::new("hook-remove");
    let sok = machine.bundle_sok("Test.app");
    std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
    let canonical = "{\n  \"model\": \"opus\",\n  \"hooks\": {\n    \"Stop\": [\n      {\n        \"matcher\": \"\",\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"echo person-stop\"\n          }\n        ]\n      }\n    ]\n  }\n}\n";
    std::fs::write(settings_file(&machine), canonical).expect("settings");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    assert_eq!(
        run_sok(&sok, &["setup", "install", "hook"], &variables).code,
        0
    );
    let removed = run_sok(&sok, &["setup", "remove", "hook"], &variables);
    assert_eq!(
        (removed.code, removed.stderr.as_str()),
        (0, ""),
        "{}",
        removed.stdout
    );
    assert_eq!(
        std::fs::read_to_string(settings_file(&machine)).expect("settings"),
        canonical
    );
}

// contract: cli.role.identity-outside-a-tab-prints-nothing
#[test]
fn hook_command_outside_a_tab_exits_zero_without_sok() {
    let machine = Machine::new("hook-guard");
    let sok = machine.bundle_sok("Test.app");
    std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    assert_eq!(
        run_sok(&sok, &["setup", "install", "hook"], &variables).code,
        0
    );
    let commands = soksak_commands(&settings_file(&machine));
    assert_eq!(commands.len(), 1, "{commands:?}");
    // sok is not on PATH and no tab environment exists: the guard exits 0 before sok runs.
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(&commands[0].1)
        .env_clear()
        .env("HOME", machine.home_text())
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("hook command");
    assert!(output.status.success(), "{:?}", output.status);
    assert!(
        output.stdout.is_empty() && output.stderr.is_empty(),
        "{output:?}"
    );
}

// contract: cli.role.identity-prints-the-identity-of-the-tab
#[test]
fn role_identity_prints_the_identity_of_the_tab() {
    let player = play_case("role-identity");
    let file = player.dir().to_string() + "/agents/tab-a/role.md";
    std::fs::create_dir_all(Path::new(&file).parent().expect("folder")).expect("folder");
    std::fs::write(&file, "role text\n").expect("role file");
    let machine = Machine::new("identity-prints");
    let sok = machine.bundle_sok("Test.app");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
        ("SOKSAK_CONFIG_DIR", player.dir().to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let run = run_sok(&sok, &["role", "identity"], &variables);
    let identity = format!(
        "[soksak role] Your role is defined in the file {file}. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role."
    );
    let want = format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"SessionStart\",\"additionalContext\":{}}}}}\n",
        serde_json::to_string(&identity).expect("identity")
    );
    assert_eq!(
        (run.code, run.stdout.as_str(), run.stderr.as_str()),
        (0, want.as_str(), "")
    );
}

// contract: cli.role.identity-without-a-role-prints-nothing
#[test]
fn role_identity_without_a_role_file_prints_nothing() {
    let player = play_case("role-identity");
    let machine = Machine::new("identity-none");
    let sok = machine.bundle_sok("Test.app");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
        ("SOKSAK_CONFIG_DIR", player.dir().to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let run = run_sok(&sok, &["role", "identity"], &variables);
    assert_eq!(
        (run.code, run.stdout.as_str(), run.stderr.as_str()),
        (0, "", "")
    );
}

// contract: cli.role.identity-outside-a-window-prints-nothing
#[test]
fn role_identity_outside_a_window_prints_nothing() {
    let player = play_case("agent-surface-refused");
    let machine = Machine::new("identity-refused");
    let sok = machine.bundle_sok("Test.app");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
        ("SOKSAK_CONFIG_DIR", player.dir().to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let run = run_sok(&sok, &["role", "identity"], &variables);
    assert_eq!(
        (run.code, run.stdout.as_str(), run.stderr.as_str()),
        (0, "", "")
    );
}

/// One case of docs/spec/cases/setup/hook-files.json, which the Go tests run too.
struct SharedCase {
    name: String,
    input: String,
    install: String,
    remove: String,
}

/// Reads the shared hook cases and the placeholder that the install output writes for the sok path.
fn shared_hook_cases() -> (String, Vec<SharedCase>) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/spec/cases/setup/hook-files.json");
    let text = std::fs::read_to_string(&path).expect("hook-files.json");
    let document: Value = serde_json::from_str(&text).expect("json");
    let placeholder = document["placeholder"]
        .as_str()
        .expect("placeholder")
        .to_string();
    let cases = document["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| SharedCase {
            name: case["name"].as_str().expect("name").to_string(),
            input: case["input"].as_str().expect("input").to_string(),
            install: case["install"].as_str().expect("install").to_string(),
            remove: case["remove"].as_str().expect("remove").to_string(),
        })
        .collect();
    (placeholder, cases)
}

// contract: cli.setup.hook-files-match-the-shared-cases
#[test]
fn hook_files_match_the_shared_cases() {
    let (placeholder, cases) = shared_hook_cases();
    for case in cases {
        let machine = Machine::new(&format!("hook-shared-{}", case.name));
        let sok = machine.bundle_sok("Test.app");
        std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
        std::fs::write(settings_file(&machine), &case.input).expect("settings");
        let variables = [
            ("HOME", machine.home_text()),
            ("PATH", "/usr/bin:/bin".to_string()),
        ];
        let variables: Vec<(&str, &str)> =
            variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
        let installed = run_sok(&sok, &["setup", "install", "hook"], &variables);
        assert_eq!(
            (installed.code, installed.stderr.as_str()),
            (0, ""),
            "{}: {}",
            case.name,
            installed.stdout
        );
        let want = case
            .install
            .replace(&placeholder, &sok.display().to_string());
        assert_eq!(
            std::fs::read_to_string(settings_file(&machine)).expect("settings"),
            want,
            "{}: install bytes",
            case.name
        );

        let machine = Machine::new(&format!("hook-shared-remove-{}", case.name));
        let sok = machine.bundle_sok("Test.app");
        std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
        std::fs::write(settings_file(&machine), &case.input).expect("settings");
        let variables = [
            ("HOME", machine.home_text()),
            ("PATH", "/usr/bin:/bin".to_string()),
        ];
        let variables: Vec<(&str, &str)> =
            variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
        let removed = run_sok(&sok, &["setup", "remove", "hook"], &variables);
        assert_eq!(
            (removed.code, removed.stderr.as_str()),
            (0, ""),
            "{}: {}",
            case.name,
            removed.stdout
        );
        assert_eq!(
            std::fs::read_to_string(settings_file(&machine)).expect("settings"),
            case.remove,
            "{}: remove bytes",
            case.name
        );
    }
}

// contract: cli.setup.hook-escapes-the-command-as-encoding-json-does
#[test]
fn hook_install_escapes_the_command_as_encoding_json_does() {
    let machine = Machine::new("hook-escape");
    let sok = machine.bundle_sok("A&<B>.app");
    std::fs::create_dir_all(machine.home.join(".claude")).expect("claude folder");
    let variables = [
        ("HOME", machine.home_text()),
        ("PATH", "/usr/bin:/bin".to_string()),
    ];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let run = run_sok(&sok, &["setup", "install", "hook"], &variables);
    assert_eq!((run.code, run.stderr.as_str()), (0, ""), "{}", run.stdout);
    let data = std::fs::read_to_string(settings_file(&machine)).expect("settings");
    for escape in [r"\u0026", r"\u003c", r"\u003e"] {
        assert!(
            data.contains(escape),
            "the command has no {escape}:\n{data}"
        );
    }
    let want = format!(
        "[ -n \"$SOKSAK_CONFIG_DIR\" ] || exit 0; exec {}{}",
        soksak_sok::setup::step_of(&sok.display().to_string()),
        HOOK_MARK
    );
    assert_eq!(
        soksak_commands(&settings_file(&machine)),
        vec![("SessionStart".to_string(), want)]
    );
}
