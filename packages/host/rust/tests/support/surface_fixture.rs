//! The installed probe plugin of the surface tests: the state and the folder of tests/fixtures/plugin-surface, written in the layout
//! that the installation writes (docs/spec/installation.md). A view of a surface of the plugin loads its page from the folder.

#![allow(dead_code)]

use std::path::Path;

use soksak_host::sidecars::{SidecarDeclaration, Sidecars};

use crate::folder::{Folder, install_fixture};
use crate::sidecar_recorder::SidecarRecorder;

/// The declared name of the echo sidecar of the surface tests, and its version.
pub const ECHO: &str = "@fixture/sidecar-echo";
pub const ECHO_VERSION: &str = "0.0.1";

/// The folder of the installed echo sidecar, relative to the configuration folder: the platform key of the running host.
fn echo_sidecar_path() -> String {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let os = if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    format!("sidecars/fixture-sidecar-echo/{ECHO_VERSION}/{os}-{arch}")
}

/// Installs the echo sidecar into the configuration folder config: its sidecar.json declares the executable `echo`, which is
/// the sidecar fixture program that appends each line it receives to the file `requests` of the sidecar folder. It panics on any error.
fn install_echo_sidecar(config: &Path) {
    let folder = config.join(echo_sidecar_path());
    std::fs::create_dir_all(&folder).expect("create the echo sidecar folder");
    std::fs::write(
        folder.join("sidecar.json"),
        r#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#,
    )
    .expect("write the sidecar.json of the echo sidecar");
    install_fixture(
        &folder,
        "echo",
        &format!("ignore-term\non any tee {}\n", folder.join("requests").display()),
    );
}

/// The lines that the installed echo sidecar of the configuration folder config received, after its stop.
pub fn installed_echo_requests(config: &Path) -> String {
    std::fs::read_to_string(config.join(echo_sidecar_path()).join("requests"))
        .unwrap_or_else(|error| panic!("read the requests of the installed echo sidecar: {error}"))
}

/// The lines that the installed echo sidecar of the configuration folder config received so far. The requests file exists from the
/// first line that the sidecar receives, so a file that does not exist yet holds no line.
pub fn installed_echo_requests_so_far(config: &Path) -> Result<String, String> {
    match std::fs::read_to_string(config.join(echo_sidecar_path()).join("requests")) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("read the requests of the installed echo sidecar: {error}")),
    }
}

/// The folder of the probe plugin fixture of the surface tests: its package.json holds the version that the installation records.
fn probe_source() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugin-surface")
}

/// The version of the probe plugin, read from the package.json of its fixture folder.
pub fn probe_version() -> String {
    let text = std::fs::read_to_string(probe_source().join("package.json"))
        .unwrap_or_else(|error| panic!("read the package.json of the probe plugin: {error}"));
    let package: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse the package.json of the probe plugin: {error}"));
    package["version"]
        .as_str()
        .unwrap_or_else(|| panic!("the package.json of the probe plugin has no version"))
        .to_string()
}

/// Installs the probe plugin into the configuration folder config: its manifest and page are copied from tests/fixtures/plugin-surface
/// into `plugins/probe/<version>`, and `plugins/installed.json` names it as enabled. It panics on any error.
pub fn install_probe_plugin(config: &Path) {
    let source = probe_source();
    let version = probe_version();
    let folder = config.join("plugins/probe").join(&version);
    std::fs::create_dir_all(folder.join("ui")).expect("create the probe plugin folder");
    for name in ["package.json", "plugin.json", "ui/page.html"] {
        std::fs::copy(source.join(name), folder.join(name))
            .unwrap_or_else(|error| panic!("copy {name} of the probe plugin: {error}"));
    }
    install_echo_sidecar(config);
    let state = serde_json::json!({
        "format": 3,
        "sidecars": {
            ECHO: { "path": echo_sidecar_path(), "version": ECHO_VERSION }
        },
        "plugins": {
            "probe": {
                "enabled": true,
                "path": format!("plugins/probe/{version}"),
                "sidecars": { ECHO: "^0.0.1" },
                "version": version,
            }
        },
    });
    std::fs::write(
        config.join("plugins/installed.json"),
        serde_json::to_vec_pretty(&state).expect("serialize the installed state"),
    )
    .expect("write plugins/installed.json");
}


/// Declares the echo sidecar in folder: the sidecar fixture program (docs/spec/cases/sidecars/fixture.sh) runs as `echo`, ignores
/// the terminate signal of the stop, and appends each line that it receives to the file `requests` of folder, so the file is the
/// observation of what the sidecar received. It panics on any error.
pub fn echo_sidecars(folder: &Folder) -> Sidecars<SidecarRecorder> {
    folder.fixture(
        "echo",
        &format!(
            "ignore-term\non any tee {}\n",
            folder.path().join("requests").display()
        ),
    );
    let declaration = SidecarDeclaration {
        name: ECHO.to_string(),
        folder: folder.path().to_path_buf(),
        data: br#"{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}"#.to_vec(),
        error: None,
        version: "0.0.1".to_string(),
        dependents: Vec::new(),
    };
    Sidecars::new(&[declaration], folder.path().to_path_buf())
        .unwrap_or_else(|error| panic!("declare the echo sidecar: {error}"))
}

/// The lines that the echo sidecar of folder received, after its stop.
pub fn recorded_requests(folder: &Folder) -> String {
    std::fs::read_to_string(folder.path().join("requests"))
        .unwrap_or_else(|error| panic!("read the requests of the echo sidecar: {error}"))
}
