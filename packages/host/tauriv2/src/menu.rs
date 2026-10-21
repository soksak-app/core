//! The application menu.
//!
//! The "Application menu" table of docs/spec/host-contract.md is the contract of the menu. [`MENUS`] and [`ITEMS`] are
//! that table, and [`build`] builds the menu in a language of the table. An item whose source is "title" uses the title
//! of the table, and an item whose source is "system" keeps the title and shortcut that the framework provides.
//! scripts/check-host-parity.mjs checks mechanically that both hosts carry the same table.

use std::sync::PoisonError;

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

/// The contract table of the top-level menus. (id, ko, en). The title of app is the application name, so it is left
/// empty.
pub const MENUS: &[(&str, &str, &str)] = &[
    ("app", "", ""),
    ("file", "파일", "File"),
    ("edit", "편집", "Edit"),
    ("view", "보기", "View"),
    ("window", "윈도우", "Window"),
    ("help", "도움말", "Help"),
];

/// The contract table of the menu items. (menu, id, source, ko, en, key). An item whose source is "system" keeps the
/// framework title, and an item whose source is "title" uses the title of the table. Each row must be one line so that
/// scripts/check-host-parity.mjs can read the rows, so this table is excluded from alignment.
#[rustfmt::skip]
pub const ITEMS: &[(&str, &str, &str, &str, &str, &str)] = &[
    ("app", "about", "title", "정보", "About", ""),
    ("app", "services", "system", "", "", ""),
    ("app", "hide", "title", "가리기", "Hide", "cmd+h"),
    ("app", "hide-others", "title", "기타 가리기", "Hide Others", "opt+cmd+h"),
    ("app", "show-all", "title", "모두 보이기", "Show All", ""),
    ("app", "quit", "title", "종료", "Quit", "cmd+q"),
    ("file", "close-window", "title", "윈도우 닫기", "Close Window", "cmd+w"),
    ("file", "close-all", "system", "", "", ""),
    ("edit", "undo", "title", "실행 취소", "Undo", "cmd+z"),
    ("edit", "redo", "title", "다시 실행", "Redo", "shift+cmd+z"),
    ("edit", "cut", "title", "잘라내기", "Cut", "cmd+x"),
    ("edit", "copy", "title", "복사", "Copy", "cmd+c"),
    ("edit", "paste", "title", "붙여넣기", "Paste", "cmd+v"),
    ("edit", "select-all", "title", "모두 선택", "Select All", "cmd+a"),
    ("view", "text-larger", "title", "글자 크게", "Bigger Text", "cmd+="),
    ("view", "text-smaller", "title", "글자 작게", "Smaller Text", "cmd+-"),
    ("view", "text-default", "title", "글자 기본 크기", "Default Text Size", "cmd+0"),
    ("view", "fullscreen", "system", "", "", ""),
    ("window", "new-window", "title", "새 창", "New Window", "shift+cmd+n"),
    ("window", "bring-all-to-front", "system", "", "", ""),
    ("help", "debug", "title", "디버그", "Debug", ""),
];

/// The languages of the table and their title columns. When a language column is added to the contract table, this
/// table grows with it.
const LANGUAGES: &[(&str, usize)] = &[("ko", 1), ("en", 2)];

/// The default language. The initial menu uses it when the system language is not a language of the table.
const DEFAULT_LANGUAGE: &str = "en";

/// The menu, table id and menu item id of the items that run a page command. The menu item id is the name of the
/// command that the main page runs.
const PAGE_COMMANDS: &[(&str, &str, &str)] = &[
    ("view", "text-larger", "core.text.larger"),
    ("view", "text-smaller", "core.text.smaller"),
    ("view", "text-default", "core.text.reset"),
    ("help", "debug", "core.debug.open"),
];

/// The current menu language. Before the page sends the setting language, it is the initial value decided from the
/// system language. [`set_language`] uses this value to decide that the menu is not rebuilt.
pub struct MenuLanguage(pub std::sync::Mutex<String>);

/// Returns the position of the title column of a language tag in the table. It is an explicit error when the language
/// is not in the table.
pub fn language_column(language: &str) -> Result<usize, String> {
    LANGUAGES
        .iter()
        .find(|(tag, _)| *tag == language)
        .map(|(_, column)| *column)
        .ok_or_else(|| format!("the menu table has no language {language:?}"))
}

/// The titles of the top-level menus by language. The title of the app menu is the application name, so the table
/// leaves it empty.
pub fn menu_title(id: &str, language: &str) -> Result<String, String> {
    let column = language_column(language)?;
    MENUS
        .iter()
        .find(|(menu, _, _)| *menu == id)
        .ok_or_else(|| format!("the menu table has no menu {id:?}"))
        .and_then(|(_, ko, en)| column_title(&[ko, en], column))
}

/// The titles by language of the item (menu, id) in the contract table.
pub fn item_title(menu: &str, id: &str, language: &str) -> Result<String, String> {
    let column = language_column(language)?;
    item_row(menu, id).and_then(|row| column_title(&[row.3, row.4], column))
}

