//! Project folder check, folder selection and project creation.

use std::fs;
use std::path::{Path, PathBuf};

use crate::framework::{AppHandle, Window};
use serde::{Deserialize, Serialize};

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
pub fn project_folder(app: &AppHandle, root: String) -> Result<Folder, String> {
    folder(&root, &app.path().home_dir().map_err(|e| e.to_string())?)
}

/// Opens the folder selection dialog and returns the selected path. It is None when canceled.
pub fn folder_choose(window: &Window) -> Result<Option<String>, String> {
    crate::dialog::folder_path(window, "프로젝트 폴더 선택")?
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|_| "project path is not UTF-8".into())
        })
        .transpose()
}

#[derive(Deserialize)]
pub struct CreateProject {
    parent: String,
    name: String,
}

/// Creates the folder name under parent and checks it as a project directory.
pub fn project_create(app: &AppHandle, request: CreateProject) -> Result<Folder, String> {
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

/// The request of `project_clone`: the repository address and the target folder that the clone creates.
#[derive(Debug, Deserialize)]
pub struct CloneProject {
    address: String,
    target: String,
}

/// Clones the address into the target folder, which must not exist, and returns the target folder. The clone runs the git
/// program with the address after `--`, so an address that starts with `-` is never read as an option. A failed clone removes the
/// target folder, and the error carries the output of git. A path that starts with `~` is resolved relative to home.
pub fn clone_repository(request: CloneProject, home: &Path) -> Result<Folder, String> {
    let address = request.address.trim();
    if address.is_empty() {
        return Err("the address is empty".into());
    }
    if address.starts_with('-') {
        return Err("the address starts with -".into());
    }
    let target = if request.target == "~" {
        home.to_path_buf()
    } else if request.target.starts_with("~/") || request.target.starts_with("~\\") {
        home.join(&request.target[2..])
    } else {
        PathBuf::from(&request.target)
    };
    if !target.is_absolute() {
        return Err(format!(
            "the target is not an absolute path: {}",
            request.target
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} is not a folder", target.display()))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder", parent.display()));
    }
    if target.symlink_metadata().is_ok() {
        return Err(format!("{} already exists", target.display()));
    }
    let output = std::process::Command::new("git")
        .arg("clone")
        .arg("--")
        .arg(address)
        .arg(&target)
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "git is not installed or not on PATH".to_string(),
            _ => e.to_string(),
        })?;
    if !output.status.success() {
        if target.symlink_metadata().is_ok() {
            fs::remove_dir_all(&target)
                .map_err(|e| format!("{} remains after the failed clone: {e}", target.display()))?;
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    folder(target.to_str().ok_or("project path is not UTF-8")?, home)
}

/// Clones a Git repository into a new project folder under the given home-relative or absolute target.
pub fn project_clone(app: &AppHandle, request: CloneProject) -> Result<Folder, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    clone_repository(request, &home)
}
