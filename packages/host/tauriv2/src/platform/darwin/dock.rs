//! Dock 메뉴.

use block2::{Block, RcBlock};

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