/// Converts the key format of the contract table (the host.menu report format) into the shortcut format of the menu
/// library. The modifier keys are joined with + in the order cmd, shift, ctrl, opt, and the last cell is the key.
pub fn accelerator(key: &str) -> Result<String, String> {
    let parts: Vec<&str> = key.split('+').collect();
    let Some((last, modifiers)) = parts.split_last() else {
        return Err(format!("menu key {key:?} has no key"));
    };
    if last.is_empty() {
        return Err(format!("menu key {key:?} has no key"));
    }
    let mut out: Vec<&str> = Vec::new();
    for modifier in modifiers {
        out.push(match *modifier {
            "cmd" => "CmdOrCtrl",
            "shift" => "Shift",
            "ctrl" => "Control",
            "opt" => "Option",
            unknown => return Err(format!("menu key {key:?} has unknown modifier {unknown:?}")),
        });
    }
    out.push(last);
    Ok(out.join("+"))
}

/// The page command that the item of table id runs, or `None` when the item runs none.
pub fn page_command(id: &str) -> Option<&'static str> {
    PAGE_COMMANDS
        .iter()
        .find(|(_, row, _)| *row == id)
        .map(|(_, _, command)| *command)
}

/// Whether the menu item id is a page command. The menu event wiring uses it.
pub fn runs_page_command(id: &str) -> bool {
    PAGE_COMMANDS.iter().any(|(_, _, command)| *command == id)
}

/// The initial menu language before the page sends the setting language. The main tag of the system preferred language
/// is looked up in the languages of the table, and the default language is used when the table does not have it
/// (Application menu in docs/spec/host-contract.md). The platform layer provides the system language lookup, and it is
/// an error when the system language cannot be read.
pub fn initial_language() -> Result<String, String> {
    let tag = crate::platform::current()?.preferred_language()?;
    if LANGUAGES.iter().any(|(tag_name, _)| *tag_name == tag) {
        Ok(tag)
    } else {
        Ok(DEFAULT_LANGUAGE.to_string())
    }
}

/// Changes the menu language. It is an explicit error when the language is not in the table, and the menu is not
/// rebuilt when the language is the same. [`MenuLanguage`] is registered as managed state by setup.
pub fn set_language(app: &AppHandle, language: &str) -> Result<(), String> {
    language_column(language)?;
    let state = app.state::<MenuLanguage>();
    // default: a lock that a panicking thread poisoned still holds the language of the menu, which is compared and then
    // replaced; the panic hook records the panic.
    let mut current = state.0.lock().unwrap_or_else(PoisonError::into_inner);
    if *current == language {
        return Ok(());
    }
    let menu = build(app, language)?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    *current = language.to_string();
    Ok(())
}

/// Builds the application menu from the contract table. language is a language of the table. The order of the top-level
/// menus follows [`MENUS`], and the title of the app menu (the first submenu) is the application name.
pub fn build(app: &AppHandle, language: &str) -> Result<Menu<Wry>, String> {
    language_column(language)?;
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for id in MENUS.iter().map(|(menu, _, _)| *menu) {
        let submenu = match id {
            "app" => app_submenu(app, language),
            "file" => file_submenu(app, language),
            "edit" => edit_submenu(app, language),
            "view" => view_submenu(app, language),
            "window" => window_submenu(app, language),
            "help" => help_submenu(app, language),
            unknown => return Err(format!("the menu table has unknown menu {unknown:?}")),
        }?;
        menu.append(&submenu).map_err(|error| error.to_string())?;
    }
    Ok(menu)
}

/// Builds the app menu. about, hide and quit take the form "application name title", and the title comes from the
/// contract table.
fn app_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let package = app.package_info();
    let bundle = &app.config().bundle;
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: bundle.copyright.clone(),
        authors: bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let about_title = format!("{} {}", package.name, item_title("app", "about", language)?);
    let about_item =
        PredefinedMenuItem::about(app, Some(&about_title), Some(about)).map_err(string)?;
    let after_about = separator(app)?;
    let services_item = PredefinedMenuItem::services(app, None).map_err(string)?;
    let after_services = separator(app)?;
    let hide_title = format!("{} {}", package.name, item_title("app", "hide", language)?);
    let hide_item = PredefinedMenuItem::hide(app, Some(&hide_title)).map_err(string)?;
    let hide_others_item =
        PredefinedMenuItem::hide_others(app, Some(&item_title("app", "hide-others", language)?))
            .map_err(string)?;
    let show_all_item =
        PredefinedMenuItem::show_all(app, Some(&item_title("app", "show-all", language)?))
            .map_err(string)?;
    let after_show_all = separator(app)?;
    let quit_title = format!("{} {}", package.name, item_title("app", "quit", language)?);
    let quit_item = PredefinedMenuItem::quit(app, Some(&quit_title)).map_err(string)?;
    Submenu::with_id_and_items(
        app,
        "app",
        package.name.clone(),
        true,
        &[
            &about_item,
            &after_about,
            &services_item,
            &after_services,
            &hide_item,
            &hide_others_item,
            &show_all_item,
            &after_show_all,
            &quit_item,
        ],
    )
    .map_err(string)
}

