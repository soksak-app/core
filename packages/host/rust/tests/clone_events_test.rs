//! Tests of the events of the repository import: each clone writes `host.clone.start`, one `host.clone.line` for each output
//! line of git and `host.clone.end` with the exit status of git, through the writer of the records (docs/spec/logging.md).

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
fn clone_records_its_start_lines_and_end_as_events() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    fs::create_dir(&config).unwrap();
    let writer = records::start_writer(&config);
    let address = source_repository(dir.path());
    let target = dir.path().join("widget");
    let target_text = target.to_str().unwrap().to_string();
    clone_repository(request(&address, &target_text), dir.path(), &mut |_| Ok(())).unwrap();
    writer.flush().unwrap();
    let events = records::read_events(&records::event_log_path(&config));
    let mut names = Vec::new();
    let mut end = None;
    for event in &events {
        let Some(name) = event["event"].as_str() else { continue };
        if !name.starts_with("host.clone.") {
            continue;
        }
        assert!(
            !event["fields"].to_string().contains(&address),
            "{name} stores the address: {}",
            event["fields"]
        );
        if name == "host.clone.end" {
            end = Some(event["fields"].clone());
        }
        names.push(name.to_string());
    }
    assert_eq!(names.first().map(String::as_str), Some("host.clone.start"), "events {names:?}");
    assert_eq!(names.last().map(String::as_str), Some("host.clone.end"), "events {names:?}");
    assert!(names.iter().any(|name| name == "host.clone.line"), "events {names:?}");
    let end = end.expect("host.clone.end");
    assert_eq!(end["status"], 0, "host.clone.end fields {end}");
    assert_eq!(end["target"], target_text.as_str(), "host.clone.end fields {end}");
}
