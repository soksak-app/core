//! Checks the agent skill commands (docs/spec/cli.md#agent-skill): `sok skill print` writes the skill text, and `sok skill install`
//! writes it into the skill folder of each agent folder that exists. Each test runs the built sok from an application bundle folder
//! of a disposable home, with an environment that holds only the variables that the test sets.

use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

#[path = "support/agents.rs"]
mod agents;
#[path = "support/folder.rs"]
mod folder;

use agents::{Machine, other_files, run_sok, skill_text};

// contract: cli.skill.prints-the-text
#[test]
fn skill_print_writes_the_text() {
    let machine = Machine::new("skill-print");
    let sok = machine.bundle_sok("Test.app");
    let run = run_sok(&sok, &["skill", "print"], &[("HOME", &machine.home_text())]);
    assert_eq!((run.code, run.stderr.as_str()), (0, ""));
    assert_eq!(run.stdout.as_bytes(), skill_text().as_slice());
}

// contract: cli.skill.writes-only-existing-agent-folders
#[test]
fn skill_install_writes_only_existing_agent_folders() {
    let machine = Machine::new("skill-folders");
    let sok = machine.bundle_sok("Test.app");
    let claude = machine.folder(".claude");
    // .agents is a symbolic link to a folder, and CLAUDE_CONFIG_DIR names .claude through another link.
    let shared = machine.root.path().join("shared-agents");
    std::fs::create_dir(&shared).expect("shared");
    std::os::unix::fs::symlink(&shared, machine.home.join(".agents")).expect("link .agents");
    let config_link = machine.root.path().join("claude-link");
    std::os::unix::fs::symlink(&claude, &config_link).expect("link config");
    let run = run_sok(
        &sok,
        &["skill", "install"],
        &[
            ("HOME", &machine.home_text()),
            ("CLAUDE_CONFIG_DIR", &config_link.display().to_string()),
        ],
    );
    assert_eq!((run.code, run.stderr.as_str()), (0, ""), "{}", run.stdout);
    let first = claude.join("skills/soksak/SKILL.md");
    let second = machine.home.join(".agents/skills/soksak/SKILL.md");
    assert_eq!(
        run.json(),
        serde_json::json!({"skills": [
            {"file": first.display().to_string(), "state": "written"},
            {"file": second.display().to_string(), "state": "written"},
        ]})
    );
    for file in [&first, &second] {
        assert_eq!(std::fs::read(file).expect("skill"), skill_text());
        let mode = std::fs::metadata(file).expect("mode").permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "{}", file.display());
    }
    assert!(shared.join("skills/soksak/SKILL.md").is_file());
    // A home without .agents gets no folder there.
    let only = Machine::new("skill-one-folder");
    let only_sok = only.bundle_sok("Test.app");
    only.folder(".claude");
    let run = run_sok(
        &only_sok,
        &["skill", "install"],
        &[("HOME", &only.home_text())],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert!(!only.home.join(".agents").exists());
}

