//! The save place of a new document (docs/spec/plugins.md#pluginjson): the host shows the save panel in the project root of
//! the window and answers the chosen file relative to that root.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use tauri::Window;
use tauri_plugin_dialog::DialogExt;

use crate::windows::window_data;

/// The argument of the filePlace call: the file name that the save panel offers.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilePlaceRequest {
    pub name: String,
}

/// The answer of filePlace: the chosen file relative to the project root, or `None` when the person cancelled.
#[derive(Serialize)]
pub struct FilePlaced {
    pub path: Option<String>,
}

/// Refuses a name that is not a file name: empty, `.`, `..`, or holding a separator.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("file place: name {name} is not a file name"));
    }
    Ok(())
}

/// Answers `chosen` relative to `root` with `/` between its parts, after the symbolic links of `root` and of the folder of
/// `chosen` are resolved, and refuses a place that is not inside `root`.
pub fn relative(root: &Path, chosen: &Path) -> Result<String, String> {
    let outside = || {
        format!(
            "file place: {} is outside the project {}",
            chosen.display(),
            root.display()
        )
    };
    let real_root = root
        .canonicalize()
        .map_err(|error| format!("file place: {}: {error}", root.display()))?;
    // default: a place without a parent folder or a file name is the root of the file system, which no project holds.
    let (Some(parent), Some(name)) = (chosen.parent(), chosen.file_name()) else {
        return Err(outside());
    };
    let folder = parent
        .canonicalize()
        .map_err(|error| format!("file place: {}: {error}", chosen.display()))?;
    let resolved = folder.join(name);
    let inside = resolved.strip_prefix(&real_root).map_err(|_| outside())?;
    let parts: Vec<String> = inside
        .components()
        .map(|component| match component {
            Component::Normal(part) => Ok(part.to_string_lossy().into_owned()),
            _ => Err(outside()),
        })
        .collect::<Result<_, _>>()?;
    if parts.is_empty() {
        return Err(outside());
    }
    Ok(parts.join("/"))
}

/// The page's filePlace call: shows the save panel of the window in its project root with the name and answers the chosen
/// file relative to that root.
pub fn place(window: &Window, request: FilePlaceRequest) -> Result<FilePlaced, String> {
    check_name(&request.name)?;
    let context = window_data(window)?;
    let root = context
        .root
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if root.is_empty() {
        return Err("file place: the window shows no project".to_string());
    }
    let chosen = window
        .dialog()
        .file()
        .set_parent(window)
        .set_directory(&root)
        .set_file_name(&request.name)
        .blocking_save_file();
    let Some(chosen) = chosen else {
        return Ok(FilePlaced { path: None });
    };
    let chosen = chosen
        .into_path()
        .map_err(|error| format!("file place: save panel: {error}"))?;
    Ok(FilePlaced {
        path: Some(relative(Path::new(&root), &chosen)?),
    })
}
