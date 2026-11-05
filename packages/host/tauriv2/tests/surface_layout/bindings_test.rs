use super::command_names;

// contract: surface-layout.keyboard-follows-the-focus-ring
#[test]
fn the_page_can_move_the_keyboard_through_a_registered_command() {
    assert!(command_names().contains(&"surface_focus"));
}

// contract: surface-layout.page-cancels-preparation
#[test]
fn the_page_can_cancel_a_preparation_through_a_registered_command() {
    assert!(command_names().contains(&"cancel_surfaces"));
}
