//! 현재 사용자 전용 파일과 디렉터리. 권한은 Unix mode 로 정한다.

use std::fs::{DirBuilder, File, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// path 에서 없는 디렉터리를 mode 0700 으로 만든다. 이미 있는 디렉터리의 권한은 바꾸지 않는다.
pub fn create_private_directories(path: &Path) -> Result<(), String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// path 의 파일을 덧붙이기로 연다. 없으면 mode 0600 으로 만든다. 있는 파일의 권한은 바꾸지 않는다.
pub fn append_private_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// path 에 mode 0600 의 새 파일을 만들어 쓰기로 연다. path 가 이미 있으면 AlreadyExists 오류다.
pub fn create_private_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// path 의 파일 내용을 data 로 바꾼다. 없으면 mode 0600 으로 만든다. 있는 파일의 권한은 바꾸지 않는다.
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

/// 영구 service 디렉터리 path 의 권한을 0700 으로 바꾼다.
pub fn secure_service_directory(path: &Path) -> Result<(), String> {
    std::fs::set_permissions(path, Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}