// contract: cli.skill.rewrites-only-a-differing-file
#[test]
fn skill_install_rewrites_only_a_differing_file() {
    let machine = Machine::new("skill-rewrite");
    let sok = machine.bundle_sok("Test.app");
    let claude = machine.folder(".claude");
    let agents = machine.folder(".agents");
    let home = machine.home_text();
    let variables = [("HOME", home.as_str())];
    let first = run_sok(&sok, &["skill", "install"], &variables);
    assert_eq!(first.code, 0, "{}", first.stderr);
    let current = claude.join("skills/soksak/SKILL.md");
    let edited = agents.join("skills/soksak/SKILL.md");
    let modified = std::fs::metadata(&current)
        .expect("meta")
        .modified()
        .expect("time");
    std::fs::write(&edited, b"edited by a person\n").expect("edit");
    let second = run_sok(&sok, &["skill", "install"], &variables);
    assert_eq!(second.code, 0, "{}", second.stderr);
    assert_eq!(
        second.json(),
        serde_json::json!({"skills": [
            {"file": current.display().to_string(), "state": "current"},
            {"file": edited.display().to_string(), "state": "written"},
        ]})
    );
    assert_eq!(
        std::fs::metadata(&current)
            .expect("meta")
            .modified()
            .expect("time"),
        modified
    );
    assert_eq!(std::fs::read(&edited).expect("skill"), skill_text());
    for folder in [claude.join("skills/soksak"), agents.join("skills/soksak")] {
        assert_eq!(other_files(&folder, &["SKILL.md"]), Vec::<String>::new());
    }
    // Two installs at once both end with the skill text and leave no temporary file.
    std::fs::remove_file(&current).expect("remove");
    std::fs::write(&edited, b"edited again\n").expect("edit");
    let spawn = || {
        Command::new(&sok)
            .args(["skill", "install"])
            .env_clear()
            .env("HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn")
    };
    let (one, two) = (spawn(), spawn());
    for child in [one, two] {
        let output = child.wait_with_output().expect("wait");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for file in [&current, &edited] {
        assert_eq!(std::fs::read(file).expect("skill"), skill_text());
    }
    for folder in [claude.join("skills/soksak"), agents.join("skills/soksak")] {
        assert_eq!(other_files(&folder, &["SKILL.md"]), Vec::<String>::new());
    }
    let repeated = run_sok(&sok, &["skill", "install"], &variables);
    assert_eq!(
        repeated.json(),
        serde_json::json!({"skills": [
            {"file": current.display().to_string(), "state": "current"},
            {"file": edited.display().to_string(), "state": "current"},
        ]})
    );
}

// contract: cli.skill.fails-without-an-agent-folder
#[test]
fn skill_install_fails_without_an_agent_folder() {
    let machine = Machine::new("skill-none");
    let sok = machine.bundle_sok("Test.app");
    let home = machine.home_text();
    let run_none = run_sok(&sok, &["skill", "install"], &[("HOME", &home)]);
    assert_eq!(
        (run_none.code, run_none.stdout.as_str(), run_none.stderr.as_str()),
        (
            1,
            "",
            format!("sok: no agent folder: neither {home}/.claude nor {home}/.agents is a directory; sok skill print writes the skill to standard output\n").as_str()
        )
    );
    let config = machine
        .root
        .path()
        .join("missing-config")
        .display()
        .to_string();
    let run_config = run_sok(
        &sok,
        &["skill", "install"],
        &[("HOME", &home), ("CLAUDE_CONFIG_DIR", &config)],
    );
    assert_eq!(
        run_config.stderr,
        format!(
            "sok: no agent folder: neither {home}/.claude nor {config} nor {home}/.agents is a directory; sok skill print writes the skill to standard output\n"
        )
    );
    assert!(!machine.home.join(".claude").exists() && !machine.home.join(".agents").exists());
    let config = machine.root.path().join("config").display().to_string();
    let run_unset = run_sok(&sok, &["skill", "install", "--config-dir", &config], &[]);
    assert_eq!(
        (run_unset.code, run_unset.stderr.as_str()),
        (1, "sok: HOME is not set\n")
    );
}

// contract: cli.skill.reports-a-failed-write
#[test]
fn skill_install_reports_a_failed_write() {
    let machine = Machine::new("skill-failed");
    let sok = machine.bundle_sok("Test.app");
    // The first agent folder has a skill folder that cannot be written, the second one a skills folder in which the skill folder
    // cannot be created, and the third one is written after both failures.
    let locked = machine.folder(".claude/skills/soksak");
    let locked_skills = machine.folder("config/skills");
    machine.folder(".agents");
    let written = machine.home.join(".agents/skills/soksak/SKILL.md");
    for folder in [&locked, &locked_skills] {
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o555)).expect("lock");
    }
    let run = run_sok(
        &sok,
        &["skill", "install"],
        &[
            ("HOME", &machine.home_text()),
            (
                "CLAUDE_CONFIG_DIR",
                &machine.home.join("config").display().to_string(),
            ),
        ],
    );
    for folder in [&locked, &locked_skills] {
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o755)).expect("unlock");
    }
    assert_eq!(
        (run.code, run.stderr.as_str()),
        (
            1,
            format!(
                "sok: {}: permission denied; {}: permission denied\n",
                locked.join("SKILL.md").display(),
                locked_skills.join("soksak/SKILL.md").display()
            )
            .as_str()
        ),
        "{}",
        run.stdout
    );
    assert_eq!(
        run.json(),
        serde_json::json!({"skills": [{"file": written.display().to_string(), "state": "written"}]})
    );
    assert_eq!(std::fs::read(&written).expect("written"), skill_text());
    assert_eq!(other_files(&locked, &[]), Vec::<String>::new());
    assert_eq!(other_files(&locked_skills, &[]), Vec::<String>::new());
    assert_eq!(
        other_files(written.parent().expect("folder"), &["SKILL.md"]),
        Vec::<String>::new()
    );
}

/// The skill and the instructions of the MCP server name the plan and the apply of an arrangement and the move of a
/// tab beside the other layout operations, and state that the layout is read again and compared with the request
/// after a change (docs/spec/cli.md#agent-skill).
// contract: cli.skill.arrangement-guidance
#[test]
fn the_skill_and_the_instructions_name_the_arrangement_commands() {
    let skill = soksak_sok::agents::SKILL;
    let server: serde_json::Value =
        serde_json::from_str(soksak_sok::agents::MCP).expect("mcp.json");
    let instructions = server["instructions"].as_str().expect("instructions");
    for command in [
        "core.layout.plan",
        "core.layout.apply",
        "core.layout.move",
        "core.layout.open",
        "core.layout.select",
        "core.layout.close",
    ] {
        assert!(
            skill.contains(&format!("`{command} ")),
            "the skill does not name {command}"
        );
        assert!(
            instructions.contains(command),
            "the instructions of the MCP server do not name {command}"
        );
    }
    assert!(
        skill.contains("read `layout` again and compare the `frame` of each card with the request"),
        "the skill does not state the comparison of the frames with the request"
    );
    assert!(
        instructions
            .contains("read the frames of the layout again and compare them with the request"),
        "the instructions of the MCP server do not state the comparison of the frames with the request"
    );
}
