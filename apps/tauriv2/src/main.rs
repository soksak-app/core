// Runs the soksak workbench as a Tauri v2 application. The host functions are
// provided by soksak-host-tauriv2.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Script that a surface webview runs before the document. The frontend staging step generates it.
const BACKGROUND: &str = include_str!("frontend/background.js");

fn main() {
    soksak_host_tauriv2::run(tauri::generate_context!(), BACKGROUND);
}
