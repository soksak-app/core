//! Theme storage and delivery.
//!
//! Surfaces and modals are separate documents and do not inherit the stylesheet of the main page. The theme value is
//! therefore passed on, and each page sets it on its own root.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Window;

use crate::windows::{emit_window, window_data};

/// The theme of the page. It is passed to the pages that the host creates.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Theme {
    scheme: String,
    tokens: HashMap<String, String>,
}

/// The theme that the page declared last.
#[derive(Default)]
pub(crate) struct CurrentTheme(Mutex<Theme>);

/// Returns the current theme. The page requests it when it loads.
pub(crate) fn get(window: &Window) -> Result<Theme, String> {
    let context = window_data(window)?;
    let theme = context.theme.0.lock().map_err(|e| e.to_string())?.clone();
    Ok(theme)
}

/// Returns whether the current theme of the window uses the dark scheme.
pub(crate) fn is_dark(window: &Window) -> Result<bool, String> {
    Ok(get(window)?.scheme == "dark")
}

/// Records the theme that the page currently uses and passes it to the pages of the window. The page calls it when it
/// selects a theme and not at every rendering.
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
    // A view receives the theme after its ready message, so the views with a ready document receive the change here.
    crate::documents::post_theme_to_views(window)?;
    emit_window(window, "theme", theme).map_err(|e| e.to_string())
}