/// Builds the file menu. The title of close window comes from the table. close-all is not built. Measurement shows that
/// when the application finishes starting (NSApp finishLaunching), the system adds a "Close All" alternate item
/// (isAlternate) next to the performClose: item of close-window by itself, so the contract table has it but there is no
/// item to build here.
fn file_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let close_window =
        PredefinedMenuItem::close_window(app, Some(&item_title("file", "close-window", language)?))
            .map_err(string)?;
    Submenu::with_id_and_items(
        app,
        "file",
        menu_title("file", language)?,
        true,
        &[&close_window],
    )
    .map_err(string)
}

/// Builds the edit menu. The item titles come from the table and the framework provides the shortcuts.
fn edit_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let undo = PredefinedMenuItem::undo(app, Some(&item_title("edit", "undo", language)?))
        .map_err(string)?;
    let redo = PredefinedMenuItem::redo(app, Some(&item_title("edit", "redo", language)?))
        .map_err(string)?;
    let after_redo = separator(app)?;
    let cut = PredefinedMenuItem::cut(app, Some(&item_title("edit", "cut", language)?))
        .map_err(string)?;
    let copy = PredefinedMenuItem::copy(app, Some(&item_title("edit", "copy", language)?))
        .map_err(string)?;
    let paste = PredefinedMenuItem::paste(app, Some(&item_title("edit", "paste", language)?))
        .map_err(string)?;
    let select_all =
        PredefinedMenuItem::select_all(app, Some(&item_title("edit", "select-all", language)?))
            .map_err(string)?;
    Submenu::with_id_and_items(
        app,
        "edit",
        menu_title("edit", language)?,
        true,
        &[&undo, &redo, &after_redo, &cut, &copy, &paste, &select_all],
    )
    .map_err(string)
}

/// Builds the view menu. The titles of the full screen and text size items come from the table. The menu item id of a
/// text size item is the command name sent to the page (docs/spec/text-size.md).
fn view_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let mut text_items = Vec::new();
    for (_, row, command) in PAGE_COMMANDS.iter().filter(|(menu, ..)| *menu == "view") {
        let item = MenuItem::with_id(
            app,
            *command,
            item_title("view", row, language)?,
            true,
            Some(accelerator(item_key("view", row)?)?),
        )
        .map_err(string)?;
        text_items.push(item);
    }
    // The full screen item uses the title and shortcut that the framework provides. The system does not add its own
    // item to the view menu of these applications when the menu is opened (measured, V5-112), so the system row of the
    // contract table is built here.
    let fullscreen = PredefinedMenuItem::fullscreen(app, None).map_err(string)?;
    let items: Vec<&dyn IsMenuItem<Wry>> = text_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<Wry>)
        .chain(std::iter::once(&fullscreen as &dyn IsMenuItem<Wry>))
        .collect();
    Submenu::with_id_and_items(app, "view", menu_title("view", language)?, true, &items)
        .map_err(string)
}

/// Builds the Help menu: the debug item runs its page command.
fn help_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let debug = MenuItem::with_id(
        app,
        "core.debug.open",
        item_title("help", "debug", language)?,
        true,
        None::<&str>,
    )
    .map_err(string)?;
    Submenu::with_id_and_items(app, "help", menu_title("help", language)?, true, &[&debug])
        .map_err(string)
}

/// Builds the window menu. The title and shortcut of the new window come from the table.
fn window_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let new_window = MenuItem::with_id(
        app,
        "new-window",
        item_title("window", "new-window", language)?,
        true,
        Some(accelerator(item_key("window", "new-window")?)?),
    )
    .map_err(string)?;
    let bring_all_to_front = PredefinedMenuItem::bring_all_to_front(app, None).map_err(string)?;
    Submenu::with_id_and_items(
        app,
        "window",
        menu_title("window", language)?,
        true,
        &[&new_window, &bring_all_to_front],
    )
    .map_err(string)
}

/// Builds a separator item. The report leaves out separator items and covers only the order of the items.
fn separator(app: &AppHandle) -> Result<PredefinedMenuItem<Wry>, String> {
    PredefinedMenuItem::separator(app).map_err(string)
}

/// Converts a tauri error into a string error.
fn string(error: tauri::Error) -> String {
    error.to_string()
}

/// Finds the row of the item (menu, id) in the contract table.
fn item_row(
    menu: &str,
    id: &str,
) -> Result<
    (
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        &'static str,
    ),
    String,
> {
    let row = ITEMS
        .iter()
        .find(|(row_menu, row_id, ..)| *row_menu == menu && *row_id == id)
        .ok_or_else(|| format!("the menu table has no {menu:?} item {id:?}"))?;
    Ok((row.0, row.1, row.2, row.3, row.4, row.5))
}

/// The key-format shortcut of the item (menu, id) in the contract table.
fn item_key(menu: &str, id: &str) -> Result<&'static str, String> {
    item_row(menu, id).map(|row| row.5)
}

/// Chooses the value of the language column among the title columns of the table.
fn column_title(cells: &[&'static str], column: usize) -> Result<String, String> {
    cells
        .get(column - 1)
        .map(|title| title.to_string())
        .ok_or_else(|| format!("language column {column} is not in the menu table"))
}
