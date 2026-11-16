//! Tests of the identity of a project folder on the platform that names it by the volume UUID.
#![cfg(target_os = "macos")]

#[path = "support/folder.rs"]
mod folder;

use std::os::unix::fs::MetadataExt;
use std::process::Command;

use soksak_host::projects::folder as project_folder;

/// Reads the UUID of the volume that holds path from the system tools df and diskutil, which are independent of the host.
fn volume_uuid(path: &std::path::Path) -> String {
    let listing = Command::new("df").arg("-P").arg(path).output().unwrap();
    let text = String::from_utf8(listing.stdout).unwrap();
    let last = text.trim().lines().last().unwrap().to_string();
    let fields: Vec<&str> = last.split_whitespace().collect();
    let mount = fields[5..].join(" ");
    let info = Command::new("diskutil")
        .arg("info")
        .arg(&mount)
        .output()
        .unwrap();
    let text = String::from_utf8(info.stdout).unwrap();
    text.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("Volume UUID:")
                .map(|v| v.trim().to_string())
        })
        .unwrap_or_else(|| panic!("diskutil reported no volume UUID for {mount}"))
}

// contract: workspace.folder.identity-names-volume-uuid
#[test]
fn folder_identity_names_volume_uuid() {
    let root = folder::Folder::new();
    let found = project_folder(root.path().to_str().unwrap(), root.path()).unwrap();
    let inode = std::fs::metadata(&found.root).unwrap().ino();
    let want = format!("{}:{inode}", volume_uuid(std::path::Path::new(&found.root)));
    assert_eq!(
        found.identity, want,
        "identity is not <volume UUID>:<inode>"
    );
}
