//! Tests of the application menu of GPUI: the shortcut conversion and the rows of the contract table that the menu of the
//! language host library gives the adapter, as packages/host/tauriv2/tests/menu_test.rs checks them for Tauri.

use soksak_host::menu;
use soksak_host_gpuikit::key_equivalent;

/// The item ids of a menu in table order, without close-all, which the system places itself.
fn item_ids(menu_id: &str) -> Vec<&'static str> {
    menu::ITEMS
        .iter()
        .filter(|(row, id, ..)| *row == menu_id && *id != "close-all")
        .map(|(_, id, ..)| *id)
        .collect()
}

/// The titles, in table order, of the items of a menu whose title is in the table.
fn titled_item_titles(menu_id: &str, language: &str) -> Vec<String> {
    menu::ITEMS
        .iter()
        .filter(|(row, _, source, ..)| *row == menu_id && *source == "title")
        .map(|(_, id, ..)| menu::item_title(menu_id, id, language).unwrap())
        .collect()
}

// contract: menu.application.help-has-debug
#[test]
fn help_menu_has_debug() {
    assert_eq!(item_ids("help"), ["debug"]);
    assert_eq!(titled_item_titles("help", "ko"), ["디버그"]);
    assert_eq!(titled_item_titles("help", "en"), ["Debug"]);
    assert_eq!(menu::page_command("debug"), Some("core.debug.open"));
}

// contract: menu.application.app-has-settings
#[test]
fn app_menu_has_settings() {
    assert_eq!(item_ids("app")[1], "settings");
    assert_eq!(menu::item_title("app", "settings", "ko").unwrap(), "설정…");
    assert_eq!(
        menu::item_title("app", "settings", "en").unwrap(),
        "Settings…"
    );
    assert_eq!(menu::page_command("settings"), Some("core.settings.open"));
    // The shortcut of settings becomes the key equivalent `,` with the command modifier of the AppKit item.
    let (key, modifiers) = key_equivalent("cmd+,").unwrap();
    assert_eq!(key, ",");
    assert_eq!(modifiers, objc2_app_kit::NSEventModifierFlags::Command);
}

// contract: menu.application.view-has-full-screen-and-text-size
#[test]
fn view_menu_shortcuts_convert_to_appkit() {
    // The shortcuts are converted from the key format of the contract table to the key equivalent and the modifier
    // mask of AppKit. The text sizes are =, - and 0.
    assert_eq!(key_equivalent("cmd+=").unwrap().0, "=");
    assert_eq!(key_equivalent("cmd+-").unwrap().0, "-");
    assert_eq!(key_equivalent("cmd+0").unwrap().0, "0");
    assert_eq!(key_equivalent("shift+cmd+n").unwrap().0, "n");
    assert!(
        key_equivalent("cmd+=")
            .unwrap()
            .1
            .contains(objc2_app_kit::NSEventModifierFlags::Command)
    );
    assert!(key_equivalent("shift+cmd+n").unwrap().1.contains(
        objc2_app_kit::NSEventModifierFlags::Command | objc2_app_kit::NSEventModifierFlags::Shift
    ));
    assert!(key_equivalent("ctrl+cmd+f").unwrap().1.contains(
        objc2_app_kit::NSEventModifierFlags::Command | objc2_app_kit::NSEventModifierFlags::Control
    ));
    assert!(key_equivalent("opt+cmd+w").unwrap().1.contains(
        objc2_app_kit::NSEventModifierFlags::Command | objc2_app_kit::NSEventModifierFlags::Option
    ));
    // A key cell without a key and an unknown modifier are refused.
    assert!(key_equivalent("cmd+").is_err());
    assert!(key_equivalent("meta+w").is_err());
}
