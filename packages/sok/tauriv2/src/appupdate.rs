//! The candidate of an application update and the preparation of its release
//! (docs/spec/installation.md#application-update).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::install::{newer, Index, Release};

/// The candidate of an application update: a core version that the registry index lists and its release.
#[derive(Clone, Debug, Serialize)]
pub struct AppUpdate {
    pub version: String,
    pub release: Release,
}

/// The version of the running core and the candidate, or None when none is available.
#[derive(Clone, Debug, Serialize)]
pub struct AppUpdateState {
    pub version: String,
    pub available: Option<AppUpdate>,
}

/// Selects the newest version of `core` that is newer than the running core, is not revoked and has a release for
/// `key`, `<platform>-<host>`; it is None when there is none.
pub fn core_update_candidate(index: &Index, running: &str, key: &str) -> Option<AppUpdate> {
    let core = index.core.as_ref()?;
    let mut best: Option<AppUpdate> = None;
    for item in &core.versions {
        let Some(release) = item.releases.get(key) else {
            continue;
        };
        if !newer(&item.version, running)
            || index
                .revoked
                .core
                .iter()
                .any(|revoked| revoked.version == item.version)
        {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|best| newer(&item.version, &best.version))
        {
            best = Some(AppUpdate {
                version: item.version.clone(),
                release: release.clone(),
            });
        }
    }
    best
}

/// Reads the registry index and returns the candidate for `key`. A configuration directory without a registry fails
/// with the error of read_registry.
pub fn read_app_update_state(
    config_dir: &Path,
    running: &str,
    key: &str,
) -> Result<AppUpdateState, String> {
    let index = crate::plugins::read_registry(config_dir)?;
    Ok(AppUpdateState {
        version: running.to_string(),
        available: core_update_candidate(&index, running, key),
    })
}

/// Downloads the release of the candidate, checks its sha256, extracts the zip into `<config_dir>/updates/<version>/`
/// after removing that folder, checks that the folder holds one application bundle whose version is the version, and
/// returns the path of the bundle. A failure removes the folder.
pub fn stage_app_update(config_dir: &Path, update: &AppUpdate) -> Result<PathBuf, String> {
    let at = format!("application update {}", update.version);
    let data = crate::registry::read_release(&at, &update.release)?;
    let folder = config_dir.join("updates").join(&update.version);
    let fail = |error: String| match std::fs::remove_dir_all(&folder) {
        Ok(()) => format!("{at}: {error}"),
        Err(removed) => format!("{at}: {error}; the staged folder was not removed: {removed}"),
    };
    if folder.exists() {
        std::fs::remove_dir_all(&folder).map_err(|error| format!("{at}: {error}"))?;
    }
    std::fs::create_dir_all(&folder).map_err(|error| format!("{at}: {error}"))?;
    let platform = crate::platform::current().map_err(fail)?;
    let release = folder.join("release.zip");
    std::fs::write(&release, data).map_err(|error| fail(error.to_string()))?;
    platform.extract_bundle(&release, &folder).map_err(fail)?;
    std::fs::remove_file(&release).map_err(|error| fail(error.to_string()))?;
    let mut bundles = vec![];
    for entry in std::fs::read_dir(&folder).map_err(|error| fail(error.to_string()))? {
        let path = entry.map_err(|error| fail(error.to_string()))?.path();
        if path.extension().is_some_and(|extension| extension == "app") {
            bundles.push(path);
        }
    }
    let [bundle] = bundles.as_slice() else {
        return Err(fail(format!(
            "the release holds {} application bundles, not one",
            bundles.len()
        )));
    };
    let got = platform.bundle_version(bundle).map_err(fail)?;
    if got != update.version {
        return Err(fail(format!(
            "the bundle version is {got}, not {}",
            update.version
        )));
    }
    Ok(bundle.clone())
}

/// The arguments of `sok app update`.
pub struct ReplaceOptions {
    /// The process of the application that quits for the update.
    pub pid: i32,
    /// The staged bundle of the new version.
    pub bundle: PathBuf,
    /// The bundle that the application runs from.
    pub target: PathBuf,
    /// The arguments of the application that starts again.
    pub arguments: Vec<String>,
    /// How long replace_app waits for the end of the process.
    pub timeout: std::time::Duration,
}

/// Whether the folder holds an application bundle, which has an Info.plist.
fn is_bundle(path: &Path) -> bool {
    path.join("Contents/Info.plist").is_file()
}

