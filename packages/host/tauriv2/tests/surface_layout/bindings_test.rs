use super::command_names;

// contract: surface-layout.page-cancels-preparation
#[test]
fn the_page_can_cancel_a_preparation_through_a_registered_command() {
    assert!(command_names().contains(&"cancel_surfaces"));
}
