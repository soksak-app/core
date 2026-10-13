//! The Dock menu.

use std::ffi::{CString, c_char};

use block2::{Block, RcBlock};
use serde_json::Value;

use super::window::facts_value;

/// Returns the main tag of the system preferred language (sp_preferred_language of window_facts.h). The caller decides
/// whether that tag is a language of the contract table.
pub fn preferred_language() -> Result<String, String> {
    unsafe extern "C" {
        fn sp_preferred_language() -> *mut std::ffi::c_char;
    }
    let value = unsafe { sp_preferred_language() };
    if value.is_null() {
        return Ok(String::new());
    }
    // native/darwin creates the string with strdup, so releasing it is also done here.
    let tag = unsafe { std::ffi::CString::from_raw(value) };
    Ok(tag.to_string_lossy().into_owned())
}

/// Installs the new window item in the Dock menu.
pub fn install(new_window: Box<dyn Fn()>) -> Result<(), String> {
    unsafe extern "C" {
        fn appInstallDockMenu(new_window: &Block<dyn Fn()>) -> bool;
    }
    let create = RcBlock::new(new_window);
    if unsafe { appInstallDockMenu(&create) } {
        Ok(())
    } else {
        Err("failed to register the Dock menu".into())
    }
}

/// The application menu.
pub fn menu() -> Result<Value, String> {
    unsafe extern "C" {
        fn sp_menu_items() -> *mut c_char;
    }
    facts_value(unsafe { sp_menu_items() }, "application menu")
}

/// The list of titles of the Dock menu items.
pub fn items() -> Result<Value, String> {
    unsafe extern "C" {
        fn sp_dock_items() -> *mut c_char;
    }
    facts_value(unsafe { sp_dock_items() }, "Dock menu")
}

/// Runs the application menu item with the title title in the submenu with the title menu.
pub fn menu_select(menu: &str, title: &str) -> Result<(), String> {
    unsafe extern "C" {
        fn sp_menu_select(menu: *const c_char, title: *const c_char) -> bool;
    }
    let menu_text = CString::new(menu).map_err(|e| e.to_string())?;
    let title_text = CString::new(title).map_err(|e| e.to_string())?;
    if unsafe { sp_menu_select(menu_text.as_ptr(), title_text.as_ptr()) } {
        Ok(())
    } else {
        Err(format!("application menu {menu:?} has no item {title:?}"))
    }
}

/// The main window handle of the application. It is 0 when there is none.
pub fn main_window() -> super::Handle {
    unsafe extern "C" {
        fn sp_app_main_window() -> *mut std::ffi::c_void;
    }
    unsafe { sp_app_main_window() as super::Handle }
}

/// Runs the Dock menu item with the title title.
pub fn select(title: &str) -> Result<(), String> {
    unsafe extern "C" {
        fn sp_dock_select(title: *const c_char) -> bool;
    }
    let text = CString::new(title).map_err(|e| e.to_string())?;
    if unsafe { sp_dock_select(text.as_ptr()) } {
        Ok(())
    } else {
        Err(format!("Dock menu has no item {title:?}"))
    }
}
