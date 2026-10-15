//! The ownership of the configuration directory for the duration of a write of a plugin command of the command line
//! (docs/spec/installation.md). The same cases run in the Go host.

use std::fs;
use std::path::Path;

use soksak_sok::plugins::run_plugin_action;

fn write_raw(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// The released form of plugins/installed.json of format 2 with two plugins and their folders.
fn released_config(config: &Path) {
    write_raw(
        &config.join("plugins/installed.json"),
        r#"{"format": 2, "plugins": {"probe": {"package": "@scope/plugin-probe", "version": "0.0.4", "path": "plugins/probe/0.0.4", "enabled": true, "sidecars": {}}, "probe2": {"package": "@scope/plugin-probe2", "version": "0.0.2", "path": "plugins/probe2/0.0.2", "enabled": true, "sidecars": {}}}, "sidecars": {}}"#,
    );
    for (id, version, name) in [
        ("probe", "0.0.4", "@scope/plugin-probe"),
        ("probe2", "0.0.2", "@scope/plugin-probe2"),
    ] {
        let plugin = config.join("plugins").join(id).join(version);
        fs::create_dir_all(&plugin).unwrap();
        write_raw(
            &plugin.join("package.json"),
            &format!(r#"{{"name":"{name}"}}"#),
        );
        if id == "probe2" {
            write_raw(&plugin.join("plugin.json"), r#"{"id":"probe2"}"#);
        }
    }
}

/// The command line run of the plugins tests, with the configuration directory of the test.
fn run_cli(config: &Path, args: &[&str]) -> (i32, String, String) {
    let mut full: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    full.push("--config-dir".into());
    full.push(config.display().to_string());
    let (mut stdout, mut stderr) = (vec![], vec![]);
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(Path::new("/nonexistent/paths.d")),
        core_version: "0.0.2",
    };
    let code = soksak_sok::run(&full, &mut stdout, &mut stderr, &options);
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

// contract: cli.plugin.writing-commands-own-the-configuration
#[test]
fn a_plugin_command_refuses_while_another_process_owns_the_configuration() {
    let config = std::env::temp_dir().join(format!("sok-own-refuse-{}", std::process::id()));
    let _ = fs::remove_dir_all(&config);
    fs::create_dir_all(config.join("plugins")).unwrap();
    released_config(&config);
    // A live process (this test) owns the configuration directory through its lock, as a running host does.
    fs::write(config.join("process.lock"), std::process::id().to_string()).unwrap();
    let (code, _, stderr) = run_cli(&config, &["plugin", "disable", "probe"]);
    assert_eq!(code, 1, "{stderr}");
    let want = format!(
        "sok: configuration directory {} is already owned by process {}\n",
        config.display(),
        std::process::id()
    );
    assert_eq!(stderr, want);
    fs::remove_file(config.join("process.lock")).unwrap();
    let _ = fs::remove_dir_all(&config);
}

// contract: cli.plugin.writing-commands-own-the-configuration
#[test]
fn a_writing_command_releases_the_configuration_when_it_ends() {
    let config = std::env::temp_dir().join(format!("sok-own-release-{}", std::process::id()));
    let _ = fs::remove_dir_all(&config);
    fs::create_dir_all(&config).unwrap();
    released_config(&config);
    let (code, _, stderr) = run_cli(&config, &["plugin", "disable", "probe"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!config.join("process.lock").exists(), "the lock stayed");
    // A second command runs at once: the first released the configuration when it ended.
    let (code, _, stderr) = run_cli(&config, &["plugin", "disable", "probe2"]);
    assert_eq!(code, 0, "{stderr}");
    let text = fs::read_to_string(config.join("plugins/installed.json")).unwrap();
    assert!(
        !text.contains("\"package\""),
        "the second command did not see the migrated file"
    );
    let _ = fs::remove_dir_all(&config);
}

// contract: cli.plugin.host-entry-takes-no-lock
// The host calls run_plugin_action inside its own ownership of the configuration directory, so that entry takes no
// lock: a host that holds process.lock for its lifetime still runs its plugin operations.
#[test]
fn run_plugin_action_takes_no_lock_beside_a_live_owner() {
    let config = std::env::temp_dir().join(format!("sok-own-host-{}", std::process::id()));
    let _ = fs::remove_dir_all(&config);
    fs::create_dir_all(&config).unwrap();
    released_config(&config);
    // The host's own lock is present, owned by this live process.
    fs::write(config.join("process.lock"), std::process::id().to_string()).unwrap();
    if let Err(error) = run_plugin_action(&config, "disable", "probe", "", "", &mut |_| {}) {
        panic!("the host entry refused beside its own lock: {error}");
    }
    let _ = fs::remove_dir_all(&config);
}
