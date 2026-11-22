//! The theme script of a view (docs/spec/native-surfaces.md#view-surfaces): the document-start script sets window.sokTheme to the
//! frozen theme value that the host holds at the creation of the view. The same cases run in the Go host.

use serde_json::json;

use super::theme_script;

// contract: view.theme.first-script
#[test]
fn the_theme_script_freezes_the_theme_value_for_the_first_page_script() {
    let theme = json!({"scheme": "dark", "tokens": {"surface": "#101010"}});
    assert_eq!(
        theme_script(&theme),
        r##"window.sokTheme = Object.freeze({"scheme":"dark","tokens":{"surface":"#101010"}});"##,
        "the script sets the frozen theme value"
    );
}

// contract: view.theme.deferred-is-recorded
// A theme change that finds a view without a ready document is not posted to it, because its ready message receives the current
// theme, and the host records the skip with the surface and that reason.
#[test]
fn a_theme_change_before_the_view_is_ready_is_recorded_with_its_reason() {
    super::record_theme_deferred("theme-deferred-probe");
    let stored: Vec<serde_json::Value> =
        crate::event_record::buffered_fields("host.view.theme.deferred")
            .into_iter()
            .filter(|fields| fields["surface"] == "theme-deferred-probe")
            .collect();
    assert_eq!(
        stored,
        vec![json!({"surface": "theme-deferred-probe", "reason": super::THEME_DEFERRED_REASON})]
    );
}
