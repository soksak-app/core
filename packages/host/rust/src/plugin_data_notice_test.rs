//! The notices of the stored entries of the plugin keys (docs/spec/plugins.md#plugin-data).

use serde_json::json;

use crate::workspace::notifies_windows;

// The host answers each stored entry of a plugin key with workspace-changed to every window, and a replace that stored nothing notifies
// no window (docs/spec/plugins.md#plugin-data).
// contract: workspace.plugin-data.notifies-stored-entries
#[test]
fn a_stored_plugin_entry_notifies_every_window_and_a_refused_replace_none() {
    assert!(notifies_windows("pluginData", &json!(true)));
    assert!(!notifies_windows("pluginData", &json!(false)));
    assert!(notifies_windows("patch", &json!(true)));
    assert!(!notifies_windows("snapshot", &json!({})));
}
