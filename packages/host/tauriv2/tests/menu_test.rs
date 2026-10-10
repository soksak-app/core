//! Tests of the contract table of the application menu.
//!
//! The menu builder decides the titles and the order from the "Application menu" table of docs/spec/host-contract.md.
//! Here the titles by language, the order and the shortcut format of the table are checked. The window check layer
//! compares the built menu bar itself with host.menu.

use soksak_host_tauriv2::menu;

/// The list of the titles of the top-level menus by language.
fn menu_titles(language: &str) -> Vec<String> {
    menu::MENUS
        .iter()
        .map(|(id, _, _)| menu::menu_title(id, language).unwrap())
        .collect()
}

/// The titles, in table order, of the menu items whose title is in the table (source "title").
fn titled_item_titles(menu_id: &str, language: &str) -> Vec<String> {
    menu::ITEMS
        .iter()
        .filter(|(row, _, source, ..)| *row == menu_id && *source == "title")
        .map(|(_, id, _, _, _, _)| menu::item_title(menu_id, id, language).unwrap())
        .collect()
}

// The table rows that the system places by itself when the application finishes starting. The builder does not build them.
// close-all is provided by the system. The system does not provide fullscreen (measured, V5-112), so the
// builder builds it.
const OS_INSERTED: [&str; 1] = ["close-all"];

/// Returns the item ids of a menu in table order.
fn item_ids(menu_id: &str) -> Vec<&'static str> {
    menu::ITEMS
        .iter()
        .filter(|(row, id, ..)| *row == menu_id && !OS_INSERTED.contains(id))
        .map(|(_, id, ..)| *id)
        .collect()
}

// contract: menu.application.view-has-full-screen-and-text-size
#[test]
fn view_menu_has_full_screen_and_text_size() {
    // The builder items of the view menu are the three text sizes and full screen. The system does not provide full
    // screen (measured), so the builder builds it (V5-112).
    assert_eq!(
        item_ids("view"),
        ["text-larger", "text-smaller", "text-default", "fullscreen"]
    );
    // A text size item uses the page command id as the menu item id.
    assert!(menu::runs_page_command("core.text.larger"));
    assert!(menu::runs_page_command("core.text.smaller"));
    assert!(menu::runs_page_command("core.text.reset"));
    assert!(!menu::runs_page_command("new-window"));
    // The shortcuts are converted from the key format of the contract table to the format of the menu library. The text
    // sizes are =, - and 0.
    assert_eq!(menu::accelerator("cmd+=").unwrap(), "CmdOrCtrl+=");
    assert_eq!(menu::accelerator("cmd+-").unwrap(), "CmdOrCtrl+-");
    assert_eq!(menu::accelerator("cmd+0").unwrap(), "CmdOrCtrl+0");
    assert_eq!(
        menu::accelerator("shift+cmd+n").unwrap(),
        "Shift+CmdOrCtrl+n"
    );
    assert_eq!(
        menu::accelerator("ctrl+cmd+f").unwrap(),
        "Control+CmdOrCtrl+f"
    );
    assert_eq!(
        menu::accelerator("opt+cmd+w").unwrap(),
        "Option+CmdOrCtrl+w"
    );
    // close-all is provided by the system, so the key cell of the table is empty.
    assert!(menu::accelerator("cmd+").is_err());
    assert!(menu::accelerator("meta+w").is_err());
}

// contract: menu.application.view-has-full-screen-and-text-size
#[test]
fn table_titles_serve_both_languages() {
    // The title of the app menu is the application name, so the table leaves it empty.
    assert_eq!(
        menu_titles("ko"),
        ["", "파일", "편집", "보기", "윈도우", "도움말"]
    );
    assert_eq!(
        menu_titles("en"),
        ["", "File", "Edit", "View", "Window", "Help"]
    );
    // The item titles and the order also follow the table. For the file, edit and view menus, all items that have a
    // title are compared.
    assert_eq!(titled_item_titles("file", "ko"), ["윈도우 닫기"]);
    assert_eq!(titled_item_titles("file", "en"), ["Close Window"]);
    assert_eq!(
        titled_item_titles("edit", "ko"),
        [
            "실행 취소",
            "다시 실행",
            "잘라내기",
            "복사",
            "붙여넣기",
            "모두 선택"
        ]
    );
    assert_eq!(
        titled_item_titles("view", "ko"),
        ["글자 크게", "글자 작게", "글자 기본 크기"]
    );
    assert_eq!(
        titled_item_titles("edit", "en"),
        ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]
    );
    assert_eq!(
        titled_item_titles("view", "en"),
        ["Bigger Text", "Smaller Text", "Default Text Size"]
    );
    assert_eq!(titled_item_titles("window", "ko"), ["새 창"]);
    // The placement order of the items is the table order. The app menu is the order in which show_all was added to the
    // predefined items of the default tauri menu.
    assert_eq!(
        item_ids("app"),
        [
            "about",
            "services",
            "hide",
            "hide-others",
            "show-all",
            "quit"
        ]
    );
    assert_eq!(item_ids("file"), ["close-window"]);
    assert_eq!(
        item_ids("view"),
        ["text-larger", "text-smaller", "text-default", "fullscreen"]
    );
    assert_eq!(item_ids("window"), ["new-window", "bring-all-to-front"]);
    assert_eq!(item_ids("help"), ["debug"]);
    // A language that is not in the contract table cannot build a menu.
    let error = menu::menu_title("file", "fr").unwrap_err();
    assert!(error.contains("fr"), "{error}");
    assert!(menu::item_title("edit", "undo", "ja").is_err());
    assert!(menu::language_column("korean").is_err());
}

// contract: menu.application.help-has-debug
#[test]
fn help_menu_has_debug() {
    assert_eq!(item_ids("help"), ["debug"]);
    assert_eq!(titled_item_titles("help", "ko"), ["디버그"]);
    assert_eq!(titled_item_titles("help", "en"), ["Debug"]);
    assert_eq!(menu::page_command("debug"), Some("core.debug.open"));
    assert_eq!(menu::page_command("text-larger"), Some("core.text.larger"));
    assert_eq!(menu::page_command("new-window"), None);
}
