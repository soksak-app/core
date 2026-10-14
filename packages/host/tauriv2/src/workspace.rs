//! The common settings, the project settings and the project list store.
//!
//! `projects.json` in the configuration directory is the project list and `settings.json` is the common settings. The
//! project settings are stored in `.soksak/settings.json` of the project directory.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager};

use crate::projects::project_folder;
use crate::windows::{emit_window, opened};

/// Creates the configuration directory and returns the canonical path. An empty path is rejected and not replaced with
/// the current directory. create creates a missing directory with permissions for the current user only
/// (`Platform::create_private_directories`).
pub fn prepare_config_directory(
    path: &Path,
    create: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("config directory is required".into());
    }
    create(path)?;
    path.canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// The common settings that a project setting cannot override (docs/spec/projects.md#persistence). The host sets the
/// window title bar from textSize of the common settings before the page starts
/// (docs/spec/native-surfaces.md#title-bar-height).
const COMMON_ONLY: [&str; 2] = ["projectOpening", "textSize"];

/// The store of one configuration directory. Write requests run in order.
pub struct Workspace {
    directory: PathBuf,
    writing: Mutex<()>,
}

/// A store request. kind is one of snapshot, add, patch, remove, move and settings.
#[derive(Deserialize)]
pub struct Request {
    kind: String,
    id: Option<String>,
    #[serde(default, deserialize_with = "crate::arguments::optional_object")]
    project: Option<Value>,
    patch: Option<Map<String, Value>>,
    remove: Option<Vec<String>>,
    delta: Option<i64>,
}

/// Reads the projects of projects.json, which holds them under the `projects` member beside the format member of the
/// stored form (docs/spec/installation.md#stored-data-migration).
fn read_projects(path: &Path) -> Result<Vec<Value>, String> {
    #[derive(Default, Deserialize)]
    struct Document {
        #[serde(default)]
        projects: Vec<Value>,
    }
    Ok(read::<Document>(path)?.projects)
}

/// Writes the projects under the `projects` member with the format member of the current form.
fn write_projects(path: &Path, projects: &[Value]) -> Result<(), String> {
    let document = serde_json::json!({
        "format": soksak_sok::migrate::projects_format(),
        "projects": projects,
    });
    write(path, &document)
}

fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let dir = path.parent().ok_or("settings file has no parent")?;
    crate::platform::current()?.create_private_directories(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.write_all(b"\n").map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

impl Workspace {
    /// Creates a store that uses directory as the configuration directory.
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writing: Mutex::new(()),
        }
    }

    /// The configuration directory.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Runs a request and returns the result.
    ///
    /// snapshot returns the project list (including the settings of each project) and the common settings. add adds a
    /// project or returns the existing project with the same root or identity. settings returns null, patch of a
    /// missing project returns false, move out of range returns null, and the others return true. When a file cannot be
    /// read, it returns an error without changing the file.
    pub fn apply(&self, req: Request) -> Result<Value, String> {
        let _writing = self.writing.lock().map_err(|e| e.to_string())?;
        let registry = self.directory.join("projects.json");
        // The entry of the shared reader of projects.json migrates it to the current format first.
        soksak_sok::migrate::migrate_projects(&self.directory)?;
        let mut projects: Vec<Value> = read_projects(&registry)?;
        for project in &projects {
            let id = project["id"].as_str().ok_or("invalid project id")?;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                || project["root"].as_str().is_none_or(str::is_empty)
                || project["identity"].as_str().is_none_or(str::is_empty)
            {
                return Err(format!("{}: invalid project record", registry.display()));
            }
        }
        let at = projects
            .iter()
            .position(|p| p["id"].as_str() == req.id.as_deref());
        match req.kind.as_str() {
            "snapshot" => {
                // The entry of the shared reader of settings.json migrates it to the current format first
                // (docs/spec/installation.md#stored-data-migration).
                soksak_sok::migrate::migrate_settings(&self.directory)?;
                let mut common: Map<String, Value> = read(&self.directory.join("settings.json"))?;
                for project in &mut projects {
                    let path = Path::new(project["root"].as_str().ok_or("invalid project root")?)
                        .join(".soksak/settings.json");
                    // The project settings file migrates at its first read like the common one.
                    soksak_sok::migrate::migrate_settings(
                        path.parent().ok_or("invalid project root")?,
                    )?;
                    let mut settings: Map<String, Value> = read(&path)?;
                    if let Some(key) = COMMON_ONLY.iter().find(|key| settings.contains_key(**key)) {
                        return Err(format!("{}: {key} is common-only", path.display()));
                    }
                    // The format member is the carrier of the stored form, not a setting, so the snapshot does not show
                    // it (docs/spec/installation.md#stored-data-migration).
                    settings.remove("format");
                    project["settings"] = settings.into();
                }
                common.remove("format");
                return Ok(json!({"projects": projects, "common": common}));
            }
            "add" => {
                let mut project = req.project.ok_or("project is missing")?;
                if let Some(found) = projects
                    .iter()
                    .find(|p| p["root"] == project["root"] || p["identity"] == project["identity"])
                {
                    return Ok(found.clone());
                }
                project
                    .as_object_mut()
                    .ok_or("invalid project")?
                    .remove("settings");
                projects.push(project.clone());
                write_projects(&registry, &projects)?;
                return Ok(project);
            }
            "patch" => {
                let Some(at) = at else {
                    return Ok(false.into());
                };
                // default: patch of a request is an optional argument, and when it is absent there is no value to
                // change.
                for (key, value) in req.patch.unwrap_or_default() {
                    if ![
                        "title",
                        "color",
                        "spaces",
                        "activeSpaceId",
                        "named",
                        "geometry",
                        "pinned",
                        "lastOpened",
                        "plugins",
                    ]
                    .contains(&key.as_str())
                    {
                        return Err(format!("invalid project field: {key}"));
                    }
                    projects[at][key] = value;
                }
            }
            "remove" => {
                if let Some(at) = at {
                    projects.remove(at);
                }
            }
            "move" => {
                let Some(at) = at else { return Ok(Value::Null) };
                let to = at as i64 + req.delta.ok_or("move delta is missing")?;
                if to < 0 || to >= projects.len() as i64 {
                    return Ok(Value::Null);
                }
                let project = projects.remove(at);
                projects.insert(to as usize, project);
            }
            "settings" => {
                // default: patch of a request is an optional argument, and when it is absent there is no value to
                // change.
                let patch = req.patch.unwrap_or_default();
                let path = if req.id.is_some() {
                    let at = at.ok_or("unknown project")?;
                    if let Some(key) = COMMON_ONLY.iter().find(|key| patch.contains_key(**key)) {
                        return Err(format!("{key} is common-only"));
                    }
                    Path::new(
                        projects[at]["root"]
                            .as_str()
                            .ok_or("invalid project root")?,
                    )
                    .join(".soksak/settings.json")
                } else {
                    self.directory.join("settings.json")
                };
                let mut settings: Map<String, Value> = read(&path)?;
                let mut set: Vec<String> = patch.keys().cloned().collect();
                settings.extend(patch);
                let mut removed = vec![];
                // default: the member remove of the request is optional, and without it there is no key to remove.
                for key in req.remove.unwrap_or_default() {
                    if settings.remove(&key).is_some() {
                        removed.push(key);
                    }
                }
                write(&path, &settings)?;
                set.sort();
                removed.sort();
                crate::event_record::emit_host(
                    crate::event_log::Level::Info,
                    "host.workspace.settings",
                    json!({
                        // default: a request without a project id changes the common settings.
                        "scope": req.id.as_deref().unwrap_or("common"),
                        "set": set.join(","),
                        "removed": removed.join(","),
                    }),
                );
                return Ok(Value::Null);
            }
            _ => return Err(format!("unknown workspace operation: {}", req.kind)),
        }
        write_projects(&registry, &projects)?;
        Ok(true.into())
    }
}

/// Runs a store request of the page.
///
/// add replaces the project path with the checked canonical path and identifier. snapshot adds the project ids open in
/// the window to open. After a request that changes data, workspace-changed is sent to all windows.
pub(crate) fn handle(app: &AppHandle, mut request: Request) -> Result<Value, String> {
    if request.kind == "add" {
        let project = request.project.as_mut().ok_or("project is missing")?;
        let folder = project_folder(
            app,
            project["root"]
                .as_str()
                .ok_or("project directory is missing")?
                .into(),
        )?;
        let folder = serde_json::to_value(folder).map_err(|e| e.to_string())?;
        project["root"] = folder["root"].clone();
        project["identity"] = folder["identity"].clone();
    }
    let changed = request.kind != "snapshot";
    let mut result = app.state::<Workspace>().apply(request)?;
    if !changed {
        result["open"] = serde_json::to_value(opened(app)?).map_err(|e| e.to_string())?;
    }
    if changed {
        for window in app.windows().values() {
            emit_window(window, "workspace-changed", ()).map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}
