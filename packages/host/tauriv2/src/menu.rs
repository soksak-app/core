//! 애플리케이션 메뉴.
//!
//! docs/spec/host-contract.md 의 "Application menu" 표가 메뉴의 계약이다. [`MENUS`] 와
//! [`ITEMS`] 가 그 표이고 [`build`] 가 표의 언어로 메뉴를 만든다. source 가 "title" 인 항목은
//! 표의 제목을 쓰고 "system" 인 항목은 프레임워크가 준 제목과 단축키를 유지한다. 두 호스트가
//! 같은 표를 싣는지 scripts/check-host-parity.mjs 가 기계로 검사한다.

use std::ffi::CString;

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

/// 상위 메뉴의 계약 표. (id, ko, en). app 제목은 애플리케이션 이름이므로 비워 둔다.
pub const MENUS: &[(&str, &str, &str)] = &[
    ("app", "", ""),
    ("file", "파일", "File"),
    ("edit", "편집", "Edit"),
    ("view", "보기", "View"),
    ("window", "윈도우", "Window"),
    ("help", "도움말", "Help"),
];

/// 메뉴 항목의 계약 표. (menu, id, source, ko, en, key). source 가 "system" 인 항목은
/// 프레임워크 제목을 유지하고 "title" 인 항목은 표의 제목을 쓴다. 한 행이 한 줄이어야
/// scripts/check-host-parity.mjs 가 행을 읽을 수 있으므로 이 표는 줄맞춤에서 뺀다.
#[rustfmt::skip]
pub const ITEMS: &[(&str, &str, &str, &str, &str, &str)] = &[
    ("app", "about", "system", "", "", ""),
    ("app", "services", "system", "", "", ""),
    ("app", "hide", "system", "", "", ""),
    ("app", "hide-others", "system", "", "", ""),
    ("app", "show-all", "system", "", "", ""),
    ("app", "quit", "system", "", "", ""),
    ("file", "close-window", "title", "윈도우 닫기", "Close Window", "cmd+w"),
    ("file", "close-all", "system", "", "", ""),
    ("edit", "undo", "title", "실행 취소", "Undo", "cmd+z"),
    ("edit", "redo", "title", "다시 실행", "Redo", "shift+cmd+z"),
    ("edit", "cut", "title", "잘라내기", "Cut", "cmd+x"),
    ("edit", "copy", "title", "복사", "Copy", "cmd+c"),
    ("edit", "paste", "title", "붙여넣기", "Paste", "cmd+v"),
    ("edit", "select-all", "title", "모두 선택", "Select All", "cmd+a"),
    ("view", "fullscreen", "title", "전체 화면으로 전환", "Toggle Full Screen", "ctrl+cmd+f"),
    ("view", "text-larger", "title", "글자 크게", "Bigger Text", "cmd+="),
    ("view", "text-smaller", "title", "글자 작게", "Smaller Text", "cmd+-"),
    ("view", "text-default", "title", "글자 기본 크기", "Default Text Size", "cmd+0"),
    ("window", "new-window", "title", "새 창", "New Window", "shift+cmd+n"),
    ("window", "bring-all-to-front", "system", "", "", ""),
];

/// 표의 언어와 그 제목 열. 계약 표에 언어 열을 더하면 이 표도 함께 늘어난다.
const LANGUAGES: &[(&str, usize)] = &[("ko", 1), ("en", 2)];

/// 기본 언어. 시스템 언어가 표의 언어가 아닐 때 초기 메뉴가 쓴다.
const DEFAULT_LANGUAGE: &str = "en";

/// 글자 크기 항목의 표 id 와 메뉴 항목 id. 메뉴 항목 id 는 페이지로 보내는 명령 이름이다.
const TEXT_COMMANDS: &[(&str, &str)] = &[
    ("text-larger", "core.text.larger"),
    ("text-smaller", "core.text.smaller"),
    ("text-default", "core.text.reset"),
];

/// 현재 메뉴 언어. 페이지가 설정 언어를 보내기 전에는 시스템 언어에서 정한 초기 값이다.
/// [`set_language`] 가 메뉴를 다시 만들지 않을지를 이 값으로 정한다.
pub struct MenuLanguage(pub std::sync::Mutex<String>);

