//! Dock 메뉴.

use std::ffi::{c_char, CString};

use block2::{Block, RcBlock};
use serde_json::Value;

use super::window::facts_value;

/// Dock 메뉴에 새 창 항목을 설치한다.
pub fn install(new_window: Box<dyn Fn()>) -> Result<(), String> {
    extern "C" {
        fn appInstallDockMenu(new_window: &Block<dyn Fn()>) -> bool;
    }
    let create = RcBlock::new(move || new_window());
    if unsafe { appInstallDockMenu(&create) } {
        Ok(())
    } else {
        Err("failed to register the Dock menu".into())
    }
}

/// Dock 메뉴 항목의 제목 목록.
pub fn items() -> Result<Value, String> {
    extern "C" {
        fn sp_dock_items() -> *mut c_char;
    }
    facts_value(unsafe { sp_dock_items() }, "Dock menu")
}

/// 제목이 title 인 Dock 메뉴 항목을 실행한다.
pub fn select(title: &str) -> Result<(), String> {
    extern "C" {
        fn sp_dock_select(title: *const c_char) -> bool;
    }
    let text = CString::new(title).map_err(|e| e.to_string())?;
    if unsafe { sp_dock_select(text.as_ptr()) } {
        Ok(())
    } else {
        Err(format!("Dock menu has no item {title:?}"))
    }
}
