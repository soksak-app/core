//! Tests of the Git repository import: the clone into a target folder under home, and its refusals.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use soksak_host::projects::{CloneProject, clone_repository};

/// A local bare repository with one commit, which the clone reads through its path.
fn bare_repository(dir: &Path) -> PathBuf {
    let source = dir.join("source");
    fs::create_dir(&source).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q"]);
    fs::write(source.join("README.md"), "widget\n").unwrap();
    git(&["add", "README.md"]);
    git(&["commit", "-q", "-m", "init"]);
    let bare = dir.join("widget.git");
    let out = Command::new("git")
        .args(["clone", "-q", "--bare"])
        .arg(&source)
        .arg(&bare)
        .output()
        .unwrap();
    assert!(out.status.success());
    bare
}

fn request(address: &str, target: &str) -> CloneProject {
    serde_json::from_value(serde_json::json!({ "address": address, "target": target })).unwrap()
}

#[test]
fn clone_writes_the_repository_into_the_target() {
    let dir = tempfile::tempdir().unwrap();
    let address = bare_repository(dir.path());
    let home = dir.path().join("home");
    fs::create_dir_all(home.join("Work")).unwrap();
    let folder = clone_repository(
        request(address.to_str().unwrap(), "~/Work/widget"),
        &home,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(home.join("Work/widget/README.md")).unwrap(),
        "widget\n"
    );
    assert!(folder.root.ends_with("widget"));
    assert!(!folder.identity.is_empty());
}

#[test]
fn clone_refuses_an_existing_target_and_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    let address = bare_repository(dir.path());
    let target = dir.path().join("widget");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep.txt"), "kept").unwrap();
    let err = clone_repository(
        request(address.to_str().unwrap(), target.to_str().unwrap()),
        dir.path(),
        &mut |_| Ok(()),
    )
    .unwrap_err();
    assert!(err.contains("already exists"), "error was {err}");
    assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "kept");
}

#[test]
fn a_failed_clone_leaves_no_target_folder() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("widget");
    let missing = dir.path().join("missing.git");
    let err = clone_repository(
        request(missing.to_str().unwrap(), target.to_str().unwrap()),
        dir.path(),
        &mut |_| Ok(()),
    )
    .unwrap_err();
    assert!(!err.is_empty());
    assert!(
        !target.exists(),
        "the target remains after the failed clone"
    );
}

#[test]
fn clone_reports_each_output_line_to_the_progress_callback() {
    let dir = tempfile::tempdir().unwrap();
    let address = bare_repository(dir.path());
    let target = dir.path().join("widget");
    let mut lines = Vec::new();
    clone_repository(
        request(address.to_str().unwrap(), target.to_str().unwrap()),
        dir.path(),
        &mut |line: &str| {
            lines.push(line.to_string());
            Ok(())
        },
    )
    .unwrap();
    assert!(
        lines.iter().any(|line| line.starts_with("Cloning into")),
        "the callback received {lines:?}, want the output of git"
    );
}

#[test]
fn an_empty_address_and_a_dash_address_are_refused_before_a_clone() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("widget");
    assert_eq!(
        clone_repository(
            request("  ", target.to_str().unwrap()),
            dir.path(),
            &mut |_| Ok(())
        )
        .unwrap_err(),
        "the address is empty"
    );
    assert_eq!(
        clone_repository(
            request("--upload-pack=x", target.to_str().unwrap()),
            dir.path(),
            &mut |_| Ok(()),
        )
        .unwrap_err(),
        "the address starts with -"
    );
    assert!(!target.exists());
}
