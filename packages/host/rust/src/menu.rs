//! The application menu.
//!
//! The "Application menu" table of docs/spec/host-contract.md is the contract of the menu. [`MENUS`] and [`ITEMS`] are
//! that table, and [`build`] builds the menu in a language of the table, which the framework installs. An item whose source is "title" uses the title
//! of the table, and an item whose source is "system" keeps the title and shortcut that the framework provides.
//! scripts/check-host-parity.mjs checks mechanically that both hosts carry the same table.

use std::sync::PoisonError;

use crate::framework::{AppHandle, Manager};

/// One top-level menu of the application menu, with the id of the contract table. A menu without a title takes the
/// application name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Menu {
    pub id: &'static str,
    pub title: Option<String>,
    pub items: Vec<MenuItem>,
}

/// One item of a menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuItem {
    /// An item that the framework provides for the role, an item id of the contract table. An item without a title keeps
    /// the title of the framework; with_app_name puts the application name before the title.
    Predefined {
        role: &'static str,
        title: Option<String>,
        with_app_name: bool,
    },
    /// An item that runs the menu event of id, with the shortcut in the format of [`accelerator`].
    Command {
        id: &'static str,
        title: String,
        accelerator: Option<String>,
    },
    Separator,
}

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
    let menu = build(language)?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    *current = language.to_string();
    Ok(())
}

/// Builds the application menu from the contract table. language is a language of the table. The order of the top-level
/// menus follows [`MENUS`], and the title of the app menu (the first submenu) is the application name.
pub fn build(language: &str) -> Result<Vec<Menu>, String> {
    language_column(language)?;
    let mut menus = Vec::new();
    for id in MENUS.iter().map(|(menu, _, _)| *menu) {
        let submenu = match id {
            "app" => app_submenu(language),
            "file" => file_submenu(language),
            "edit" => edit_submenu(language),
            "view" => view_submenu(language),
            "window" => window_submenu(language),
            "help" => help_submenu(language),
            unknown => return Err(format!("the menu table has unknown menu {unknown:?}")),
        }?;
        menus.push(submenu);
    }
    Ok(menus)
}

/// A predefined item with the title of the contract table.
fn titled(role: &'static str, title: String) -> MenuItem {
    MenuItem::Predefined {
        role,
        title: Some(title),
        with_app_name: false,
    }
}

/// A predefined item that keeps the title of the framework.
fn system(role: &'static str) -> MenuItem {
    MenuItem::Predefined {
        role,
        title: None,
        with_app_name: false,
    }
}

/// Builds the app menu. about, hide and quit take the form "application name title", and the title comes from the
/// contract table.
fn app_submenu(language: &str) -> Result<Menu, String> {
    let named = |role: &'static str| -> Result<MenuItem, String> {
        Ok(MenuItem::Predefined {
            role,
            title: Some(item_title("app", role, language)?),
            with_app_name: true,
        })
    };
    Ok(Menu {
        id: "app",
        title: None,
        items: vec![
            named("about")?,
            MenuItem::Separator,
            system("services"),
            MenuItem::Separator,
            named("hide")?,
            titled("hide-others", item_title("app", "hide-others", language)?),
            titled("show-all", item_title("app", "show-all", language)?),
            MenuItem::Separator,
            named("quit")?,
        ],
    })
}

/// Builds the file menu. The title of close window comes from the table. close-all is not built. Measurement shows that
/// when the application finishes starting (NSApp finishLaunching), the system adds a "Close All" alternate item
/// (isAlternate) next to the performClose: item of close-window by itself, so the contract table has it but there is no
/// item to build here.
fn file_submenu(language: &str) -> Result<Menu, String> {
    Ok(Menu {
        id: "file",
        title: Some(menu_title("file", language)?),
        items: vec![titled(
            "close-window",
            item_title("file", "close-window", language)?,
        )],
    })
}

/// Builds the edit menu. The item titles come from the table and the framework provides the shortcuts.
fn edit_submenu(language: &str) -> Result<Menu, String> {
    let item = |id: &'static str| -> Result<MenuItem, String> {
        Ok(titled(id, item_title("edit", id, language)?))
    };
    Ok(Menu {
        id: "edit",
        title: Some(menu_title("edit", language)?),
        items: vec![
            item("undo")?,
            item("redo")?,
            MenuItem::Separator,
            item("cut")?,
            item("copy")?,
            item("paste")?,
            item("select-all")?,
        ],
    })
}

/// Builds the view menu. The titles of the full screen and text size items come from the table. The menu item id of a
/// text size item is the command name sent to the page (docs/spec/text-size.md).
fn view_submenu(language: &str) -> Result<Menu, String> {
    let mut items = Vec::new();
    for (_, row, command) in PAGE_COMMANDS.iter().filter(|(menu, ..)| *menu == "view") {
        items.push(MenuItem::Command {
            id: command,
            title: item_title("view", row, language)?,
            accelerator: Some(accelerator(item_key("view", row)?)?),
        });
    }
    // The full screen item uses the title and shortcut that the framework provides. The system does not add its own
    // item to the view menu of these applications when the menu is opened (measured, V5-112), so the system row of the
    // contract table is built here.
    items.push(system("fullscreen"));
    Ok(Menu {
        id: "view",
        title: Some(menu_title("view", language)?),
        items,
    })
}

/// Builds the Help menu: the debug item runs its page command.
fn help_submenu(language: &str) -> Result<Menu, String> {
    Ok(Menu {
        id: "help",
        title: Some(menu_title("help", language)?),
        items: vec![MenuItem::Command {
            id: "core.debug.open",
            title: item_title("help", "debug", language)?,
            accelerator: None,
        }],
    })
}

/// Builds the window menu. The title and shortcut of the new window come from the table.
fn window_submenu(language: &str) -> Result<Menu, String> {
    Ok(Menu {
        id: "window",
        title: Some(menu_title("window", language)?),
        items: vec![
            MenuItem::Command {
                id: "new-window",
                title: item_title("window", "new-window", language)?,
                accelerator: Some(accelerator(item_key("window", "new-window")?)?),
            },
            system("bring-all-to-front"),
        ],
    })
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
