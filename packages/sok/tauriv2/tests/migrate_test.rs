//! The migration of `plugins/installed.json` at the entry of its shared reader (docs/spec/installation.md#stored-data-migration).
//! The same cases run in the Go host.

use std::path::{Path, PathBuf};

use soksak_sok::install::INSTALLED_FORMAT;
use soksak_sok::migrate::migrate_installed;
use soksak_sok::plugins::read_installed;

/// The released form of plugins/installed.json of format 2, with the `package` member, `^` ranges and the sidecar entry
/// its plugin names, exactly as an earlier release wrote it.
const RELEASED_FORMAT_2: &str = r#"{
  "format": 2,
  "plugins": {
    "probe": {
      "package": "@scope/plugin-probe",
      "version": "0.0.4",
      "path": "plugins/probe/0.0.4",
      "enabled": true,
      "sidecars": {},
      "previous": "0.0.3"
    },
    "probe2": {
      "package": "@scope/plugin-probe2",
      "version": "0.0.2",
      "path": "plugins/probe2/0.0.2",
      "enabled": true,
      "sidecars": {
        "@scope/sidecar-probe": "^0.0.4"
      }
    }
  },
  "sidecars": {
    "@scope/sidecar-probe": {
      "version": "0.0.4",
      "path": "sidecars/scope-sidecar-probe/0.0.4/darwin-arm64"
    }
  }
}"#;

/// A unique empty folder for one test, removed at the end.
fn temp_config(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("sok-migrate-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn write_installed_raw(config: &Path, text: &str) -> PathBuf {
    std::fs::create_dir_all(config.join("plugins")).unwrap();
    let path = config.join("plugins").join("installed.json");
    std::fs::write(&path, text).unwrap();
    path
}

// contract: install.migration.migrates-the-released-form
#[test]
fn migrate_installed_migrates_the_released_format_2_to_the_current_format() {
    let config = temp_config("released");
    let path = write_installed_raw(config.as_path(), RELEASED_FORMAT_2);
    assert_eq!(migrate_installed(config.as_path()).unwrap(), 3);
    let state = read_installed(config.as_path()).unwrap();
    assert_eq!(state.format, INSTALLED_FORMAT);
    let browser = state.plugins.get("probe").unwrap();
    assert_eq!(
        (
            browser.version.as_str(),
            browser.path.as_str(),
            browser.enabled,
            browser.previous.as_deref()
        ),
        ("0.0.4", "plugins/probe/0.0.4", true, Some("0.0.3"))
    );
    let editor = state.plugins.get("probe2").unwrap();
    assert_eq!(
        editor
            .sidecars
            .get("@scope/sidecar-probe")
            .map(String::as_str),
        Some("^0.0.4")
    );
    let text = std::fs::read_to_string(&path).unwrap();
    assert_ne!(text, RELEASED_FORMAT_2, "the file was not rewritten");
    let _ = std::fs::remove_dir_all(&config);
}

// contract: install.migration.is-idempotent
#[test]
fn migrate_installed_is_idempotent_and_leaves_a_current_file_and_a_missing_file_untouched() {
    let config = temp_config("idempotent");
    let path = write_installed_raw(config.as_path(), RELEASED_FORMAT_2);
    migrate_installed(config.as_path()).unwrap();
    let first = std::fs::read_to_string(&path).unwrap();
    assert_eq!(migrate_installed(config.as_path()).unwrap(), 0);
    let second = std::fs::read_to_string(&path).unwrap();
    assert_eq!(first, second, "the bytes changed");
    let empty = temp_config("empty");
    assert_eq!(migrate_installed(&empty).unwrap(), 0);
    assert!(
        !empty.join("plugins").join("installed.json").exists(),
        "a missing file was created"
    );
    let _ = std::fs::remove_dir_all(&config);
    let _ = std::fs::remove_dir_all(&empty);
}

// contract: install.migration.refuses-forms-outside-the-chain
#[test]
fn migrate_installed_refuses_a_form_the_definitions_do_not_cover() {
    for (name, text) in [
        (
            "format 1",
            r#"{"format": 1, "plugins": {}, "sidecars": {}}"#,
        ),
        (
            "above the chain",
            r#"{"format": 9, "plugins": {}, "sidecars": {}}"#,
        ),
        ("not JSON", "{"),
    ] {
        let config = temp_config("main");
        write_installed_raw(config.as_path(), text);
        let error = migrate_installed(config.as_path()).unwrap_err();
        assert!(
            error.contains("plugins/installed.json"),
            "{name}: {error} does not name the file"
        );
        let _ = std::fs::remove_dir_all(config);
    }
}

// contract: install.migration.chain-ends-at-the-current-format
#[test]
fn the_definition_chain_ends_at_the_current_format() {
    let chains = soksak_sok::migrate::migration_chains_for_test().unwrap();
    let chain = chains
        .get("plugins/installed.json")
        .expect("the definitions hold no chain for plugins/installed.json");
    let last = chain.last().unwrap();
    assert_eq!(
        last.to, INSTALLED_FORMAT,
        "the chain ends at another format than the reader requires"
    );
    for (index, step) in chain.iter().enumerate() {
        if index > 0 {
            assert_eq!(
                step.from,
                chain[index - 1].to,
                "a step does not start where the earlier one ends"
            );
        }
    }
}
