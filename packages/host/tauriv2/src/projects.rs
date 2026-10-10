//! Project folder check, folder selection and project creation.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Window};
use tauri_plugin_dialog::DialogExt;

use crate::platform;

/// A checked project directory.
#[derive(Debug, Serialize)]
pub struct Folder {
    /// The canonical path with symbolic links resolved.
    pub root: String,
    /// An identifier that has the same value for paths that point to the same directory.
    pub identity: String,
}

/// Checks root as a project directory.
///
/// A path that starts with `~` or `~/` is resolved relative to home. It returns an error when the path is empty, does
/// not exist, is not a directory, or is not UTF-8.
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
    let requested = std::path::absolute(&path).map_err(|e| folder_error(&path, e))?;
    let path = requested
        .canonicalize()
        .map_err(|e| folder_error(&requested, e))?;
    let metadata = path.metadata().map_err(|e| folder_error(&requested, e))?;
    if !metadata.is_dir() {
        return Err(format!("not a project directory: {}", path.display()));
    }
    let identity = platform::current()?.directory_identity(&path, &metadata)?;
    Ok(Folder {
        root: path.to_str().ok_or("project path is not UTF-8")?.into(),
        identity,
    })
}

/// Converts the error of a folder check into the contract text that carries the one requested path. Both hosts produce
/// the same text (workspace.folder.messages in docs/spec/host-contract.md).
fn folder_error(path: &Path, error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
            format!("project directory does not exist: {}", path.display())
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("project directory is not readable: {}", path.display())
        }
        _ => match error.raw_os_error() {
            Some(errno) => format!(
                "project directory cannot be resolved: {} (errno {errno})",
                path.display()
            ),
            None => format!(
                "project directory cannot be resolved: {}: {error}",
                path.display()
            ),
        },
    }
}

/// Checks root as a project directory relative to the home directory of the user.
pub(crate) fn project_folder(app: &AppHandle, root: String) -> Result<Folder, String> {
    folder(&root, &app.path().home_dir().map_err(|e| e.to_string())?)
}

/// Opens the folder selection dialog and returns the selected path. It is None when canceled.
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

/// Creates the folder name under parent and checks it as a project directory.
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