/// 언어 태그의 표 제목 열 위치를 반환한다. 표의 언어가 아니면 명시적인 오류이다.
pub fn language_column(language: &str) -> Result<usize, String> {
    LANGUAGES
        .iter()
        .find(|(tag, _)| *tag == language)
        .map(|(_, column)| *column)
        .ok_or_else(|| format!("the menu table has no language {language:?}"))
}

/// 상위 메뉴의 언어별 제목. app 메뉴는 제목이 애플리케이션 이름이므로 표가 비워 둔다.
pub fn menu_title(id: &str, language: &str) -> Result<String, String> {
    let column = language_column(language)?;
    MENUS
        .iter()
        .find(|(menu, _, _)| *menu == id)
        .ok_or_else(|| format!("the menu table has no menu {id:?}"))
        .and_then(|(_, ko, en)| column_title(&[ko, en], column))
}

/// 계약 표에서 (menu, id) 항목의 언어별 제목.
pub fn item_title(menu: &str, id: &str, language: &str) -> Result<String, String> {
    let column = language_column(language)?;
    item_row(menu, id).and_then(|row| column_title(&[row.3, row.4], column))
}

/// 계약 표의 key 형식(host.menu 보고 형식)을 메뉴 라이브러리의 단축키 형식으로 바꾼다.
/// 수정 키는 cmd, shift, ctrl, opt 순서로 + 로 이어붙이고 마지막 칸이 키다.
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

/// 메뉴 항목 id 가 글자 크기 명령인지 알려준다. 메뉴 이벤트 배선이 쓴다.
pub fn text_command(id: &str) -> bool {
    TEXT_COMMANDS.iter().any(|(_, command)| *command == id)
}

/// 페이지가 설정 언어를 보내기 전의 초기 메뉴 언어. 시스템 선호 언어의 주 태그를 표의
/// 언어에서 찾고 표에 없으면 기본 언어를 쓴다(docs/spec/host-contract.md 의 Application menu).
#[cfg(target_os = "macos")]
pub fn initial_language() -> String {
    extern "C" {
        fn sp_preferred_language() -> *mut std::ffi::c_char;
    }
    let tag = unsafe {
        let value = sp_preferred_language();
        if value.is_null() {
            return DEFAULT_LANGUAGE.to_string();
        }
        // native/darwin 이 strdup 으로 만든 문자열이므로 해제까지 여기서 맡는다.
        CString::from_raw(value).to_string_lossy().into_owned()
    };
    if LANGUAGES.iter().any(|(tag_name, _)| *tag_name == tag) {
        tag
    } else {
        DEFAULT_LANGUAGE.to_string()
    }
}

/// macOS 가 아닌 운영체제에는 시스템 언어 조사가 없다. 그 운영체제의 앱은 설정 단계의 다른
/// 네이티브 기능이 먼저 실패하므로 기본 언어가 초기 언어다.
#[cfg(not(target_os = "macos"))]
pub fn initial_language() -> String {
    DEFAULT_LANGUAGE.to_string()
}

/// 메뉴 언어를 바꾼다. 표의 언어가 아니면 명시적인 오류이고 언어가 같으면 메뉴를 다시
/// 만들지 않는다. [`MenuLanguage`] 는 setup 이 관리 상태로 등록한다.
pub fn set_language(app: &AppHandle, language: &str) -> Result<(), String> {
    language_column(language)?;
    let state = app.state::<MenuLanguage>();
    let mut current = state
        .0
        .lock()
        .map_err(|_| "the menu language state is poisoned".to_string())?;
    if *current == language {
        return Ok(());
    }
    let menu = build(app, language)?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    *current = language.to_string();
    Ok(())
}

