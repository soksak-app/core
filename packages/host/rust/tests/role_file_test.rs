//! Replays the role file cases of docs/spec/agent-roles.md#role-file against the Rust host: the fingerprint and the layout of each
//! case in docs/spec/cases/agent-roles/fingerprint.json, the pinned texts of that file, and the atomic write of the file with its
//! modes.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::Value;
use soksak_host::role_file::{role_file_content, role_fingerprint, role_texts, write_role_file};

const FINGERPRINT_CASES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../docs/spec/cases/agent-roles/fingerprint.json"
);

fn load_cases() -> Value {
    serde_json::from_slice(&fs::read(FINGERPRINT_CASES).unwrap()).unwrap()
}

/// A temporary configuration directory that the test removes when it ends, also on a panic.
fn temp_config() -> tempfile::TempDir {
    tempfile::TempDir::new().unwrap()
}

fn with_line_feed(text: &str) -> String {
    if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    }
}

fn assert_mode(path: &Path, want: u32) {
    let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, want, "{} has mode {mode:o}", path.display());
}

// contract: roles.fingerprint-shared-cases
#[test]
fn role_fingerprint_matches_shared_cases() {
    for case in load_cases()["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        let want = case["fingerprint"].as_str().unwrap();
        assert_eq!(role_fingerprint(name, text), want, "case {name}");
    }
}

// contract: roles.role-file-layout
#[test]
fn role_file_has_first_line_definition_and_fingerprint() {
    let cases = load_cases();
    let first = cases["texts"]["role_file_first_line"].as_str().unwrap();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        let fingerprint = case["fingerprint"].as_str().unwrap();
        let want = format!("{first}\n{}{fingerprint}\n", with_line_feed(text));
        assert_eq!(role_file_content(name, text), want, "layout of {name}");
    }
    let got = role_file_content("ops-1", "Line one.");
    let want = format!(
        "{first}\nLine one.\n{}\n",
        role_fingerprint("ops-1", "Line one.")
    );
    assert_eq!(got, want, "layout without a final line feed");
    let long = "Check the tests and the contract. ".repeat(150);
    let long = &long[..5000];
    let got = role_file_content("long-role", long);
    assert!(
        got.contains(&format!("\n{long}\n")),
        "long definition not whole"
    );
    assert!(
        got.ends_with(&format!("{}\n", role_fingerprint("long-role", long))),
        "long fingerprint"
    );
}

// contract: roles.role-file-phrases
#[test]
fn role_texts_match_pinned_texts() {
    let temp = temp_config();
    let role_file = temp.path().join("agents/tab-1/role.md");
    let role_file = role_file.display().to_string();
    let texts = role_texts(&role_file);
    let mut want = BTreeMap::new();
    for (name, text) in load_cases()["texts"].as_object().unwrap() {
        let text = text.as_str().unwrap();
        let text = if name == "role_file_first_line" {
            text.to_string()
        } else {
            text.replace("<role file>", &role_file)
        };
        want.insert(name.clone(), text);
    }
    assert_eq!(texts, want);
}

// contract: roles.role-file-write
#[test]
fn write_role_file_writes_layout_atomically_with_modes() {
    let temp = temp_config();
    let config = temp.path();
    let path = write_role_file(&config, "tab-1", "reviewer", "You review.\n").unwrap();
    assert_eq!(path, config.join("agents/tab-1/role.md"));
    let data = fs::read_to_string(&path).unwrap();
    assert_eq!(data, role_file_content("reviewer", "You review.\n"));
    assert_mode(&path, 0o600);
    assert_mode(path.parent().unwrap(), 0o700);
    write_role_file(&config, "tab-1", "reviewer", "You review the tests.\n").unwrap();
    let data = fs::read_to_string(&path).unwrap();
    assert_eq!(
        data,
        role_file_content("reviewer", "You review the tests.\n")
    );
    let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .filter(|n| n.to_string_lossy().starts_with(".role-"))
        .collect();
    assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
}

// contract: roles.role-file-removes-leftovers
#[test]
fn write_role_file_removes_leftover_temporary_files() {
    let temp = temp_config();
    let config = temp.path();
    let folder = config.join("agents/tab-1");
    fs::create_dir_all(&folder).unwrap();
    let leftover = folder.join(".role-crash.tmp");
    fs::write(&leftover, b"partial").unwrap();
    write_role_file(&config, "tab-1", "reviewer", "You review.\n").unwrap();
    assert!(!leftover.exists(), "a leftover temporary file remains");
}

// contract: roles.role-file-refuses-surface
#[test]
fn write_role_file_refuses_surface_with_path_parts() {
    let temp = temp_config();
    let config = temp.path();
    for surface in ["", "..", "a/b", "../x", "a\u{1}b", "a\tb"] {
        assert!(
            write_role_file(&config, surface, "reviewer", "You review.\n").is_err(),
            "surface {surface:?} was accepted"
        );
    }
    assert_eq!(fs::read_dir(&config).unwrap().count(), 0);
}
