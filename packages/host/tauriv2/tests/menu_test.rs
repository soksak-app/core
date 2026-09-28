//! 애플리케이션 메뉴 계약 표의 테스트.
//!
//! 메뉴 빌더는 docs/spec/host-contract.md 의 "Application menu" 표에서 제목과 순서를
//! 정한다. 여기서는 표의 언어별 제목, 순서, 단축키 형식을 검사한다. 만들어진 메뉴 바 자체는
//! 창 검사 계층이 host.menu 로 비교한다.

use soksak_host_tauriv2::menu;

/// 상위 메뉴 제목의 언어별 목록.
fn menu_titles(language: &str) -> Vec<String> {
    menu::MENUS
        .iter()
        .map(|(id, _, _)| menu::menu_title(id, language).unwrap())
        .collect()
}

/// 메뉴의 항목 중 제목이 표에 있는(source "title") 항목의 제목을 표 순서로.
fn titled_item_titles(menu_id: &str, language: &str) -> Vec<String> {
    menu::ITEMS
        .iter()
        .filter(|(row, _, source, ..)| *row == menu_id && *source == "title")
        .map(|(_, id, _, _, _, _)| menu::item_title(menu_id, id, language).unwrap())
        .collect()
}

/// 메뉴의 항목 id 를 표 순서로.
/// 시스템이 앱 시작을 마칠 때 스스로 놓는 표의 행. 빌더는 만들지 않는다.
const OS_INSERTED: [&str; 2] = ["close-all", "fullscreen"];

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
    // 보기 메뉴의 빌더 항목은 글자 크기 셋뿐이다. 전체 화면 항목은 앱 시작을 마칠 때
    // 시스템이 View 메뉴에 스스로 먼저 놓는다(계약표의 system 행, 실창 검사가 확인한다).
    assert_eq!(
        item_ids("view"),
        ["text-larger", "text-smaller", "text-default"]
    );
    // 글자 크기 항목은 페이지 명령 id 를 메뉴 항목 id 로 쓴다.
    assert!(menu::text_command("core.text.larger"));
    assert!(menu::text_command("core.text.smaller"));
    assert!(menu::text_command("core.text.reset"));
    assert!(!menu::text_command("new-window"));
    // 단축키는 계약표의 key 형식에서 메뉴 라이브러리 형식으로 바뀐다. 글자 크기는 =, -, 0.
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
    // close-all 은 시스템이 제공하므로 표의 key 칸이 비어 있다.
    assert!(menu::accelerator("cmd+").is_err());
    assert!(menu::accelerator("meta+w").is_err());
}

// contract: menu.application.view-has-full-screen-and-text-size
#[test]
fn table_titles_serve_both_languages() {
    // app 메뉴 제목은 애플리케이션 이름이므로 표가 비워 둔다.
    assert_eq!(
        menu_titles("ko"),
        ["", "파일", "편집", "보기", "윈도우", "도움말"]
    );
    assert_eq!(
        menu_titles("en"),
        ["", "File", "Edit", "View", "Window", "Help"]
    );
    // 항목 제목과 순서도 표를 따른다. 파일·편집·보기 메뉴는 제목 있는 항목 전체를 대조한다.
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
    // 항목 배치 순서는 표 순서다. app 메뉴는 tauri 기본 메뉴의 사전정의 항목에 show_all 이
    // 더해진 순서다.
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
        ["text-larger", "text-smaller", "text-default"]
    );
    assert_eq!(item_ids("window"), ["new-window", "bring-all-to-front"]);
    assert_eq!(item_ids("help"), Vec::<&str>::new());
    // 계약 표에 없는 언어는 메뉴를 만들지 못한다.
    let error = menu::menu_title("file", "fr").unwrap_err();
    assert!(error.contains("fr"), "{error}");
    assert!(menu::item_title("edit", "undo", "ja").is_err());
    assert!(menu::language_column("korean").is_err());
}
