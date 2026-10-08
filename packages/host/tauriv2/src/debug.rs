//! The debug view lists, records and saves the diagnostic files of the application, which are all under
//! `<config-dir>/logs/` (docs/spec/debug.md).

use std::fs::File;
use std::io::Write;
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;

/// A file under `<config-dir>/logs/`: its path relative to the configuration folder, its size in bytes and its
/// modification time in milliseconds since the epoch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DebugFile {
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

/// Every file under `<config-dir>/logs/`, sorted by path.
pub fn list(config: &Path) -> Result<Vec<DebugFile>, String> {
    let mut files = Vec::new();
    let root = config.join("logs");
    let mut folders = vec![root];
    while let Some(folder) = folders.pop() {
        let entries = std::fs::read_dir(&folder)
            .map_err(|error| format!("debug: list {}: {error}", folder.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("debug: list {}: {error}", folder.display()))?;
            let full = entry.path();
            let metadata = entry
                .metadata()
                .map_err(|error| format!("debug: {}: {error}", full.display()))?;
            if metadata.is_dir() {
                folders.push(full);
                continue;
            }
            let relative = full
                .strip_prefix(config)
                .map_err(|error| format!("debug: {}: {error}", full.display()))?;
            let modified = metadata
                .modified()
                .and_then(|time| {
                    time.duration_since(UNIX_EPOCH)
                        .map_err(std::io::Error::other)
                })
                .map_err(|error| format!("debug: {}: {error}", full.display()))?;
            files.push(DebugFile {
                path: relative.to_string_lossy().replace('\\', "/"),
                size: metadata.len(),
                modified: modified.as_millis() as u64,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// The full path of the file `relative` under `<config-dir>/logs/`, or an error that names it.
fn log_file(config: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let refused = || format!("debug: {relative} is not a file under logs/");
    let path = Path::new(relative);
    let mut components = path.components();
    if components.next() != Some(Component::Normal("logs".as_ref()))
        || !components.all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(refused());
    }
    let full = config.join(path);
    match std::fs::metadata(&full) {
        Ok(metadata) if metadata.is_file() => Ok(full),
        _ => Err(refused()),
    }
}

/// Copies the file `relative` under `<config-dir>/logs/` to destination.
pub fn copy(config: &Path, relative: &str, destination: &Path) -> Result<(), String> {
    let source = log_file(config, relative)?;
    std::fs::copy(&source, destination).map_err(|error| {
        format!(
            "debug: copy {relative} to {}: {error}",
            destination.display()
        )
    })?;
    Ok(())
}

/// Writes every file under `<config-dir>/logs/` into a gzip-compressed tar file at destination, with the paths of
/// [`list`].
pub fn write_logs_tar(config: &Path, destination: &Path) -> Result<(), String> {
    let listed = list(config)?;
    let out = File::create(destination)
        .map_err(|error| format!("debug: {}: {error}", destination.display()))?;
    let mut writer = tar::Builder::new(flate2::write::GzEncoder::new(
        out,
        flate2::Compression::default(),
    ));
    for file in &listed {
        let mut source = File::open(config.join(&file.path))
            .map_err(|error| format!("debug: {}: {error}", file.path))?;
        let mut header = tar::Header::new_gnu();
        header.set_size(file.size);
        header.set_mode(0o644);
        header.set_mtime(file.modified / 1000);
        header.set_entry_type(tar::EntryType::Regular);
        // A log that grows while the tar is written keeps the size of its header.
        writer
            .append_data(
                &mut header,
                &file.path,
                std::io::Read::take(&mut source, file.size),
            )
            .map_err(|error| format!("debug: {}: {error}", file.path))?;
    }
    let mut compressed = writer
        .into_inner()
        .map_err(|error| format!("debug: {}: {error}", destination.display()))?;
    compressed
        .flush()
        .map_err(|error| format!("debug: {}: {error}", destination.display()))?;
    compressed
        .finish()
        .map_err(|error| format!("debug: {}: {error}", destination.display()))?;
    Ok(())
}

/// The UTC time at in the form `YYYYMMDDTHHMMSSZ`.
fn debug_time(at: SystemTime) -> Result<String, String> {
    let iso = crate::performance::timestamp(at)?;
    // 2026-10-09T01:02:03.000Z
    Ok(format!(
        "{}{}{}T{}{}{}Z",
        &iso[0..4],
        &iso[5..7],
        &iso[8..10],
        &iso[11..13],
        &iso[14..16],
        &iso[17..19]
    ))
}

/// Writes state with its time into `<config-dir>/logs/state-<time>.json` and returns its path relative to the
/// configuration folder.
pub fn write_state(config: &Path, at: SystemTime, state: Value) -> Result<String, String> {
    let stamp = debug_time(at)?;
    let mut record = match state {
        Value::Object(map) => map,
        other => return Err(format!("debug: state must be an object, not {other}")),
    };
    record.insert("time".to_string(), json!(stamp));
    let relative = format!("logs/state-{stamp}.json");
    let full = config.join(&relative);
    std::fs::create_dir_all(full.parent().expect("logs/ is the parent"))
        .map_err(|error| format!("debug: {relative}: {error}"))?;
    let text = serde_json::to_vec_pretty(&Value::Object(record))
        .map_err(|error| format!("debug: state: {error}"))?;
    std::fs::write(&full, text).map_err(|error| format!("debug: {relative}: {error}"))?;
    Ok(relative)
}

/// The argument of the debugRecord call: the status values that the page collected.
#[derive(Debug, Deserialize)]
pub struct RecordRequest {
    pub page: Value,
}

/// The argument of the debugSave call.
#[derive(Debug, Deserialize)]
pub struct SaveRequest {
    pub path: String,
}

/// The answer of debugSave and debugSaveAll: the chosen path, or `None` when the person cancelled.
#[derive(Debug, Serialize)]
pub struct Saved {
    pub saved: Option<String>,
}

/// The configuration folder of the application.
fn config(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::workspace::Workspace>()
        .directory()
        .to_path_buf()
}

/// The page's debugRecord call: writes the state file of every window and, in a diagnostic build, a still capture of
/// each window.
pub(crate) fn record(app: &AppHandle, request: RecordRequest) -> Result<Value, String> {
    let mut windows = Vec::new();
    let entries = crate::windows::list(app)?;
    let entries = entries
        .as_array()
        .ok_or_else(|| format!("debug: windows.list answered {entries}, not a list"))?;
    for entry in entries.iter().cloned() {
        let label = entry["window"]
            .as_str()
            .ok_or_else(|| format!("debug: windows.list entry {entry} has no window"))?
            .to_string();
        let mut record = serde_json::Map::new();
        record.insert("entry".to_string(), entry);
        for name in ["host.window", "host.sidecars", "host.screens"] {
            let value = match app.get_window(&label) {
                Some(window) => crate::exposure::host_status(&window, name)
                    // default: a value that cannot be read is recorded with its error, because the state file keeps every other value.
                    .unwrap_or_else(|error| json!({"error": error})),
                None => json!({"error": format!("window {label} does not exist")}),
            };
            record.insert(name.to_string(), value);
        }
        windows.push(Value::Object(record));
    }
    let macos = crate::platform::current()
        .and_then(|platform| platform.os_version())
        .map(Value::String)
        // default: a value that cannot be read is recorded with its error, because the state file keeps every other value.
        .unwrap_or_else(|error| json!({"error": error}));
    let directory = config(app);
    let installed = std::fs::read(directory.join("plugins").join("installed.json"))
        .map_err(|error| error.to_string())
        .and_then(|data| serde_json::from_slice::<Value>(&data).map_err(|error| error.to_string()))
        // default: a value that cannot be read is recorded with its error, because the state file keeps every other value.
        .unwrap_or_else(|error| json!({"error": error}));
    let path = write_state(
        &directory,
        SystemTime::now(),
        json!({
            "host": "tauriv2",
            "versions": {"core": soksak_sok::version::CORE_VERSION, "macos": macos, "installed": installed},
            "windows": windows,
            "page": request.page,
        }),
    )?;
    #[cfg(feature = "diagnostics")]
    {
        let captures = crate::diagnostics::capture_windows(app)
            .map_err(|error| format!("debug: captures: {error}"))?;
        Ok(json!({"path": path, "captures": captures}))
    }
    #[cfg(not(feature = "diagnostics"))]
    Ok(json!({"path": path}))
}

/// Shows the save panel with name attached to window and returns the chosen path, or `None` when the person
/// cancelled.
fn save_to(window: &Window, name: &str) -> Result<Option<std::path::PathBuf>, String> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_file_name(name)
        .blocking_save_file()
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("debug: save panel: {error}"))
        })
        .transpose()
}

/// The page's debugSave call: saves one file of the logs folder where the person chooses.
pub(crate) fn save(window: &Window, request: SaveRequest) -> Result<Saved, String> {
    let directory = config(window.app_handle());
    log_file(&directory, &request.path)?;
    let name = Path::new(&request.path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| format!("debug: {} is not a file under logs/", request.path))?;
    let Some(chosen) = save_to(window, &name)? else {
        return Ok(Saved { saved: None });
    };
    copy(&directory, &request.path, &chosen)?;
    Ok(Saved {
        saved: Some(chosen.to_string_lossy().into_owned()),
    })
}

/// The page's debugSaveAll call: saves the logs folder as one gzip-compressed tar file.
pub(crate) fn save_all(window: &Window) -> Result<Saved, String> {
    let name = format!(
        "soksak-tauriv2-debug-{}.tar.gz",
        debug_time(SystemTime::now())?
    );
    let Some(chosen) = save_to(window, &name)? else {
        return Ok(Saved { saved: None });
    };
    write_logs_tar(&config(window.app_handle()), &chosen)?;
    Ok(Saved {
        saved: Some(chosen.to_string_lossy().into_owned()),
    })
}
