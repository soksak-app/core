//! The files, copies, tar and state file of the debug view (docs/spec/debug.md).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use soksak_host_tauriv2::debug;

/// A configuration folder with an application log and a capture under logs/ and a file outside it.
fn debug_config() -> tempfile::TempDir {
    let config = tempfile::tempdir().unwrap();
    let write = |path: &str, text: &str| {
        let full = config.path().join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, text).unwrap();
    };
    write("logs/application.log", "started\n");
    write("logs/captures/still-1/window.png", "png");
    write("plugins/installed.json", "{}");
    config
}

// contract: debug.files.lists-the-logs-folder
#[test]
fn debug_files_list_the_logs_folder() {
    let config = debug_config();
    let files = debug::list(config.path()).unwrap();
    let listed: Vec<(String, u64)> = files
        .iter()
        .map(|file| (file.path.clone(), file.size))
        .collect();
    assert_eq!(
        listed,
        [
            ("logs/application.log".to_string(), 8),
            ("logs/captures/still-1/window.png".to_string(), 3)
        ]
    );
    assert!(
        files.iter().all(|file| file.modified > 0),
        "a file has no modification time"
    );
}

// contract: debug.save.copies-a-file-of-the-logs-folder-only
#[test]
fn debug_copy_copies_a_file_of_the_logs_folder_only() {
    let config = debug_config();
    let target = tempfile::tempdir().unwrap();
    let destination: PathBuf = target.path().join("application.log");
    debug::copy(config.path(), "logs/application.log", &destination).unwrap();
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), "started\n");
    for path in [
        "plugins/installed.json",
        "logs/../plugins/installed.json",
        "logs/missing.log",
        "logs/captures",
    ] {
        assert_eq!(
            debug::copy(config.path(), path, &target.path().join("copy")),
            Err(format!("debug: {path} is not a file under logs/")),
            "copy {path}"
        );
    }
}

// contract: debug.save-all.writes-the-logs-folder-as-tar
#[test]
fn debug_write_logs_tar_writes_the_logs_folder() {
    let config = debug_config();
    let target = tempfile::tempdir().unwrap();
    let destination = target.path().join("debug.tar.gz");
    debug::write_logs_tar(config.path(), &destination).unwrap();
    let file = std::fs::File::open(&destination).unwrap();
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut entries = Vec::new();
    for entry in reader.entries().unwrap() {
        let mut entry = entry.unwrap();
        let mut text = String::new();
        entry.read_to_string(&mut text).unwrap();
        entries.push(format!("{}={text}", entry.path().unwrap().display()));
    }
    assert_eq!(
        entries,
        [
            "logs/application.log=started\n",
            "logs/captures/still-1/window.png=png"
        ]
    );
}

// contract: debug.record.writes-the-state-file
#[test]
fn debug_write_state_writes_the_state_file() {
    let config = debug_config();
    // 2026-10-09T01:02:03Z.
    let at = UNIX_EPOCH + Duration::from_secs(1_791_507_723);
    let path =
        debug::write_state(config.path(), at, serde_json::json!({"host": "tauriv2"})).unwrap();
    assert_eq!(path, "logs/state-20261009T010203Z.json");
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(Path::new(config.path()).join(&path)).unwrap())
            .unwrap();
    assert_eq!(state["host"], "tauriv2");
    assert_eq!(state["time"], "20261009T010203Z");
}

// contract: debug.read.returns-the-end-of-a-text-file
#[test]
fn debug_read_returns_the_end_of_a_text_file() {
    let config = debug_config();
    let read = debug::read(config.path(), "logs/application.log").unwrap();
    assert_eq!(
        (
            read.path.as_str(),
            read.size,
            read.truncated,
            read.text.as_str()
        ),
        ("logs/application.log", 8, false, "started\n")
    );
    // 100000 characters of three bytes: the last 262144 bytes start inside a character.
    let big = "끝".repeat(100_000);
    std::fs::write(config.path().join("logs/big.log"), &big).unwrap();
    let read = debug::read(config.path(), "logs/big.log").unwrap();
    assert!(read.truncated);
    assert_eq!(read.size, big.len() as u64);
    assert!(read.text.ends_with('끝'));
    assert!(
        (262_142..=262_144).contains(&read.text.len()),
        "length {}",
        read.text.len()
    );
}

// contract: debug.read.refuses-a-path-outside-logs-and-a-file-that-is-not-text
#[test]
fn debug_read_refuses_a_path_outside_logs_and_a_file_that_is_not_text() {
    let config = debug_config();
    std::fs::write(
        config.path().join("logs/binary.bin"),
        [0xff, 0xfe, 0x00, 0x01],
    )
    .unwrap();
    for (path, want) in [
        (
            "plugins/installed.json",
            "debug: plugins/installed.json is not a file under logs/",
        ),
        (
            "logs/../plugins/installed.json",
            "debug: logs/../plugins/installed.json is not a file under logs/",
        ),
        (
            "logs/missing.log",
            "debug: logs/missing.log is not a file under logs/",
        ),
        ("logs/binary.bin", "debug: logs/binary.bin is not text"),
    ] {
        assert_eq!(
            debug::read(config.path(), path).err().as_deref(),
            Some(want),
            "read {path}"
        );
    }
}
