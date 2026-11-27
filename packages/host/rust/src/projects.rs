//! Project folder check, folder selection and project creation.

use std::fs;
use std::io::Read;
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
/// program with the address after `--`, so an address that starts with `-` is never read as an option. Each line of the output of
/// git goes to `progress` as it is written. A progress error fails the clone after git ends. A failed clone removes the target
/// folder, and the error carries the output of git. A path that starts with `~` is resolved relative to home.
pub fn clone_repository(
    request: CloneProject,
    home: &Path,
    progress: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<Folder, String> {
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
    // One pipe carries both streams of git, so the lines reach the callback in the order that git wrote them.
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new("git");
    command
        .arg("clone")
        .arg("--progress")
        .arg("--")
        .arg(address)
        .arg(&target)
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer);
    let mut child = command.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "git is not installed or not on PATH".to_string(),
        _ => e.to_string(),
    })?;
    // The command keeps the write ends until it is dropped; the read ends the stream only after that.
    drop(command);
    let mut output = String::new();
    let mut stream_error = None;
    let mut pending = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        for &byte in &chunk[..read] {
            if byte == b'\r' || byte == b'\n' {
                if let Err(e) = emit_clone_line(&mut pending, &mut output, progress) {
                    stream_error.get_or_insert(e);
                }
            } else {
                pending.push(byte);
            }
        }
    }
    if let Err(e) = emit_clone_line(&mut pending, &mut output, progress) {
        stream_error.get_or_insert(e);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if let Some(error) = stream_error {
        remove_failed_target(&target)?;
        return Err(error);
    }
    if !status.success() {
        remove_failed_target(&target)?;
        return Err(output.trim().to_string());
    }
    folder(target.to_str().ok_or("project path is not UTF-8")?, home)
}

/// Sends the pending bytes as one line of the output of git and appends it to the output, unless the line is empty.
fn emit_clone_line(
    pending: &mut Vec<u8>,
    output: &mut String,
    progress: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    if pending.iter().all(|byte| byte.is_ascii_whitespace()) {
        pending.clear();
        return Ok(());
    }
    let line = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    output.push_str(&line);
    output.push('\n');
    progress(&line)
}

/// Removes the target folder that a failed clone left behind; a target that is absent is not an error.
fn remove_failed_target(target: &Path) -> Result<(), String> {
    if target.symlink_metadata().is_ok() {
        fs::remove_dir_all(target)
            .map_err(|e| format!("{} remains after the failed clone: {e}", target.display()))?;
    }
    Ok(())
}

/// Clones a Git repository into the target folder of the request and sends each output line of git to the window as the
/// event `project-clone` with `{line}`.
pub fn project_clone(
    app: &AppHandle,
    window: &Window,
    request: CloneProject,
) -> Result<Folder, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    clone_repository(request, &home, &mut |line| {
        window
            .emit("project-clone", serde_json::json!({ "line": line }))
            .map_err(|e| e.to_string())
    })
}
