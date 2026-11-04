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
