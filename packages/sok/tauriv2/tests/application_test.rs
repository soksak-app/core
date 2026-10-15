//! Checks how the installer finds an installed application of a connector plugin (docs/spec/installation.md#applications):
//! each locate entry is tried in order, and the first that finds the application gives its executable and the method. The
//! search path of a command is an argument, which the installer takes from PATH.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::json;
use soksak_sok::application::locate;

fn executable(path: &Path) {
    std::fs::write(path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn ways(value: serde_json::Value) -> Vec<serde_json::Map<String, serde_json::Value>> {
    serde_json::from_value(value).unwrap()
}

// contract: application.locate.command-on-search-path
#[test]
fn locate_finds_a_command_on_the_path() {
    let folder = tempfile::tempdir().unwrap();
    executable(&folder.path().join("fake-sketcher"));
    let located = locate(
        &ways(json!([{"command": "fake-sketcher"}])),
        "sketcher",
        folder.path().as_os_str(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(located.path, folder.path().join("fake-sketcher"));
    assert_eq!(located.method, "command");
}

// contract: application.locate.first-way-that-finds
#[test]
fn locate_tries_each_way_in_order_and_takes_the_first_that_finds() {
    let folder = tempfile::tempdir().unwrap();
    let empty = tempfile::tempdir().unwrap();
    let present = folder.path().join("sketcher");
    executable(&present);
    let list = ways(
        json!([{"command": "absent-sketcher"}, {"path": folder.path().join("missing")}, {"path": present}]),
    );
    let located = locate(&list, "sketcher", empty.path().as_os_str())
        .unwrap()
        .unwrap();
    assert_eq!(located.path, present);
    assert_eq!(located.method, "path");
}

// contract: application.locate.skips-non-executable
#[test]
fn locate_does_not_take_a_file_that_is_not_executable() {
    let folder = tempfile::tempdir().unwrap();
    let empty = tempfile::tempdir().unwrap();
    let path = folder.path().join("sketcher");
    std::fs::write(&path, "text").unwrap();
    let list = ways(json!([{"path": path}, {"command": "absent-sketcher"}]));
    assert!(
        locate(&list, "sketcher", empty.path().as_os_str())
            .unwrap()
            .is_none()
    );
}

// contract: application.locate.bundle-by-identifier
/// A bundle identifier is found through the metadata index of darwin, and another platform refuses the entry.
#[test]
fn locate_finds_a_bundle_by_its_identifier() {
    let key = soksak_sok::platform::current().unwrap().key().unwrap();
    let result = locate(
        &ways(json!([{"bundle": "com.apple.finder"}])),
        "Finder.app/Contents/MacOS/Finder",
        std::ffi::OsStr::new(""),
    );
    if !key.starts_with("darwin-") {
        assert!(result.unwrap_err().contains("not implemented on"), "{key}");
        return;
    }
    let located = result.unwrap().unwrap();
    assert_eq!(
        located.path,
        Path::new("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder")
    );
    assert_eq!(located.method, "bundle");
}
