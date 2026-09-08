use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, Map, json};
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Manager};

pub(crate) struct Workspace { directory: PathBuf, writing: Mutex<()> }
#[derive(Deserialize)]
pub(crate) struct Request {
    kind: String,
    id: Option<String>,
    project: Option<Value>,
    patch: Option<Map<String, Value>>,
    remove: Option<Vec<String>>,
    delta: Option<i64>,
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
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.write_all(b"\n").map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

impl Workspace {
    pub fn new(directory: PathBuf) -> Self { Self { directory, writing: Mutex::new(()) } }
    fn apply(&self, req: Request) -> Result<Value, String> {
        let _writing = self.writing.lock().map_err(|e| e.to_string())?;
        let registry = self.directory.join("projects.json");
        let mut projects: Vec<Value> = read(&registry)?;
        for project in &projects {
            let id = project["id"].as_str().ok_or("invalid project id")?;
            if id.is_empty() || !id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                || project["root"].as_str().is_none_or(str::is_empty) || project["identity"].as_str().is_none_or(str::is_empty) {
                return Err(format!("{}: invalid project record", registry.display()));
            }
        }
        let at = projects.iter().position(|p| p["id"].as_str() == req.id.as_deref());
        match req.kind.as_str() {
            "snapshot" => {
                let common: Map<String, Value> = read(&self.directory.join("settings.json"))?;
                for project in &mut projects {
                    let path = Path::new(project["root"].as_str().ok_or("invalid project root")?).join(".soksak/settings.json");
                    let settings: Map<String, Value> = read(&path)?;
                    if settings.contains_key("projectOpening") { return Err(format!("{}: projectOpening is common-only", path.display())); }
                    project["repository"] = Path::new(project["root"].as_str().unwrap()).join(".git").exists().into();
                    project["settings"] = settings.into();
                }
                return Ok(json!({"projects":projects, "common":common}));
            }
            "add" => {
                let mut project = req.project.ok_or("project is missing")?;
                if let Some(found) = projects.iter().find(|p| p["root"] == project["root"] || p["identity"] == project["identity"]) { return Ok(found.clone()); }
                project.as_object_mut().ok_or("invalid project")?.remove("settings");
                projects.push(project.clone());
                write(&registry, &projects)?;
                return Ok(project);
            }
            "patch" => {
                let Some(at) = at else { return Ok(false.into()) };
                for (key,value) in req.patch.unwrap_or_default() {
                    if !["title", "color", "spaces", "activeSpaceId", "named", "geometry", "pinned", "lastOpened"].contains(&key.as_str()) { return Err(format!("invalid project field: {key}")); }
                    projects[at][key] = value;
                }
            }
            "remove" => { if let Some(at) = at { projects.remove(at); } }
            "move" => {
                let Some(at) = at else { return Ok(Value::Null) };
                let to = at as i64 + req.delta.ok_or("move delta is missing")?;
                if to < 0 || to >= projects.len() as i64 { return Ok(Value::Null) }
                let project = projects.remove(at);
                projects.insert(to as usize, project);
            }
            "settings" => {
                let patch = req.patch.unwrap_or_default();
                let path = if req.id.is_some() {
                    let at = at.ok_or("unknown project")?;
                    if patch.contains_key("projectOpening") { return Err("projectOpening is common-only".into()) }
                    Path::new(projects[at]["root"].as_str().ok_or("invalid project root")?).join(".soksak/settings.json")
                } else { self.directory.join("settings.json") };
                let mut settings: Map<String, Value> = read(&path)?;
                settings.extend(patch);
                for key in req.remove.unwrap_or_default() { settings.remove(&key); }
                write(&path, &settings)?;
                return Ok(Value::Null);
            }
            _ => return Err(format!("unknown workspace operation: {}", req.kind)),
        }
        write(&registry, &projects)?;
        Ok(true.into())
    }
}

#[tauri::command(async)]
pub(crate) fn workspace(app: AppHandle, mut request: Request) -> Result<Value, String> {
    if request.kind == "add" {
        let project = request.project.as_mut().ok_or("project is missing")?;
        let folder = super::windows::project_folder(app.clone(), project["root"].as_str().ok_or("project directory is missing")?.into())?;
        let folder = serde_json::to_value(folder).map_err(|e| e.to_string())?;
        project["root"] = folder["root"].clone();
        project["identity"] = folder["identity"].clone();
    }
    let changed = request.kind != "snapshot";
    let mut result = app.state::<Workspace>().apply(request)?;
    if !changed { result["open"] = serde_json::to_value(super::windows::opened(&app)?).map_err(|e| e.to_string())?; }
    if changed {
        for window in app.windows().values() {
            super::windows::emit_window(window, "workspace-changed", ()).map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn apply(store: &Workspace, request: Value) -> Value {
        store.apply(serde_json::from_value(request).unwrap()).unwrap()
    }
    #[test]
    fn settings_use_common_and_project_files_and_reset_removes_override() {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = Workspace::new(config.path().into());
        apply(&store, json!({"kind":"add", "project":{"id":"prj-test", "root":root.path(), "identity":"1:2"}}));
        apply(&store, json!({"kind":"settings", "patch":{"mode":"light", "gap":6, "projectOpening":"windows"}}));
        apply(&store, json!({"kind":"settings", "id":"prj-test", "patch":{"gap":12}}));
        let project: Value = read(&root.path().join(".soksak/settings.json")).unwrap();
        assert_eq!(project, json!({"gap":12}));
        let reopened = Workspace::new(config.path().into());
        let snapshot = apply(&reopened, json!({"kind":"snapshot"}));
        assert_eq!(snapshot["common"]["mode"], "light");
        assert_eq!(snapshot["projects"][0]["settings"], json!({"gap":12}));
        apply(&store, json!({"kind":"settings", "id":"prj-test", "remove":["gap"]}));
        assert_eq!(read::<Value>(&root.path().join(".soksak/settings.json")).unwrap(), json!({}));
        assert!(store.apply(serde_json::from_value(json!({"kind":"settings", "id":"prj-test", "patch":{"projectOpening":"tabs"}})).unwrap()).is_err());
        fs::write(config.path().join("settings.json"), "{broken").unwrap();
        assert!(store.apply(serde_json::from_value(json!({"kind":"settings", "patch":{"gap":2}})).unwrap()).is_err());
        assert_eq!(fs::read_to_string(config.path().join("settings.json")).unwrap(), "{broken");
    }
    #[test]
    fn concurrent_updates_preserve_fields_and_saved_project_order() {
        let config = tempfile::tempdir().unwrap();
        let roots: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
        let store = std::sync::Arc::new(Workspace::new(config.path().into()));
        for (i, root) in roots.iter().enumerate() {
            apply(&store, json!({"kind":"add", "project":{"id":format!("p{i}"), "root":root.path(), "identity":i.to_string()}}));
        }
        let jobs: Vec<_> = ["mode", "theme", "rail"].iter().map(|key| {
            let store = store.clone();
            std::thread::spawn(move || apply(&store, json!({"kind":"settings", "patch":{key.to_string():key}})))
        }).collect();
        for job in jobs { job.join().unwrap(); }
        apply(&store, json!({"kind":"move", "id":"p2", "delta":-2}));
        let snapshot = apply(&store, json!({"kind":"snapshot"}));
        assert_eq!(snapshot["common"].as_object().unwrap().len(), 3);
        assert_eq!(snapshot["projects"][0]["id"], "p2");
        apply(&store, json!({"kind":"remove", "id":"p2"}));
        assert_eq!(apply(&store, json!({"kind":"snapshot"}))["projects"][0]["id"], "p0");
    }
    #[cfg(unix)]
    #[test]
    fn directory_aliases_have_one_identity() {
        let root = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let alias = parent.path().join("alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        let first = serde_json::to_value(crate::windows::folder(root.path().to_str().unwrap(), root.path()).unwrap()).unwrap();
        let second = serde_json::to_value(crate::windows::folder(alias.to_str().unwrap(), root.path()).unwrap()).unwrap();
        assert_eq!(first, second);
        let file = root.path().join("file");
        fs::write(&file, "x").unwrap();
        assert!(crate::windows::folder(file.to_str().unwrap(), root.path()).is_err());
    }
}
