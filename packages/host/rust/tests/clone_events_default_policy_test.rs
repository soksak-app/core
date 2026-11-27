//! The clone events pass the default policy of a diagnostic build (docs/spec/logging.md#policy). The writer of the records is
//! shared by the process, so this check is its own test binary: the events of another test of the same binary would reach it.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use std::fs;
use std::path::Path;
use std::process::Command;

use soksak_host::projects::{CloneProject, clone_repository};

/// A local repository with one commit, which the clone reads through its file address.
fn source_repository(dir: &Path) -> String {
    let source = dir.join("source");
    fs::create_dir(&source).unwrap();
    let out = Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["init", "-q"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let out = Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["commit", "-q", "--allow-empty", "-m", "first"])
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success());
    format!("file://{}", source.display())
}

fn request(address: &str, target: &str) -> CloneProject {
    serde_json::from_value(serde_json::json!({ "address": address, "target": target })).unwrap()
}

#[test]
fn clone_events_pass_the_default_policy_of_a_diagnostic_build() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    fs::create_dir(&config).unwrap();
    // The writer keeps its default policy, which stores only errors, so the clone events pass only as named exceptions.
    let log = std::sync::Arc::new(soksak_host::event_log::start_host(&config).unwrap());
    soksak_host::event_record::use_host_event_log(Some(std::sync::Arc::clone(&log)));
    let address = source_repository(dir.path());
    let target = dir.path().join("widget");
    clone_repository(
        request(&address, target.to_str().unwrap()),
        dir.path(),
        &mut |_| Ok(()),
    )
    .unwrap();
    log.flush().unwrap();
    soksak_host::event_record::use_host_event_log(None);
    let events = records::read_events(&records::event_log_path(&config));
    let names: Vec<&str> = events.iter().filter_map(|event| event["event"].as_str()).collect();
    for name in ["host.clone.start", "host.clone.line", "host.clone.end"] {
        // The class table declares each clone event as lifecycle, the class that the catalog declares for it.
        assert_eq!(
            soksak_sok::event_classes::class_of(name),
            Some(soksak_sok::event_classes::Class::Lifecycle),
            "class_of({name})"
        );
        assert!(names.contains(&name), "the default policy stored no {name} event: {names:?}");
    }
}
