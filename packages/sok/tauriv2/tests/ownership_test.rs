//! The ownership of the configuration directory for the duration of a write of a plugin command
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
        r#"{"format": 2, "plugins": {"probe": {"package": "@scope/plugin-probe", "version": "0.0.4", "path": "plugins/probe/0.0.4", "enabled": true, "sidecars": {}}}, "sidecars": {}}"#,
    );
    write_raw(
        &config.join("plugins/probe/0.0.4/package.json"),
        r#"{"name":"@scope/plugin-probe"}"#,
    );
}

// contract: cli.plugin.writing-commands-own-the-configuration
#[test]
fn a_plugin_command_refuses_while_another_process_owns_the_configuration() {
    let config = std::env::temp_dir().join(format!("sok-own-refuse-{}", std::process::id()));
    let _ = fs::remove_dir_all(&config);
    fs::create_dir_all(config.join("plugins")).unwrap();
    released_config(&config);
    // A live process (this test) owns the configuration directory through its lock.
    fs::write(config.join("process.lock"), std::process::id().to_string()).unwrap();
    let error = match run_plugin_action(&config, "disable", "probe", "", "") {
        Ok(_) => panic!("a write command ran while another process owned the configuration"),
        Err(error) => error,
    };
    let want = format!(
        "configuration directory {} is already owned by process {}",
        config.display(),
        std::process::id()
    );
    assert_eq!(error, want);
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
    run_plugin_action(&config, "disable", "probe", "", "").unwrap();
    assert!(!config.join("process.lock").exists(), "the lock stayed");
    // A second command runs at once: the first released the configuration when it ended.
    run_plugin_action(&config, "disable", "probe", "", "").unwrap();
    let text = fs::read_to_string(config.join("plugins/installed.json")).unwrap();
    assert!(
        !text.contains("\"package\""),
        "the second command did not see the migrated file"
    );
    let _ = fs::remove_dir_all(&config);
}
