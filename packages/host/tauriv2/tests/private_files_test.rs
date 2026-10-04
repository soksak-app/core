//! 현재 사용자 전용 파일과 디렉터리의 platform 연산 테스트(docs/spec/hosts.md#platform-interface).

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use soksak_host_tauriv2::platform;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

// contract: platform.private.creates-owner-only-directories
#[test]
fn create_private_directories_makes_missing_directories_owner_only() {
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let middle = root.path().join("middle");
    let leaf = middle.join("leaf");
    let current = platform::current().unwrap();
    current.create_private_directories(&leaf).unwrap();
    for path in [&middle, &leaf] {
        assert_eq!(mode(path), 0o700, "{}", path.display());
    }
    // 이미 있는 디렉터리의 권한은 바꾸지 않는다.
    current.create_private_directories(root.path()).unwrap();
    assert_eq!(mode(root.path()), 0o755);
}

// contract: platform.private.appends-owner-only-file
#[test]
fn append_private_file_creates_an_owner_only_file_and_appends() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.log");
    let current = platform::current().unwrap();
    for line in ["first\n", "second\n"] {
        current
            .append_private_file(&path)
            .unwrap()
            .write_all(line.as_bytes())
            .unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
    assert_eq!(mode(&path), 0o600);
    // 이미 있는 파일의 권한은 바꾸지 않는다.
    let shared = directory.path().join("shared.log");
    std::fs::write(&shared, "").unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o644)).unwrap();
    current.append_private_file(&shared).unwrap();
    assert_eq!(mode(&shared), 0o644);
}

// contract: platform.private.creates-new-owner-only-file
#[test]
fn create_private_file_creates_a_new_owner_only_file_only() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.lock");
    let current = platform::current().unwrap();
    drop(current.create_private_file(&path).unwrap());
    assert_eq!(mode(&path), 0o600);
    let error = current.create_private_file(&path).err().unwrap();
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::AlreadyExists,
        "creating an existing file returned {error}"
    );
}

// contract: platform.private.writes-owner-only-file
#[test]
fn write_private_file_creates_an_owner_only_file_and_replaces_its_contents() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.json");
    let current = platform::current().unwrap();
    for contents in ["first contents\n", "second\n"] {
        current
            .write_private_file(&path, contents.as_bytes())
            .unwrap();
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "second\n");
    assert_eq!(mode(&path), 0o600);
    // 이미 있는 파일의 권한은 바꾸지 않는다.
    let shared = directory.path().join("shared.json");
    std::fs::write(&shared, "").unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o644)).unwrap();
    current.write_private_file(&shared, b"x").unwrap();
    assert_eq!(mode(&shared), 0o644);
}
