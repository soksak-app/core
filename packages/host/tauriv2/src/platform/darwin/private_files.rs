//! Files and directories for the current user only. The permissions are set with the Unix mode.

use std::fs::{DirBuilder, File, OpenOptions, Permissions};
use std::io::Write;
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
