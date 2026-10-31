//! The common settings, the project settings and the project list store.
//!
//! `projects.json` in the configuration directory is the project list and `settings.json` is the common settings. The
//! project settings are stored in `.soksak/settings.json` of the project directory.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Deserialize;
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

/// A store request. kind is one of snapshot, add, patch, remove, move, settings, tabState, tabStatePut, tabSession,
/// tabSessionPut and tabSessions.
#[derive(Deserialize)]
pub struct Request {
    kind: String,
    id: Option<String>,
    #[serde(default, deserialize_with = "crate::arguments::optional_object")]
    project: Option<Value>,
    patch: Option<Map<String, Value>>,
    remove: Option<Vec<String>>,
    delta: Option<i64>,
    tab: Option<String>,
    entry: Option<Map<String, Value>>,
    regions: Option<Map<String, Value>>,
}

/// Reads the projects of projects.json, which holds them under the `projects` member beside the format member of the
/// stored form (docs/spec/installation.md#stored-data-formats).
fn read_projects(path: &Path) -> Result<Vec<Value>, String> {
    let Some(document) = read_stored(path, "projects.json", PROJECTS_FORMAT)? else {
        return Ok(vec![]);
    };
    let projects = document
        .get("projects")
        .cloned()
        .unwrap_or_else(|| json!([])); // default: a projects.json without the projects member holds no project.
    serde_json::from_value(projects).map_err(|e| format!("{}: {e}", path.display()))
}

/// Returns the projects when every record has an id, a root and an identity, or the error that names projects.json.
fn check_projects(registry: &Path, projects: Vec<Value>) -> Result<Vec<Value>, String> {
    for project in &projects {
        let valid = project["id"].as_str().is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        }) && project["root"]
            .as_str()
            .is_some_and(|root| !root.is_empty())
            && project["identity"]
                .as_str()
                .is_some_and(|identity| !identity.is_empty());
        if !valid {
            return Err(format!("{}: invalid project record", registry.display()));
        }
    }
    Ok(projects)
}

/// The project list with the settings of each project, and the common settings. A refused projects.json is reported as
/// projectsError with no project and a refused settings.json as settingsError with no common setting, so the page starts
/// and shows each error; every write reads the file again and fails with its error without changing it
/// (docs/spec/projects.md#settings).
fn snapshot(directory: &Path, listed: Result<Vec<Value>, String>) -> Result<Value, String> {
    let mut document = Map::new();
    let mut projects = match listed {
        Ok(projects) => projects,
        Err(error) => {
            document.insert("projectsError".into(), error.into());
            vec![]
        }
    };
    let mut common = match read_stored(
        &directory.join("settings.json"),
        "settings.json",
        SETTINGS_FORMAT,
    ) {
        Ok(common) => common.unwrap_or_default(), // default: a missing settings.json holds no common settings.
        Err(error) => {
            document.insert("settingsError".into(), error.into());
            Map::new()
        }
    };
    for project in &mut projects {
        let path = Path::new(project["root"].as_str().ok_or("invalid project root")?)
            .join(".soksak/settings.json");
        // A project settings file that is refused is reported at its project, which the page does not open, so the other
        // projects and the page start (docs/spec/projects.md#settings).
        match project_settings(&path) {
            Ok(settings) => project["settings"] = settings.into(),
            Err(error) => project["settingsError"] = error.into(),
        }
    }
    common.remove("format");
    document.insert("projects".into(), projects.into());
    document.insert("common".into(), common.into());
    Ok(Value::Object(document))
}

/// Reads the overrides of the project settings file at path; a missing file holds no override.
fn project_settings(path: &Path) -> Result<Map<String, Value>, String> {
    let mut settings = read_stored(path, "settings.json", SETTINGS_FORMAT)?.unwrap_or_default(); // default: a missing project settings file holds no overrides.
    if let Some(key) = COMMON_ONLY.iter().find(|key| settings.contains_key(**key)) {
        return Err(format!("{}: {key} is common-only", path.display()));
    }
    // The format member is the carrier of the stored form, not a setting, so the snapshot does not show it
    // (docs/spec/installation.md#stored-data-formats).
    settings.remove("format");
    Ok(settings)
}

/// The current format numbers of the stored files that the host writes (docs/spec/installation.md#stored-data-formats).
pub(crate) const PROJECTS_FORMAT: u64 = 1;
pub(crate) const SETTINGS_FORMAT: u64 = 1;

/// Writes the projects under the `projects` member with the format member of the current form.
fn write_projects(path: &Path, projects: &[Value]) -> Result<(), String> {
    let format = PROJECTS_FORMAT;
    let document = serde_json::json!({
        "format": format,
        "projects": projects,
    });
    write(path, &document)
}

