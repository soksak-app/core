// Runs the soksak workbench as a GPUI application. The host functions are
// provided by soksak-host-gpuikit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

/// The staged page files of the application, in the `frontend` folder beside the executable. The staging step of
/// the application writes the folder, and a release build places it in the resources of the bundle.
struct Staged(PathBuf);

impl soksak_host::assets::Assets for Staged {
    fn get(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        std::fs::read(self.0.join(key)).ok().map(Cow::Owned)
    }
}

fn main() {
    let folder = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(|folder| folder.join("frontend")))
        .expect("the executable of the application has a folder beside it");
    soksak_host_gpuikit::run(Arc::new(Staged(folder)));
}
