//! The save place of a new document (docs/spec/plugins.md#pluginjson): the chosen file is answered relative to the project
//! root, and a place outside the root or a name that is not a file name is refused. The same cases run in the Go host.

#[path = "support/folder.rs"]
mod folder;

use std::path::Path;

use soksak_host_tauriv2::file_place::{check_name, relative};

// contract: files.place.answers-the-path-inside-the-project
#[test]
fn a_place_inside_the_project_is_answered_relative_to_the_root() {
    let base = folder::Folder::new();
    let root = base.path().join("project");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    let link = base.path().join("link");
    std::os::unix::fs::symlink(&root, &link).unwrap();
    let cases: [(&Path, std::path::PathBuf, &str); 4] = [
        (&root, root.join("plan.hwp"), "plan.hwp"),
        (&root, root.join("docs").join("plan.hwp"), "docs/plan.hwp"),
        (&link, root.join("docs").join("plan.hwp"), "docs/plan.hwp"),
        (&root, link.join("docs").join("plan.hwp"), "docs/plan.hwp"),
    ];
    for (root, chosen, want) in cases {
        assert_eq!(
            relative(root, &chosen).as_deref(),
            Ok(want),
            "relative({root:?}, {chosen:?})"
        );
    }
}

// contract: files.place.refuses-a-place-outside-the-project
#[test]
fn a_place_outside_the_project_is_refused() {
    let base = folder::Folder::new();
    let root = base.path().join("project");
    let other = base.path().join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let escape = root.join("escape");
    std::os::unix::fs::symlink(&other, &escape).unwrap();
    for chosen in [
        other.join("plan.hwp"),
        root.clone(),
        root.join("..").join("other").join("plan.hwp"),
        escape.join("plan.hwp"),
    ] {
        let want = format!(
            "file place: {} is outside the project {}",
            chosen.display(),
            root.display()
        );
        assert_eq!(
            relative(&root, &chosen),
            Err(want),
            "relative({root:?}, {chosen:?})"
        );
    }
}

// contract: files.place.refuses-a-name-that-is-not-a-file-name
#[test]
fn a_place_name_that_is_not_a_file_name_is_refused() {
    for name in ["", ".", "..", "a/b", "a\\b"] {
        assert_eq!(
            check_name(name),
            Err(format!("file place: name {name} is not a file name"))
        );
    }
    assert_eq!(check_name("plan.hwp"), Ok(()));
}
