//! The undo and redo items of the application menu are system items of the contract table: AppKit sets the title of an
//! item with the undo: or redo: action from the undo manager when it validates the menu, so the host gives them no
//! title and the framework provides it (docs/spec/host-contract.md#application-menu).

use soksak_host::menu::{MenuItem, build};

#[test]
fn undo_and_redo_keep_the_framework_title() {
    for language in ["ko", "en"] {
        let menus = build(language).expect("the menu is built");
        let mut found = Vec::new();
        for menu in &menus {
            for item in &menu.items {
                if let MenuItem::Predefined { role, title, .. } = item
                    && (*role == "undo" || *role == "redo")
                {
                    found.push(*role);
                    assert_eq!(
                        title.as_deref(),
                        None,
                        "the {language} item {role} has a title instead of that of the framework"
                    );
                }
            }
        }
        assert_eq!(
            found,
            ["undo", "redo"],
            "the {language} menu lacks an undo or redo item"
        );
    }
}
