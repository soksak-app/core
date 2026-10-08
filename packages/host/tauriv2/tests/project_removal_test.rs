//! A removal request for a project resolves with the answer of the window that shows it
//! (docs/spec/projects.md).

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
