//! The output of the commands: the platform key on which sok runs, the replacement of a file in one step, and JSON results.

use std::io::Write;
use std::path::Path;

use serde_json::Value;

use crate::platform;

/// The platform key on which sok runs.
pub fn current_platform() -> Result<String, String> {
    platform::current()?.key()
}

/// Writes to a temporary file in the same folder and renames it to change path once. When the write fails, it removes the temporary file.
fn replace_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let temp = path.with_file_name(format!(".{file_name}.{}", std::process::id()));
    let result = std::fs::File::create(&temp)
        .map_err(|error| crate::files::file_error(temp.display(), &error))
        .and_then(|mut file| {
            let written = write(&mut file).and_then(|()| {
                file.sync_all()
                    .map_err(|error| crate::files::file_error(temp.display(), &error))
            });
            let closed = crate::platform::current()?.close_file(file, &temp);
            match (written, closed) {
                (Err(error), Err(close)) => Err(format!("{error}; close {close}")),
                (Err(error), Ok(())) => Err(error),
                (Ok(()), closed) => closed,
            }
        })
        .and_then(|()| {
            std::fs::rename(&temp, path)
                .map_err(|error| crate::files::file_error(path.display(), &error))
        });
    result.map_err(|error| {
        crate::files::with_cleanup(error, &temp, |path| std::fs::remove_file(path))
    })
}

/// Changes path once with data.
pub fn replace_file(path: &Path, data: &[u8]) -> Result<(), String> {
    replace_with(path, |file| {
        file.write_all(data).map_err(|error| error.to_string())
    })
}

/// Writes bytes as lowercase hexadecimal.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Reads one JSON file of the folder.
pub fn read_json_file(dir: &Path, name: &str) -> Result<Value, String> {
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path)
        .map_err(|error| crate::files::file_error(path.display(), &error))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
}

/// Writes the result with two-space indentation.
pub fn print_json<T: serde::Serialize + ?Sized>(
    stdout: &mut dyn Write,
    value: &T,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    writeln!(stdout, "{text}").map_err(|error| error.to_string())
}
