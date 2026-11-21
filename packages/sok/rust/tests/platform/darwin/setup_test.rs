//! Checks the setup operations of sok that macOS decides (docs/spec/cli.md#mcp-registration, docs/spec/cli.md#setup-parts): the
//! running sok must be the sok of an application bundle, and the judgement with which `sok path install` refuses the running sok
//! and `sok mcp install` refuses the running sok on a read-only volume. The read-only volume is the sealed system volume of
//! macOS, which statvfs reports read-only; the writable volume is the one of the temporary folder of the test.

#![cfg(target_os = "macos")]

#[path = "../../support/agents.rs"]
mod agents;
#[path = "../../support/folder.rs"]
mod folder;

use std::path::Path;

use serde_json::Value;

use agents::{Machine, calls, path_of, run_sok};
use folder::Folder;
use soksak_sok::setup::{
    Environment, State, configure_user_path, require_writable_volume, user_path_state,
};

// contract: cli.setup.user-path-registration
#[test]
fn user_path_is_installed_once_and_stays_disabled_after_removal() {
    let machine = Machine::new("user-path");
    let sok = machine.sok_in(&machine.home.join("Applications/Test.app/Contents/MacOS"));
    let profile = machine.home.join(".zshrc");
    let original = b"# settings owned by the person\n";
    std::fs::write(&profile, original).expect("write startup file");
    let public = machine.home.join(".local/bin/sok");
    let private = machine.home.join(".local/share/soksak/sok");
    let settings = machine
        .home
        .join("Library/Application Support/app.soksak/agent-setup.json");
    let mut environment = Environment {
        home: Some(machine.home_text()),
        path: Some("/usr/bin:/bin".to_string()),
        claude_config_dir: None,
        variables: Default::default(),
    };
    let initial = user_path_state(&environment).expect("inspect missing registration");
    assert_eq!(
        (initial.enabled, initial.state),
        (Some(true), State::Missing)
    );
    assert!(!settings.exists());
    assert!(configure_user_path(&environment, "/bin/zsh", &sok, None).expect("register"));
    assert_eq!(std::fs::read_link(&public).expect("public link"), private);
    assert_eq!(std::fs::read_link(&private).expect("private link"), sok);
    let installed = std::fs::read_to_string(&profile).expect("read installed startup file");
    assert!(installed.starts_with(std::str::from_utf8(original).expect("startup text")));
    assert_eq!(installed.matches("# >>> soksak PATH >>>").count(), 1);
    let preferences: Value = serde_json::from_slice(&std::fs::read(&settings).expect("settings"))
        .expect("parse preferences");
    assert_eq!(
        preferences,
        serde_json::json!({
            "format": 1,
            "path": {"enabled": true, "profiles": [profile]}
        })
    );
    environment.path = Some(path_of(&[
        Path::new("/usr/bin"),
        Path::new("/bin"),
        &machine.home.join(".local/bin"),
    ]));
    let active = user_path_state(&environment).expect("inspect registered path");
    assert_eq!((active.enabled, active.state), (Some(true), State::Ok));
    assert!(!configure_user_path(&environment, "/bin/zsh", &sok, None).expect("reconcile again"));
    assert_eq!(
        std::fs::read_to_string(&profile).expect("same startup file"),
        installed
    );

    assert!(
        configure_user_path(&environment, "/bin/zsh", &sok, Some(false))
            .expect("disable registration")
    );
    assert!(std::fs::symlink_metadata(&public).is_err());
    assert!(std::fs::symlink_metadata(&private).is_err());
    assert_eq!(
        std::fs::read(&profile).expect("read restored startup file"),
        original
    );
    let disabled = user_path_state(&environment).expect("read disabled preference");
    assert_eq!((disabled.enabled, disabled.state), (Some(false), State::Ok));
    assert!(
        !configure_user_path(&environment, "/bin/zsh", &sok, None).expect("start when disabled")
    );
    assert!(std::fs::symlink_metadata(&public).is_err());
}

// contract: cli.setup.user-path-registration
#[test]
fn existing_links_are_kept_when_user_path_registration_is_disabled() {
    let machine = Machine::new("existing-user-path");
    let existing = machine.sok_in(
        &machine
            .home
            .join("Applications/Existing.app/Contents/MacOS"),
    );
    let running = machine.sok_in(&machine.home.join("Applications/Running.app/Contents/MacOS"));
    let bin = machine.folder(".local/bin");
    let public = bin.join("sok");
    std::os::unix::fs::symlink(&existing, &public).expect("existing link");
    let environment = Environment {
        home: Some(machine.home_text()),
        path: Some(path_of(&[&bin])),
        claude_config_dir: None,
        variables: Default::default(),
    };
    let found = user_path_state(&environment).expect("determine current command");
    assert_eq!((found.enabled, found.state), (Some(true), State::Ok));
    assert_eq!(Path::new(&found.file), existing);
    assert!(
        !configure_user_path(&environment, "/bin/zsh", &running, None)
            .expect("keep current command")
    );
    assert!(
        configure_user_path(&environment, "/bin/zsh", &running, Some(false)).expect("set disabled")
    );
    assert_eq!(
        std::fs::read_link(&public).expect("link is unchanged"),
        existing
    );
    assert!(!machine.home.join(".local/share/soksak/sok").exists());
    assert!(!machine.home.join(".zshrc").exists());
}

// contract: cli.mcp.install-requires-a-bundle-sok
#[test]
fn mcp_install_requires_a_bundle_sok() {
    let machine = Machine::new("mcp-not-bundle");
    let sok = machine.bundle_sok("Test.app");
    let plain = machine.sok_in(&machine.root.path().join("build"));
    let path = path_of(&[
        sok.parent().expect("folder"),
        &machine.tools(&["claude"]),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ]);
    let variables = [("HOME", machine.home_text()), ("PATH", path)];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let expected = format!(
        "the running sok, {}, is not the sok of an application bundle",
        plain.display()
    );
    let install = run_sok(&plain, &["mcp", "install"], &variables);
    assert_eq!(
        (install.code, install.stderr.as_str()),
        (1, format!("sok: {expected}\n").as_str())
    );
    let check = run_sok(&plain, &["setup", "check"], &variables);
    let parts = check.json()["parts"].clone();
    let mcp = parts
        .as_array()
        .expect("parts")
        .iter()
        .find(|part| part["part"] == "mcp")
        .expect("mcp part")
        .clone();
    assert_eq!(
        (mcp["state"].clone(), mcp["error"].clone()),
        (Value::from("error"), Value::from(expected))
    );
    assert_eq!(calls(&machine), Vec::<String>::new());
}

// contract: cli.setup.refuses-a-read-only-volume
#[test]
fn refuses_a_sok_on_a_read_only_volume() {
    let system = Path::new("/usr/bin/true");
    assert_eq!(
        require_writable_volume(system),
        Err(
            "/usr/bin/true is on a read-only volume; move the application to a folder such as /Applications and start it again"
                .to_string()
        )
    );
    let root = Folder::new("read-only");
    let writable = root.path().join("sok");
    std::fs::write(&writable, "").expect("sok");
    assert_eq!(require_writable_volume(&writable), Ok(()));
}