/// Reads a stored file that carries its format in the member format. A missing file reads as None. A file that is not an
/// object, or whose format member is absent or another number, is refused with the file and the number it requires
/// (docs/spec/installation.md#stored-data-formats).
fn read_stored(path: &Path, name: &str, format: u64) -> Result<Option<Map<String, Value>>, String> {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let value: Value =
        serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    let refusal = || format!("{}: {name}: format must be {format}", path.display());
    let document = value.as_object().ok_or_else(refusal)?;
    if document.get("format").and_then(Value::as_f64) != Some(format as f64) {
        return Err(refusal());
    }
    Ok(Some(document.clone()))
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

/// The format of tab-state.json, the tab state store of the memory saver (docs/spec/projects.md#persistence).
const TAB_STATE_FORMAT: u64 = 1;

/// Returns the document of tab-state.json as stored, or null when the file does not exist; a document of another format
/// is refused with the path of the file.
fn read_tab_state(path: &Path) -> Result<Value, String> {
    Ok(read_stored(path, "tab-state.json", TAB_STATE_FORMAT)?.map_or(Value::Null, Value::Object))
}

/// Sets the entry of tab, or removes it when entry is None, in tab-state.json and returns the size of the written
/// file. Each put changes one entry, so windows that write different tabs keep each other's entries.
fn put_tab_state(
    path: &Path,
    tab: &str,
    entry: Option<Map<String, Value>>,
) -> Result<Value, String> {
    if tab.is_empty() {
        return Err("tab state put requires a tab".into());
    }
    if let Some(entry) = &entry {
        check_tab_state_entry(tab, entry)?;
    }
    let mut tabs = Map::new();
    if let Some(document) = read_stored(path, "tab-state.json", TAB_STATE_FORMAT)? {
        tabs = document
            .get("tabs")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{}: tab state tabs is not an object", path.display()))?
            .clone();
    }
    match entry {
        Some(entry) => {
            tabs.insert(tab.into(), Value::Object(entry));
        }
        None => {
            tabs.remove(tab);
        }
    }
    write(path, &json!({"format": TAB_STATE_FORMAT, "tabs": tabs}))?;
    let size = fs::metadata(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len();
    Ok(size.into())
}

/// Refuses an entry that is empty or holds a field other than state {format, value}, kept true and a label of 1 to 256
/// characters; the first invalid field in name order is named.
fn check_tab_state_entry(tab: &str, entry: &Map<String, Value>) -> Result<(), String> {
    if entry.is_empty() {
        return Err(format!("invalid tab state entry of {tab}: empty"));
    }
    let mut keys: Vec<&String> = entry.keys().collect();
    keys.sort();
    for key in keys {
        let value = &entry[key];
        let valid = match key.as_str() {
            "kept" => value == &Value::Bool(true),
            "label" => value
                .as_str()
                .is_some_and(|text| !text.is_empty() && text.chars().count() <= 256),
            "state" => value.as_object().is_some_and(|state| {
                state.len() == 2
                    && state.contains_key("value")
                    && state
                        .get("format")
                        .and_then(Value::as_f64)
                        .is_some_and(|format| format >= 1.0 && format.fract() == 0.0)
            }),
            _ => false,
        };
        if !valid {
            return Err(format!("invalid tab state entry of {tab}: {key}"));
        }
    }
    Ok(())
}

/// The format of tab-sessions/<tab>.json, the session history of the document regions of one tab
/// (docs/spec/projects.md#persistence).
const TAB_SESSION_FORMAT: u64 = 1;

/// Whether tab is an identifier: lowercase letters, digits and hyphens.
fn valid_tab(tab: &str) -> bool {
    !tab.is_empty()
        && tab
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// The session file of tab in directory, or an error for a tab that is not an identifier.
fn tab_session_path(directory: &Path, tab: &str) -> Result<PathBuf, String> {
    if tab.is_empty() {
        return Err("tab session requires a tab".into());
    }
    if !valid_tab(tab) {
        return Err(format!("invalid tab session tab: {tab}"));
    }
    Ok(directory.join("tab-sessions").join(format!("{tab}.json")))
}

/// Returns the document of the session file of tab, or null when the file does not exist; a document of another
/// format or without a regions object is refused with the path of the file.
fn read_tab_session(directory: &Path, tab: &str) -> Result<Value, String> {
    let path = tab_session_path(directory, tab)?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let Some(document) = read_stored(
        &path,
        &format!("tab-sessions/{tab}.json"),
        TAB_SESSION_FORMAT,
    )?
    else {
        return Ok(Value::Null);
    };
    if !document.get("regions").is_some_and(Value::is_object) {
        return Err(format!(
            "{}: tab session regions is not an object",
            path.display()
        ));
    }
    Ok(Value::Object(document))
}

/// Replaces the session file of tab with regions and returns the size of the written file, or removes the file and
/// returns null when regions is None. Each tab has its own file, so a put rewrites no other tab.
fn put_tab_session(
    directory: &Path,
    tab: &str,
    regions: Option<Map<String, Value>>,
) -> Result<Value, String> {
    let path = tab_session_path(directory, tab)?;
    let Some(regions) = regions else {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("{}: {e}", path.display()))
            }
            _ => Ok(Value::Null),
        };
    };
    if regions.is_empty() {
        return Err(format!("invalid tab session of {tab}: empty"));
    }
    let mut names: Vec<&String> = regions.keys().collect();
    names.sort();
    for name in names {
        let valid = regions[name].as_object().is_some_and(|region| {
            region.len() == 1
                && region
                    .get("session")
                    .and_then(Value::as_str)
                    .is_some_and(|session| !session.is_empty())
        });
        if !valid {
            return Err(format!("invalid tab session region of {tab}: {name}"));
        }
    }
    write(
        &path,
        &json!({"format": TAB_SESSION_FORMAT, "regions": regions}),
    )?;
    let size = fs::metadata(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .len();
    Ok(size.into())
}

/// Returns the tabs that have a session file, in name order; an absent directory has none.
fn list_tab_sessions(directory: &Path) -> Result<Value, String> {
    let folder = directory.join("tab-sessions");
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!([])),
        Err(e) => return Err(format!("{}: {e}", folder.display())),
    };
    let mut tabs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", folder.display()))?;
        let is_file = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", folder.display()))?
            .is_file();
        let name = entry.file_name();
        if let Some(tab) = name.to_str().and_then(|name| name.strip_suffix(".json"))
            && is_file
            && valid_tab(tab)
        {
            tabs.push(tab.to_string());
        }
    }
    tabs.sort();
    Ok(json!(tabs))
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
        // default: a lock that a panicking thread poisoned still holds nothing, and each file write of the workspace
        // is atomic beside it; the panic hook records the panic.
        let _writing = self.writing.lock().unwrap_or_else(PoisonError::into_inner);
        match req.kind.as_str() {
            "tabState" => return read_tab_state(&self.directory.join("tab-state.json")),
            "tabStatePut" => {
                return put_tab_state(
                    &self.directory.join("tab-state.json"),
                    // default: a request without a tab is refused by put_tab_state with its own error.
                    req.tab.as_deref().unwrap_or_default(),
                    req.entry,
                );
            }
            "tabSession" => {
                // default: a request without a tab is refused by tab_session_path with its own error.
                return read_tab_session(&self.directory, req.tab.as_deref().unwrap_or_default());
            }
            "tabSessionPut" => {
                return put_tab_session(
                    &self.directory,
                    // default: a request without a tab is refused by tab_session_path with its own error.
                    req.tab.as_deref().unwrap_or_default(),
                    req.regions,
                );
            }
            "tabSessions" => return list_tab_sessions(&self.directory),
            _ => {}
        }
        let registry = self.directory.join("projects.json");
        let listed =
            read_projects(&registry).and_then(|projects| check_projects(&registry, projects));
        if req.kind == "snapshot" {
            return snapshot(&self.directory, listed);
        }
        let mut projects = listed?;
        let at = projects
            .iter()
            .position(|p| p["id"].as_str() == req.id.as_deref());
        match req.kind.as_str() {
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
                let mut settings =
                    read_stored(&path, "settings.json", SETTINGS_FORMAT)?.unwrap_or_default(); // default: a missing project settings file holds no overrides.
                let mut set: Vec<String> = patch.keys().cloned().collect();
                settings.extend(patch);
                let mut removed = vec![];
                // default: the member remove of the request is optional, and without it there is no key to remove.
                for key in req.remove.unwrap_or_default() {
                    if settings.remove(&key).is_some() {
                        removed.push(key);
                    }
                }
                settings.insert("format".into(), json!(SETTINGS_FORMAT));
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
    // The tab state store and the tab sessions change no project or setting, so no window is notified.
    let tab_state = matches!(
        request.kind.as_str(),
        "tabState" | "tabStatePut" | "tabSession" | "tabSessionPut" | "tabSessions"
    );
    let changed = request.kind != "snapshot" && !tab_state;
    let snapshot = request.kind == "snapshot";
    let mut result = app.state::<Workspace>().apply(request)?;
    if snapshot {
        result["open"] = serde_json::to_value(opened(app)?).map_err(|e| e.to_string())?;
    }
    if changed {
        for window in app.windows().values() {
            emit_window(window, "workspace-changed", ()).map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "workspace_lock_test.rs"]
mod lock_test;
