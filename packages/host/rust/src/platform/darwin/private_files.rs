//! Files and directories for the current user only. The permissions are set with the Unix mode.

use std::fs::{DirBuilder, File, OpenOptions, Permissions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// Creates a missing directory at path with mode 0700. The permissions of an existing directory are not changed.
pub fn create_private_directories(path: &Path) -> Result<(), String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Opens the file at path for appending. It is created with mode 0600 when it does not exist. The permissions of an
/// existing file are not changed.
pub fn append_private_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Creates a new file with mode 0600 at path and opens it for writing. It is an AlreadyExists error when path already
/// exists.
pub fn create_private_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// Opens the existing file at path for reading and writing. A missing file is a NotFound error. Its contents and
/// permissions are not changed.
pub fn open_private_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).open(path)
}

/// Reports whether file is the file that path names now, which is the same device and inode. A path that does not
/// exist names no file.
pub fn is_named_file(file: &File, path: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    let opened = file
        .metadata()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    match std::fs::metadata(path) {
        Ok(named) => Ok(opened.dev() == named.dev() && opened.ino() == named.ino()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// Replaces the content of the file at path with data. It is created with mode 0600 when it does not exist. The
/// permissions of an existing file are not changed.
pub fn write_private_file(path: &Path, data: &[u8]) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut file| file.write_all(data))
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Changes the permissions of the persistent service directory path to 0700.
pub fn secure_service_directory(path: &Path) -> Result<(), String> {
    std::fs::set_permissions(path, Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}
