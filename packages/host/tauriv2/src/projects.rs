//! 프로젝트 폴더 확인, 폴더 선택, 프로젝트 생성.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;

use crate::platform;

/// 확인한 프로젝트 디렉터리.
#[derive(Debug, Serialize)]
pub struct Folder {
    /// 심볼릭 링크를 해석한 정규 경로.
    pub root: String,
    /// 같은 디렉터리를 가리키는 경로에 같은 값을 갖는 식별값.
    pub identity: String,
}

/// root 를 프로젝트 디렉터리로 확인한다.
///
/// `~` 와 `~/` 로 시작하는 경로는 home 기준으로 해석한다. 경로가 비었거나, 존재하지 않거나,
/// 디렉터리가 아니거나, UTF-8 이 아니면 오류를 반환한다.
pub fn folder(root: &str, home: &Path) -> Result<Folder, String> {
    if root.trim().is_empty() {
        return Err("project directory is empty".into());
    }
    let path = if root == "~" {
        home.to_path_buf()
    } else if root.starts_with("~/") || root.starts_with("~\\") {
        home.join(&root[2..])
    } else {
        PathBuf::from(root)
    };
    let path = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err(format!("not a project directory: {}", path.display()));
    }
    let identity = platform::current()?.directory_identity(&path, &metadata)?;
    Ok(Folder {
        root: path.to_str().ok_or("project path is not UTF-8")?.into(),
        identity,
    })
}

/// 사용자 홈 디렉터리 기준으로 root 를 프로젝트 디렉터리로 확인한다.
pub(crate) fn project_folder(app: &AppHandle, root: String) -> Result<Folder, String> {
    folder(&root, &app.path().home_dir().map_err(|e| e.to_string())?)
}

/// 폴더 선택 대화상자를 열고 선택한 경로를 반환한다. 취소하면 None 이다.
pub(crate) fn folder_choose(window: &Window) -> Result<Option<String>, String> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("프로젝트 폴더 선택")
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map_err(|e| e.to_string())?
                .into_os_string()
                .into_string()
                .map_err(|_| "project path is not UTF-8".into())
        })
        .transpose()
}

#[derive(Deserialize)]
pub(crate) struct CreateProject {
    parent: String,
    name: String,
}

/// parent 아래에 name 폴더를 만들고 프로젝트 디렉터리로 확인한다.
pub(crate) fn project_create(app: &AppHandle, request: CreateProject) -> Result<Folder, String> {
    let parent = project_folder(app, request.parent)?;
    let name = request.name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err("invalid project folder name".into());
    }
    let destination = Path::new(&parent.root).join(name);
    fs::create_dir(&destination).map_err(|e| e.to_string())?;
    project_folder(
        app,
        destination
            .to_str()
            .ok_or("project path is not UTF-8")?
            .into(),
    )
}
