//! Writes and removes the path entry of this command line (docs/spec/cli.md). The entry is the file <identifier> of the paths.d folder and holds
//! the folder that contains sok in one line.

use std::io::{ErrorKind, Write};
use std::path::Path;

use serde_json::json;

use crate::setup::{Reason, require_writable_volume, running_sok};
use crate::{Error, Options};

/// The content of the path entry of a sok: the folder that holds it, in one line.
fn entry_content(sok: &Path) -> Result<String, String> {
    let directory = sok
        .parent()
        .ok_or_else(|| "the location of sok has no directory".to_string())?;
    Ok(format!("{}\n", directory.display()))
}

/// Whether the path entry file holds the content that `sok path install` writes for the sok: None when it does, else why it is
/// missing (docs/spec/cli.md#setup-parts).
pub(crate) fn entry_state(file: &Path, sok: &Path) -> Result<Option<Reason>, String> {
    let expected = entry_content(sok)?;
    match std::fs::read(file) {
        Ok(bytes) if bytes == expected.as_bytes() => Ok(None),
        Ok(_) => Ok(Some(Reason::Differs)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Some(Reason::Absent)),
        Err(error) => Err(crate::files::file_error(file.display(), &error)),
    }
}

pub(crate) fn run_path(
    action: &str,
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let file = options.paths_dir.clone()?.join(options.identifier);
    match action {
        "install" => {
            let executable = running_sok()?;
            require_writable_volume(&executable)?;
            let content = entry_content(&executable)?;
            std::fs::write(&file, &content).map_err(|error| {
                format!(
                    "cannot write {}; run sudo sok path install",
                    crate::files::file_error(file.display(), &error)
                )
            })?;
            let out = serde_json::to_string_pretty(
                &json!({"path": file.display().to_string(), "directory": content.trim_end_matches('\n')}),
            )
            .map_err(|error| error.to_string())?;
            writeln!(stdout, "{out}").map_err(|error| error.to_string())?;
            Ok(())
        }
        "remove" => {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(Error::Failed(format!(
                        "cannot remove {}; run sudo sok path remove",
                        crate::files::file_error(file.display(), &error)
                    )));
                }
            }
            writeln!(stdout, "null").map_err(|error| error.to_string())?;
            Ok(())
        }
        _ => Err(Error::Usage(format!("unknown path action: {action}"))),
    }
}
