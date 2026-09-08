use std::{fs, path::Path};
use serde::Deserialize;
use tauri::{AppHandle, Window};
use tauri_plugin_dialog::DialogExt;
use crate::windows::{project_folder, Folder};

#[tauri::command(async)]
pub(crate) fn folder_choose(window: Window) -> Result<Option<String>, String> {
    window.dialog().file().set_parent(&window).set_title("프로젝트 폴더 선택")
        .blocking_pick_folder().map(|path| path.into_path()
            .map_err(|e| e.to_string())?.into_os_string().into_string().map_err(|_| "project path is not UTF-8".into())).transpose()
}

#[derive(Deserialize)]
pub(crate) struct CreateProject { parent: String, name: String }

#[tauri::command(async)]
pub(crate) fn project_create(app: AppHandle, request: CreateProject) -> Result<Folder, String> {
    let parent = project_folder(app.clone(), request.parent)?;
    let name = request.name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err("invalid project folder name".into());
    }
    let destination = Path::new(&parent.root).join(name);
    fs::create_dir(&destination).map_err(|e| e.to_string())?;
    project_folder(app, destination.to_str().ok_or("project path is not UTF-8")?.into())
}
