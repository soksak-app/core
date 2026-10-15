//! The installed application of a connector plugin (docs/spec/installation.md#applications): each locate entry is tried
//! in order, and the first that finds the application gives its executable and the kind of the entry.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::platform;

/// An installed application that a locate entry found.
#[derive(Debug, PartialEq)]
pub struct Located {
    /// The executable.
    pub path: PathBuf,
    /// The kind of the entry: `bundle`, `command` or `path`.
    pub method: String,
}

/// Tries each locate entry in order and returns the first application it finds: a bundle identifier through the
/// metadata index of the platform, a name on the search path `search`, or an absolute path of an executable file. The
/// program, a path inside the installed folder, gives the executable of a found bundle. An entry that finds nothing
/// passes to the next one; a failure of the platform is an error.
pub fn locate(
    ways: &[Map<String, Value>],
    program: &str,
    search: &OsStr,
) -> Result<Option<Located>, String> {
    for (index, way) in ways.iter().enumerate() {
        let text = |key: &str| {
            way.get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        };
        if let Some(identifier) = text("bundle") {
            let current =
                platform::current().map_err(|error| format!("locate entry {index}: {error}"))?;
            if let Some(bundle) = current
                .application_of_bundle(identifier)
                .map_err(|error| format!("locate entry {index}: {error}"))?
            {
                // The installed folder holds the bundle, so the program names the executable from the parent of the bundle.
                let path = bundle.parent().unwrap_or(Path::new("/")).join(program);
                if executable_file(&path) {
                    return Ok(Some(Located {
                        path,
                        method: "bundle".into(),
                    }));
                }
            }
        } else if let Some(name) = text("command") {
            // which::which reads PATH of the process; the installer passes PATH and the tests pass their own folders.
            if let Ok(path) = which::which_in(name, Some(search), "/")
                && executable_file(&path)
            {
                return Ok(Some(Located {
                    path,
                    method: "command".into(),
                }));
            }
        } else if let Some(path) = text("path") {
            if executable_file(Path::new(path)) {
                return Ok(Some(Located {
                    path: PathBuf::from(path),
                    method: "path".into(),
                }));
            }
        } else {
            return Err(format!(
                "locate entry {index} is not one of bundle, command or path"
            ));
        }
    }
    Ok(None)
}

/// Whether the path is a regular file that the platform marks executable.
fn executable_file(path: &Path) -> bool {
    match (std::fs::metadata(path), platform::current()) {
        (Ok(metadata), Ok(current)) => metadata.is_file() && current.executable(&metadata),
        _ => false,
    }
}
