// Runs the soksak workbench as a GPUI application. The host functions are
// provided by soksak-host-gpuikit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

fn main() {
    let folder = match frontend_folder() {
        Ok(folder) => folder,
        Err(error) => {
            soksak_host::application_log::log_error("start", &error);
            std::process::exit(1);
        }
    };
    soksak_host_gpuikit::run(Arc::new(soksak_host_gpuikit::StagedFrontend::new(folder)));
}

/// The frontend folder beside the executable, where the staging step of the application writes the page files; a release
/// build places it in the bundle.
fn frontend_folder() -> Result<std::path::PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("the executable path is unknown: {error}"))?;
    let folder = executable
        .parent()
        .ok_or_else(|| format!("the executable path {} has no folder", executable.display()))?;
    Ok(folder.join("frontend"))
}
