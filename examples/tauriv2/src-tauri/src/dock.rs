use block2::{Block, RcBlock};
use tauri::AppHandle;

pub(crate) fn setup(app: AppHandle) -> Result<(), String> {
    extern "C" { fn appInstallDockMenu(new_window: &Block<dyn Fn()>) -> bool; }
    let create = RcBlock::new(move || {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = crate::windows::window_new(app) { eprintln!("{error}"); }
        });
    });
    if unsafe { appInstallDockMenu(&create) } { Ok(()) }
    else { Err("failed to register the Dock menu".into()) }
}
