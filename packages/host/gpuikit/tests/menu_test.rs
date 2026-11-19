//! Tests of the shortcut conversion of the application menu of GPUI.

use soksak_host_gpuikit::key_equivalent;

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