/// The path with a suffix added to its last part.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Removes a folder or a file if it exists.
fn remove(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Joins the failures of the steps of a replacement into one message.
fn joined(first: String, rest: Vec<Result<(), String>>) -> String {
    let mut text = first;
    for error in rest.into_iter().filter_map(Result::err) {
        text.push_str("; ");
        text.push_str(&error);
    }
    text
}

/// Starts the application bundle with arguments.
pub type OpenApplication<'a> = &'a dyn Fn(&Path, &[String]) -> Result<(), String>;

/// Replaces the bundle `target` with `bundle` after the process `pid` has ended and starts the application through
/// `open` (docs/spec/installation.md#application-update). It copies the new bundle beside the target first, so a
/// failure before the move leaves the target as it was, and it restores the earlier bundle and starts it when the new
/// one cannot start.
pub fn replace_app(options: &ReplaceOptions, open: OpenApplication) -> Result<(), String> {
    for (name, path) in [("bundle", &options.bundle), ("target", &options.target)] {
        if !is_bundle(path) {
            return Err(format!(
                "application update: the {name} {} is not an application bundle",
                path.display()
            ));
        }
    }
    if options.bundle == options.target {
        return Err(format!(
            "application update: the bundle and the target are the same folder {}",
            options.target.display()
        ));
    }
    let platform = crate::platform::current()?;
    if !platform
        .wait_process_end(options.pid, options.timeout)
        .map_err(|error| format!("application update: {error}"))?
    {
        return Err(format!(
            "application update: process {} did not end within {:?}",
            options.pid, options.timeout
        ));
    }
    let (next, previous) = (
        beside(&options.target, ".new"),
        beside(&options.target, ".previous"),
    );
    for stale in [&next, &previous] {
        remove(stale).map_err(|error| format!("application update: {error}"))?;
    }
    if let Err(error) = platform.copy_bundle(&options.bundle, &next) {
        return Err(joined(
            format!("application update: copy the bundle: {error}"),
            vec![remove(&next)],
        ));
    }
    if let Err(error) = std::fs::rename(&options.target, &previous) {
        return Err(joined(
            format!("application update: move the target aside: {error}"),
            vec![remove(&next)],
        ));
    }
    if let Err(error) = std::fs::rename(&next, &options.target) {
        return Err(joined(
            format!("application update: move the new bundle: {error}"),
            vec![
                std::fs::rename(&previous, &options.target).map_err(|error| error.to_string()),
                remove(&next),
            ],
        ));
    }
    if let Err(error) = open(&options.target, &options.arguments) {
        let restored = remove(&options.target)
            .and_then(|()| {
                std::fs::rename(&previous, &options.target).map_err(|error| error.to_string())
            })
            .and_then(|()| open(&options.target, &options.arguments));
        return Err(joined(
            format!("application update: start the new bundle: {error}"),
            vec![restored],
        ));
    }
    let rest = vec![remove(&previous), remove(&options.bundle)];
    if rest.iter().any(Result::is_err) {
        return Err(joined("application update: the application started and the earlier files were not all removed".into(), rest));
    }
    Ok(())
}

/// Runs `sok app update --wait <pid> --bundle <path> --target <path> [-- <argument>...]`.
pub(crate) fn run_app(
    args: &[String],
    stdout: &mut dyn std::io::Write,
) -> Result<(), crate::Error> {
    if args.first().map(String::as_str) != Some("update") {
        return Err(crate::Error::Usage(format!(
            "unknown command: app {}",
            args.join(" ")
        )));
    }
    let mut rest = &args[1..];
    let mut arguments = vec![];
    if let Some(at) = rest.iter().position(|arg| arg == "--") {
        arguments = rest[at + 1..].to_vec();
        rest = &rest[..at];
    }
    let parsed = crate::parse_arguments(rest)?;
    if let Some(extra) = parsed.positionals.first() {
        return Err(crate::Error::Usage(format!("unexpected argument {extra}")));
    }
    let pid: i32 = parsed
        .required("wait")?
        .parse()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| crate::Error::Usage("--wait must be the pid of a process".into()))?;
    let options = ReplaceOptions {
        pid,
        bundle: PathBuf::from(parsed.required("bundle")?),
        target: PathBuf::from(parsed.required("target")?),
        arguments,
        timeout: std::time::Duration::from_secs(60),
    };
    let platform = crate::platform::current()?;
    replace_app(&options, &|bundle, arguments| {
        platform.open_application(bundle, arguments)
    })?;
    crate::release::print_json(
        stdout,
        &serde_json::json!({"target": options.target.display().to_string()}),
    )?;
    Ok(())
}
