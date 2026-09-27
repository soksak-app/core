//! 테마 저장과 전달.
//!
//! 표면과 모달은 별도 문서이고 메인 페이지의 스타일시트를 상속하지 않는다. 그래서 테마 값을
//! 전달하고 각 페이지가 자신의 루트에 설정한다.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Window;

use crate::windows::{emit_window, window_data};

/// 페이지의 테마. 호스트가 만드는 페이지에 전달한다.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Theme {
    scheme: String,
    tokens: HashMap<String, String>,
}

/// 페이지가 마지막으로 선언한 테마.
#[derive(Default)]
pub(crate) struct CurrentTheme(Mutex<Theme>);

/// 현재 테마를 반환한다. 페이지는 로드할 때 요청한다.
pub(crate) fn get(window: &Window) -> Result<Theme, String> {
    let context = window_data(window)?;
    let theme = context.theme.0.lock().map_err(|e| e.to_string())?.clone();
    Ok(theme)
}

/// Returns whether the window's current theme uses the dark scheme.
pub(crate) fn is_dark(window: &Window) -> Result<bool, String> {
    Ok(get(window)?.scheme == "dark")
}

/// 페이지가 현재 사용하는 테마를 기록하고 창의 페이지에 전달한다. 페이지는 렌더링마다가 아니라
/// 테마를 선택할 때 호출한다.
pub(crate) fn set(window: &Window, theme: Theme) -> Result<(), String> {
    let context = window_data(window)?;
    *context.theme.0.lock().map_err(|e| e.to_string())? = theme.clone();
    let documents = context.documents.all();
    let dark = theme.scheme == "dark";
    if let Some(main) = crate::windows::root_view(window) {
        let platform = crate::platform::current()?;
        crate::exposure::with_view(&main, move |view| platform.set_main_appearance(view, dark))?;
    }
    let platform = crate::platform::current()?;
    for document in documents {
        platform.set_document_appearance(document, dark)?;
    }
    emit_window(window, "theme", theme).map_err(|e| e.to_string())
}
