//! Checks the Codex agent (docs/spec/cli.md#agent-skill, docs/spec/cli.md#mcp-registration): the skill is written to the agents
//! folder of Codex when `<home>/.codex` is a directory, and `sok mcp install` registers the sok with the codex command when it is
//! on `PATH`. The fixture program docs/spec/cases/setup/fixture.sh is copied as the codex command.

#[path = "support/agents.rs"]
mod agents;
#[path = "support/folder.rs"]
mod folder;

use std::path::Path;

use agents::{Machine, calls, path_of, run_sok, skill_text};

// contract: cli.skill.installs-the-codex-folder
#[test]
fn skill_install_creates_the_codex_agent_folder_when_codex_is_present() {
    let machine = Machine::new("codex-skill");
    let sok = machine.bundle_sok("Test.app");
    std::fs::create_dir_all(machine.home.join(".codex")).expect("codex folder");
    let path = machine.claude_path();
    let home = machine.home_text();
    let install = run_sok(
        &sok,
        &["skill", "install"],
        &[("HOME", home.as_str()), ("PATH", path.as_str())],
    );
    assert_eq!(install.code, 0, "{}", install.stderr);
    let file = machine.home.join(".agents/skills/soksak/SKILL.md");
    assert_eq!(
        std::fs::read(&file).expect("codex skill file"),
        skill_text()
    );
}

// contract: cli.mcp.registers-with-codex
#[test]
fn mcp_install_registers_the_sok_with_codex_when_codex_is_on_path() {
    let machine = Machine::new("codex-mcp");
    let sok = machine.bundle_sok("Test.app");
    let running = std::fs::canonicalize(&sok).expect("canonical sok");
    let tools = machine.tools(&["claude", "codex"]);
    let path = path_of(&[&tools, Path::new("/usr/bin"), Path::new("/bin")]);
    let home = machine.home_text();
    let variables = [("HOME", home.as_str()), ("PATH", path.as_str())];
    let install = run_sok(&sok, &["mcp", "install"], &variables);
    assert_eq!(install.code, 0, "{}", install.stderr);
    assert_eq!(
        install.json()["codex"],
        "registered",
        "output {}",
        install.stdout
    );
    let want = format!("codex mcp add soksak -- {} mcp", running.display());
    assert!(
        calls(&machine).contains(&want),
        "commands {:?}",
        calls(&machine)
    );
    let before = calls(&machine).len();
    let second = run_sok(&sok, &["mcp", "install"], &variables);
    assert_eq!(second.code, 0, "{}", second.stderr);
    assert_eq!(
        second.json()["codex"],
        "current",
        "second output {}",
        second.stdout
    );
    assert_eq!(
        calls(&machine).len(),
        before + 1,
        "the second install runs the claude command only"
    );
}

// The registration with codex creates `<home>/.codex`, which makes `<home>/.agents` the Codex agent folder, so the install
// registers before it writes the skills and writes the skill file of that folder too: the install that creates the folder
// leaves its skill current.
// contract: cli.setup.install-writes-the-skill-of-the-folder-that-the-registration-creates
#[test]
fn setup_install_writes_the_skill_of_the_codex_folder_that_the_registration_creates() {
    let machine = Machine::new("codex-setup");
    let sok = machine.bundle_sok("Test.app");
    machine.folder(".claude");
    let tools = machine.tools(&["claude", "codex"]);
    let path = path_of(&[&tools, Path::new("/usr/bin"), Path::new("/bin")]);
    let home = machine.home_text();
    let run = run_sok(
        &sok,
        &["setup", "install", "skill", "mcp"],
        &[("HOME", home.as_str()), ("PATH", path.as_str())],
    );
    let skills: Vec<(String, String, bool)> = run.json()["parts"]
        .as_array()
        .expect("parts")
        .iter()
        .filter(|part| part["part"] == "skill")
        .map(|part| {
            (
                part["file"].as_str().unwrap_or_default().to_string(),
                part["state"].as_str().unwrap_or_default().to_string(),
                part["changed"] == true,
            )
        })
        .collect();
    let file = |folder: &str| {
        machine
            .home
            .join(folder)
            .join("skills/soksak/SKILL.md")
            .display()
            .to_string()
    };
    assert_eq!(
        (run.code, skills),
        (
            0,
            vec![
                (file(".claude"), "ok".to_string(), true),
                (file(".agents"), "ok".to_string(), true)
            ]
        ),
        "{}",
        run.stderr
    );
}
