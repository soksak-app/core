//! The migration of `plugins/installed.json` at the entry of its shared reader (docs/spec/installation.md#stored-data-migration).
//! The same cases run in the Go host.

use std::path::{Path, PathBuf};

use soksak_sok::install::INSTALLED_FORMAT;
use soksak_sok::migrate::{migrate_installed, migrate_projects};
use soksak_sok::plugins::read_installed;

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

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

fn temp_config(name: &str) -> Folder {
    Folder::new(&format!("migrate-{name}"))
}

fn write_installed_raw(config: &Path, text: &str) -> PathBuf {
    std::fs::create_dir_all(config.join("plugins")).unwrap();
    let path = config.join("plugins").join("installed.json");
    std::fs::write(&path, text).unwrap();
    path
}

/// Writes the plugin.json of each folder that RELEASED_FORMAT_2 records, as an installation extracts them.
fn write_released_folders(config: &Path) {
    for (id, version) in [("probe", "0.0.4"), ("probe2", "0.0.2")] {
        let folder = config.join("plugins").join(id).join(version);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("plugin.json"), format!(r#"{{"id": "{id}"}}"#)).unwrap();
    }
}

// contract: install.migration.migrates-the-released-form
#[test]
fn migrate_installed_migrates_the_released_format_2_to_the_current_format() {
    let config = temp_config("released");
    let path = write_installed_raw(config.path(), RELEASED_FORMAT_2);
    write_released_folders(config.path());
    assert_eq!(migrate_installed(config.path()).unwrap(), 3);
    let state = read_installed(config.path()).unwrap();
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
}

// contract: install.migration.is-idempotent
#[test]
fn migrate_installed_is_idempotent_and_leaves_a_current_file_and_a_missing_file_untouched() {
    let config = temp_config("idempotent");
    let path = write_installed_raw(config.path(), RELEASED_FORMAT_2);
    migrate_installed(config.path()).unwrap();
    let first = std::fs::read_to_string(&path).unwrap();
    assert_eq!(migrate_installed(config.path()).unwrap(), 0);
    let second = std::fs::read_to_string(&path).unwrap();
    assert_eq!(first, second, "the bytes changed");
    let empty = temp_config("empty");
    assert_eq!(migrate_installed(&empty).unwrap(), 0);
    assert!(
        !empty.join("plugins").join("installed.json").exists(),
        "a missing file was created"
    );
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
        write_installed_raw(config.path(), text);
        let error = migrate_installed(config.path()).unwrap_err();
        assert!(
            error.contains("plugins/installed.json"),
            "{name}: {error} does not name the file"
        );
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

// contract: install.migration.settings-migrates-the-form-without-a-number
#[test]
fn migrate_settings_adds_the_format_number_of_the_form_without_one() {
    let config = temp_config("settings");
    let path = config.join("settings.json");
    std::fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
    assert_eq!(soksak_sok::migrate::migrate_settings(&config).unwrap(), 1);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("\"format\": 1") && text.contains("\"theme\": \"dark\""),
        "{text}"
    );
    assert_eq!(soksak_sok::migrate::migrate_settings(&config).unwrap(), 0);
}

// contract: install.migration.projects-wraps-the-bare-list
#[test]
fn migrate_projects_wraps_the_bare_list_of_the_earlier_form() {
    let config = temp_config("projects");
    let path = config.join("projects.json");
    std::fs::write(
        &path,
        r#"[{"id":"prj-1","root":"/tmp/a","identity":"1:2"}]"#,
    )
    .unwrap();
    assert_eq!(soksak_sok::migrate::migrate_projects(&config).unwrap(), 1);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.contains("\"format\": 1") && text.contains("\"id\": \"prj-1\""),
        "{text}"
    );
    assert_eq!(soksak_sok::migrate::migrate_projects(&config).unwrap(), 0);
}

// A migration happens once, at the install moment, so its record passes every gate: the default policy, which stores only
// errors, still stores it (docs/spec/logging.md#policy).
// contract: install.migration.record-passes-every-gate
#[test]
fn the_record_of_a_migration_passes_the_default_policy() {
    use soksak_sok::event_log::{EventLog, Options};
    use soksak_sok::migrate::use_migration_log;
    use std::sync::Arc;
    use std::time::Duration;

    let config = temp_config("record");
    write_installed_raw(config.path(), RELEASED_FORMAT_2);
    let log = Arc::new(
        EventLog::start(Options {
            directory: config.join("logs"),
            role: "sok".into(),
            boot: "b1".into(),
            layer: "sok",
            clock: || 1,
            spawn: |work| {
                std::thread::Builder::new()
                    .spawn(work)
                    .map_err(|error| error.to_string())
            },
            queue_events: 64,
            queue_bytes: 64 * 1024,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            policy_path: None,
            prune: None,
        })
        .unwrap(),
    );
    use_migration_log(Some(Arc::clone(&log)));
    let migrated = migrate_installed(config.path());
    use_migration_log(None);
    assert_eq!(migrated.unwrap(), 3);
    log.flush(Duration::from_secs(5)).unwrap();
    let stored: Vec<serde_json::Value> = std::fs::read_to_string(log.path())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let records: Vec<&serde_json::Value> = stored
        .iter()
        .filter(|event| event["event"] == "log.migrated")
        .collect();
    assert_eq!(
        records.len(),
        1,
        "the default policy stored {stored:?}, without one log.migrated"
    );
    assert_eq!(records[0]["fields"]["from"], 2);
    log.close();
}

// A format member that is not an integer is refused with its text. Only a missing member is the form 0.
// contract: install.migration.refuses-forms-outside-the-chain
#[test]
fn migrate_projects_refuses_a_format_member_that_is_not_an_integer() {
    for (name, text) in [
        ("a string", r#"{"format": "1", "projects": []}"#),
        ("a fraction", r#"{"format": 1.5, "projects": []}"#),
    ] {
        let config = temp_config("format-member");
        std::fs::write(config.path().join("projects.json"), text).unwrap();
        let error = migrate_projects(config.path()).unwrap_err();
        assert!(
            error.contains("format must be a number"),
            "{name}: {error} does not name the format member"
        );
    }
}
