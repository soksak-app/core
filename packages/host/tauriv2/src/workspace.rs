//! 공통 설정, 프로젝트 설정, 프로젝트 목록 저장소.
//!
//! 설정 디렉터리의 `projects.json` 은 프로젝트 목록, `settings.json` 은 공통 설정이다. 프로젝트
//! 설정은 프로젝트 디렉터리의 `.soksak/settings.json` 에 저장한다.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::projects::project_folder;
use crate::windows::{emit_window, opened};

/// 설정 디렉터리를 만들고 정규 경로를 반환한다. 빈 경로는 현재 디렉터리로 바꾸지 않고 거부한다.
/// create 는 없는 디렉터리를 현재 사용자 전용 권한으로 만든다(`Platform::create_private_directories`).
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

/// 프로젝트 설정이 덮어쓸 수 없는 공통 설정(docs/spec/projects.md#persistence). 호스트는 페이지 시작 전에 공통 설정의
/// textSize 로 창 제목줄을 정한다(docs/spec/native-surfaces.md#title-bar-height).
const COMMON_ONLY: [&str; 2] = ["projectOpening", "textSize"];

/// 설정 디렉터리 하나의 저장소. 쓰기 요청은 순서대로 실행한다.
pub struct Workspace {
    directory: PathBuf,
    writing: Mutex<()>,
}

/// 저장소 요청. kind 는 snapshot, add, patch, remove, move, settings 중 하나이다.
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
    /// directory 를 설정 디렉터리로 사용하는 저장소를 만든다.
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writing: Mutex::new(()),
        }
    }

    /// 설정 디렉터리.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// 요청을 실행하고 결과를 반환한다.
    ///
    /// snapshot 은 프로젝트 목록(각 프로젝트의 settings 포함)과 공통 설정을 반환한다. add 는
    /// 추가하거나 같은 root 또는 identity 의 기존 프로젝트를 반환한다. settings 는 null 을,
    /// 없는 프로젝트의 patch 는 false 를, 범위를 벗어난 move 는 null 을, 나머지는 true 를
    /// 반환한다. 파일을 읽지 못하면 파일을 바꾸지 않고 오류를 반환한다.
    pub fn apply(&self, req: Request) -> Result<Value, String> {
        let _writing = self.writing.lock().map_err(|e| e.to_string())?;
        let registry = self.directory.join("projects.json");
        let mut projects: Vec<Value> = read(&registry)?;
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
                let common: Map<String, Value> = read(&self.directory.join("settings.json"))?;
                for project in &mut projects {
                    let path = Path::new(project["root"].as_str().ok_or("invalid project root")?)
                        .join(".soksak/settings.json");
                    let settings: Map<String, Value> = read(&path)?;
                    if let Some(key) = COMMON_ONLY.iter().find(|key| settings.contains_key(**key)) {
                        return Err(format!("{}: {key} is common-only", path.display()));
                    }
                    project["settings"] = settings.into();
                }
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
                write(&registry, &projects)?;
                return Ok(project);
            }
            "patch" => {
                let Some(at) = at else {
                    return Ok(false.into());
                };
                // 기본값: 요청의 patch 는 선택 인자이며 없으면 바꿀 값이 없다.
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
                // 기본값: 요청의 patch 는 선택 인자이며 없으면 바꿀 값이 없다.
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
                settings.extend(patch);
                // 기본값: 요청의 remove 는 선택 인자이며 없으면 지울 키가 없다.
                for key in req.remove.unwrap_or_default() {
                    settings.remove(&key);
                }
                write(&path, &settings)?;
                return Ok(Value::Null);
            }
            _ => return Err(format!("unknown workspace operation: {}", req.kind)),
        }
        write(&registry, &projects)?;
        Ok(true.into())
    }
}

/// 페이지의 저장소 요청을 실행한다.
///
/// add 는 프로젝트 경로를 확인한 정규 경로와 식별값으로 바꾼다. snapshot 은 창에 열린 프로젝트
/// id 를 open 에 추가한다. 변경 요청 뒤에는 모든 창에 workspace-changed 를 보낸다.
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
