//! A removal request for a project resolves with the answer of the window that shows it
//! (docs/spec/projects.md).

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::project_removal::Removals;

// contract: project-removal.ask.waits-for-the-owner-answer
#[test]
fn a_project_removal_request_resolves_with_the_owner_answer() {
    let removals = Removals::default();
    let asked = removals.begin("prj-one", "project-one").unwrap();
    let error = removals.begin("prj-one", "project-one").unwrap_err();
    assert!(error.contains("prj-one"), "{error}");
    removals.answer("prj-one", false).unwrap();
    assert!(
        !asked.recv().unwrap(),
        "a kept tab answered that the removal is allowed"
    );
    assert!(
        removals.answer("prj-one", true).is_err(),
        "an answer without a request was accepted"
    );
    for id in ["", "Bad Id"] {
        assert!(
            removals.begin(id, "project-one").is_err(),
            "project id {id:?} was accepted"
        );
    }
    // A window that ends while it is asked answers that the removal is allowed.
    let asked = removals.begin("prj-two", "project-two").unwrap();
    removals.abandon("project-other");
    assert!(
        asked.try_recv().is_err(),
        "the end of another window answered the request"
    );
    removals.abandon("project-two");
    assert!(
        asked.recv().unwrap(),
        "the end of the asked window did not allow the removal"
    );
}

// contract: project-removal.abandon.records-each-allowed-removal
#[test]
fn the_end_of_a_window_records_each_removal_it_allows() {
    // The writer of the records belongs to the process, so the scenario runs in a child process.
    if let Some(config) = std::env::var_os("SOKSAK_REMOVAL_CHILD") {
        let config = std::path::PathBuf::from(config);
        let writer = records::start_writer(&config);
        let removals = Removals::default();
        let _asked: Vec<_> = [
            ("prj-a", "project-one"),
            ("prj-b", "project-one"),
            ("prj-c", "project-two"),
        ]
        .iter()
        .map(|(id, owner)| removals.begin(id, owner).unwrap())
        .collect();
        removals.abandon("project-one");
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_end_of_a_window_records_each_removal_it_allows",
            "--nocapture",
        ])
        .env("SOKSAK_REMOVAL_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut allowed: Vec<String> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.project.removal_allowed")
        .map(|event| {
            assert_eq!(event["fields"]["window"], "project-one");
            event["fields"]["project"].as_str().unwrap().to_string()
        })
        .collect();
    allowed.sort();
    assert_eq!(allowed, ["prj-a", "prj-b"]);
}
