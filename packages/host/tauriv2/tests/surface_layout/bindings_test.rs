use super::command_names;

// contract: surface-layout.keyboard-follows-the-focus-ring
#[test]
fn the_page_can_move_the_keyboard_through_a_registered_command() {
    assert!(command_names().contains(&"surface_focus"));
}

// contract: surface-layout.keyboard-waits-for-the-decision
#[test]
fn the_page_can_hold_and_end_the_hold_of_the_input_through_registered_commands() {
    assert!(command_names().contains(&"keyboard_hold"));
    assert!(command_names().contains(&"keyboard_decided"));
}

// contract: surface-layout.page-cancels-preparation
#[test]
fn the_page_can_cancel_a_preparation_through_a_registered_command() {
    assert!(command_names().contains(&"cancel_surfaces"));
}