/// 계약 표로 애플리케이션 메뉴를 만든다. language 는 표의 언어다. 상위 메뉴의 순서는
/// [`MENUS`] 를 따르고 app 메뉴(첫 번째 하위 메뉴)의 제목은 애플리케이션 이름이다.
pub fn build(app: &AppHandle, language: &str) -> Result<Menu<Wry>, String> {
    language_column(language)?;
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for id in MENUS.iter().map(|(menu, _, _)| *menu) {
        let submenu = match id {
            "app" => app_submenu(app),
            "file" => file_submenu(app, language),
            "edit" => edit_submenu(app, language),
            "view" => view_submenu(app, language),
            "window" => window_submenu(app, language),
            "help" => Submenu::with_id(app, id, menu_title(id, language)?, true)
                .map_err(|error| error.to_string()),
            unknown => return Err(format!("the menu table has unknown menu {unknown:?}")),
        }?;
        menu.append(&submenu).map_err(|error| error.to_string())?;
    }
    Ok(menu)
}

/// app 메뉴를 만든다. 항목은 tauri 기본 메뉴의 사전정의 항목을 표 순서로 두고 여기에
/// show_all 을 더한다. 제목은 모두 프레임워크가 준다.
fn app_submenu(app: &AppHandle) -> Result<Submenu<Wry>, String> {
    let package = app.package_info();
    let bundle = &app.config().bundle;
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: bundle.copyright.clone(),
        authors: bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let about_item = PredefinedMenuItem::about(app, None, Some(about)).map_err(string)?;
    let after_about = separator(app)?;
    let services_item = PredefinedMenuItem::services(app, None).map_err(string)?;
    let after_services = separator(app)?;
    let hide_item = PredefinedMenuItem::hide(app, None).map_err(string)?;
    let hide_others_item = PredefinedMenuItem::hide_others(app, None).map_err(string)?;
    let show_all_item = PredefinedMenuItem::show_all(app, None).map_err(string)?;
    let after_show_all = separator(app)?;
    let quit_item = PredefinedMenuItem::quit(app, None).map_err(string)?;
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

/// file 메뉴를 만든다. 윈도우 닫기 제목은 표에서 온다. close-all 은 만들지 않는다. 측정하면
/// 애플리케이션이 시작을 마칠 때(NSApp finishLaunching) 시스템이 close-window 의 performClose:
/// 항목 곁에 "Close All" 대체 항목(isAlternate)을 스스로 더하므로 계약 표에는 있지만 여기서
/// 만들 항목이 없다.
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

/// edit 메뉴를 만든다. 항목 제목은 표에서 오고 단축키는 프레임워크가 준다.
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

/// view 메뉴를 만든다. 전체 화면과 글자 크기 항목의 제목은 표에서 온다. 글자 크기 항목의
/// 메뉴 항목 id 는 페이지로 보내는 명령 이름이다(docs/spec/text-size.md).
fn view_submenu(app: &AppHandle, language: &str) -> Result<Submenu<Wry>, String> {
    let fullscreen =
        PredefinedMenuItem::fullscreen(app, Some(&item_title("view", "fullscreen", language)?))
            .map_err(string)?;
    let mut text_items = Vec::new();
    for (row, command) in TEXT_COMMANDS {
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
    let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![&fullscreen];
    items.extend(text_items.iter().map(|item| item as &dyn IsMenuItem<Wry>));
    Submenu::with_id_and_items(app, "view", menu_title("view", language)?, true, &items)
        .map_err(string)
}

/// window 메뉴를 만든다. 새 창 제목과 단축키는 표에서 온다.
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

/// 구분 항목을 만든다. 보고는 구분 항목을 빼고 항목 순서만 다룬다.
fn separator(app: &AppHandle) -> Result<PredefinedMenuItem<Wry>, String> {
    PredefinedMenuItem::separator(app).map_err(string)
}

/// tauri 오류를 문자열 오류로 바꾼다.
fn string(error: tauri::Error) -> String {
    error.to_string()
}

/// 계약 표에서 (menu, id) 항목 행을 찾는다.
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

/// 계약 표에서 (menu, id) 항목의 key 형식 단축키.
fn item_key(menu: &str, id: &str) -> Result<&'static str, String> {
    item_row(menu, id).map(|row| row.5)
}

/// 표의 제목 열 중 언어 열의 값을 고른다.
fn column_title(cells: &[&'static str], column: usize) -> Result<String, String> {
    cells
        .get(column - 1)
        .map(|title| title.to_string())
        .ok_or_else(|| format!("language column {column} is not in the menu table"))
}
