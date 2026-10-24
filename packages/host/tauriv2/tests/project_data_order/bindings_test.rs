use super::*;

// contract: projects.shown-command-is-registered
#[test]
fn the_page_can_commit_its_selected_project() {
    assert!(command_names().contains(&"project_shown"));
}
