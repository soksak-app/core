//! Checks the record of connected applications (docs/spec/installation.md#applications): plugins/applications.json holds
//! format 1 with the place and the way of each application, another form is refused with the file and what it found, and
//! removing an application deletes the folder of an installed one and only the entry of a located one.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use soksak_sok::application::{
    ApplicationRecord, read_applications, record_application, remove_application,
};

fn executable(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn record(version: &str, path: &Path, how: &str, method: &str) -> ApplicationRecord {
    ApplicationRecord {
        version: version.into(),
        path: path.display().to_string(),
        how: how.into(),
        method: method.into(),
    }
}

// contract: application.record.holds-place-and-way
#[test]
fn the_record_holds_each_application_with_its_place_and_way() {
    let config = tempfile::tempdir().unwrap();
    assert!(
        read_applications(config.path())
            .unwrap()
            .applications
            .is_empty()
    );
    let located = record(
        "1.0.0",
        Path::new("/Applications/Sketcher.app/Contents/MacOS/sketcher"),
        "located",
        "bundle",
    );
    record_application(config.path(), "sketcher", located.clone()).unwrap();
    let state = read_applications(config.path()).unwrap();
    assert_eq!(state.format, 1);
    assert_eq!(state.applications.get("sketcher"), Some(&located));
}

// contract: application.record.refuses-other-form
#[test]
fn a_record_of_another_form_is_refused_with_the_file_and_what_it_found() {
    let config = tempfile::tempdir().unwrap();
    let path = config.path().join("plugins/applications.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, r#"{"format": 2, "applications": {}}"#).unwrap();
    let error = read_applications(config.path()).unwrap_err();
    assert!(
        error.contains(&path.display().to_string()) && error.contains("format must be 1"),
        "{error}"
    );
}

// contract: application.record.removal-by-way
#[test]
fn removing_deletes_the_folder_of_an_installed_application_and_only_the_entry_of_a_located_one() {
    let config = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let installed = config
        .path()
        .join("applications/sketcher/1.0.0/bin/sketcher");
    executable(&installed);
    let outside = elsewhere.path().join("painter");
    executable(&outside);
    record_application(
        config.path(),
        "sketcher",
        record("1.0.0", &installed, "installed", "release"),
    )
    .unwrap();
    record_application(
        config.path(),
        "painter",
        record("2.0.0", &outside, "located", "path"),
    )
    .unwrap();
    remove_application(config.path(), "sketcher").unwrap();
    remove_application(config.path(), "painter").unwrap();
    assert!(
        !config.path().join("applications/sketcher").exists(),
        "the installed application stayed"
    );
    assert!(outside.exists(), "the located application was touched");
    assert!(
        read_applications(config.path())
            .unwrap()
            .applications
            .is_empty()
    );
}
