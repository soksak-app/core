use super::command_names;

#[test]
fn the_main_page_ordered_source_event_channel_is_a_registered_command() {
    assert!(
        command_names().contains(&"declared_source_event_stream"),
        "the main page ordered source event channel command is not registered"
    );
}
