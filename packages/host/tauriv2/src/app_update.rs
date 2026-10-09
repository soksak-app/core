//! The host calls of the application update (docs/spec/installation.md#application-update).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use soksak_sok::appupdate::{self, AppUpdateState};

/// The host name of this application in the key of a core release.
const HOST: &str = "tauriv2";

/// Reads the registry index and returns the candidate of an application that runs core version `running` for the
/// release `key`.
pub fn read_state(config_dir: &Path, running: &str, key: &str) -> Result<AppUpdateState, String> {
    appupdate::read_app_update_state(config_dir, running, key)
}

/// Prepares the candidate: it fails when `version` is not the candidate for `key`, so the host stages only the version
/// that the registry index offers now.
pub fn stage(
    config_dir: &Path,
    running: &str,
    key: &str,
    version: &str,
) -> Result<PathBuf, String> {
    let state = read_state(config_dir, running, key)?;
    match state.available {
        Some(update) if update.version == version => {
            appupdate::stage_app_update(config_dir, &update)
        }
        _ => Err(format!(
            "application update: {version} is not the candidate of core {running}"
        )),
    }
}

/// The key of the core release of this application: its platform and host.
fn key() -> Result<String, String> {
    Ok(format!("{}-{HOST}", soksak_sok::current_platform()?))
}

/// The argument of the appUpdateStage call.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageRequest {
    pub version: String,
}

/// The answer of appUpdateStage.
#[derive(Serialize)]
pub struct Staged {
    pub bundle: String,
}

/// One preparation at a time.
static STAGING: Mutex<()> = Mutex::new(());

/// The page's appUpdateState call.
pub fn state(config_dir: &Path) -> Result<AppUpdateState, String> {
    read_state(config_dir, soksak_sok::version::CORE_VERSION, &key()?)
}

/// The page's appUpdateStage call: it downloads, checks and extracts the release of the candidate.
pub fn stage_call(config_dir: &Path, request: StageRequest) -> Result<Staged, String> {
    let Ok(_staging) = STAGING.try_lock() else {
        return Err("application update: another update is being prepared".into());
    };
    let bundle = stage(
        config_dir,
        soksak_sok::version::CORE_VERSION,
        &key()?,
        &request.version,
    )?;
    Ok(Staged {
        bundle: bundle.display().to_string(),
    })
}

/// Checks the staged bundle and prepares the command that replaces the running bundle: sok runs from a copy under
/// updates/ of the configuration directory, because the bundle that holds the running sok is replaced. The bundle must
/// be a staged bundle under that folder, and the executable must run from an application bundle; the arguments are those
/// of the application that starts again.
pub fn prepare_start(
    config_dir: &Path,
    executable: &Path,
    bundle: &Path,
    pid: u32,
    arguments: &[String],
) -> Result<Command, String> {
    let updates = config_dir.join("updates");
    if !bundle.starts_with(&updates)
        || bundle
            .extension()
            .is_none_or(|extension| extension != "app")
    {
        return Err(format!(
            "application update: {} is not a staged bundle under {}",
            bundle.display(),
            updates.display()
        ));
    }
    if !bundle.join("Contents/Info.plist").is_file() {
        return Err(format!(
            "application update: {} is not an application bundle",
            bundle.display()
        ));
    }
    let not_bundled = || {
        format!(
            "application update: {} does not run from an application bundle",
            executable.display()
        )
    };
    let macos = executable.parent().ok_or_else(not_bundled)?;
    let target = macos
        .parent()
        .and_then(Path::parent)
        .filter(|target| {
            target
                .extension()
                .is_some_and(|extension| extension == "app")
        })
        .filter(|_| macos.file_name().is_some_and(|name| name == "MacOS"))
        .ok_or_else(not_bundled)?;
    let copied = updates.join("sok");
    std::fs::copy(macos.join("sok"), &copied)
        .map_err(|error| format!("application update: {error}"))?;
    soksak_sok::platform::current()
        .and_then(|platform| platform.set_executable(&copied, true))
        .map_err(|error| format!("application update: {error}"))?;
    let mut command = Command::new(&copied);
    command
        .args(["app", "update", "--wait"])
        .arg(pid.to_string())
        .arg("--bundle")
        .arg(bundle)
        .arg("--target")
        .arg(target);
    if !arguments.is_empty() {
        command.arg("--").args(arguments);
    }
    crate::platform::current()
        .and_then(|platform| platform.new_session(&mut command))
        .map_err(|error| format!("application update: {error}"))?;
    Ok(command)
}

/// The argument of the appUpdateApply call.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyRequest {
    pub bundle: String,
}

/// The page's appUpdateApply call: it prepares the command that replaces the bundle. The caller stores it and quits the
/// application as host.quit does; the command starts when the quit is certain.
pub fn apply_call(config_dir: &Path, request: ApplyRequest) -> Result<Command, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("application update: {error}"))?;
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    prepare_start(
        config_dir,
        &executable,
        Path::new(&request.bundle),
        std::process::id(),
        &arguments,
    )
}
