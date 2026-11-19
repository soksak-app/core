// Runs the soksak workbench as a GPUI application. The host functions are
// provided by soksak-host-gpuikit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

fn main() {
    // The staging step of the application writes the page files to the frontend folder beside the executable, and a
    // release build places it in the bundle.
    let folder = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(|folder| folder.join("frontend")))
        .expect("the executable of the application has a folder beside it");
    soksak_host_gpuikit::run(Arc::new(soksak_host_gpuikit::StagedFrontend::new(folder)));
}
