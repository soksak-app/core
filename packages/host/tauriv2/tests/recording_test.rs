//! 진단 녹화 상태 테스트. 녹화 장치는 가짜가 대신한다. 진단 빌드에서만 컴파일한다.
#![cfg(feature = "diagnostics")]

use std::cell::RefCell;
use std::path::Path;

use soksak_host_tauriv2::recording::{Capture, Recording};

/// 호출을 기록하고 지정한 단계에서 실패하는 녹화 장치.
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<String>>,
    fail_open: bool,
    fail_start: bool,
    no_frame: bool,
}

impl Capture for Fake {
    fn open(&self, window_number: isize) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("open {window_number}"));
        if self.fail_open { Err("open failed".into()) } else { Ok(()) }
    }
    fn start(&self, _directory: &Path) -> Result<(), String> {
        self.calls.borrow_mut().push("start".into());
        if self.fail_start { Err("start failed".into()) } else { Ok(()) }
    }
    fn wait(&self) -> Result<bool, String> {
        self.calls.borrow_mut().push("wait".into());
        Ok(!self.no_frame)
    }
    fn stop(&self) -> Result<i32, String> {
        self.calls.borrow_mut().push("stop".into());
        Ok(3)
    }
}

fn make(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

fn calls(fake: &Fake) -> Vec<String> {
    fake.calls.borrow().clone()
}

#[test]
fn a_finished_recording_keeps_its_folder_and_reports_frames() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    recording.start(&fake, 7, &folder, &make).unwrap();
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let (directory, count) = recording.finish(&fake).unwrap();
    assert_eq!((directory, count), (folder.clone(), 3));
    assert!(folder.is_dir());
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);
    assert!(recording.finish(&fake).is_err());
}

#[test]
fn a_failed_open_removes_the_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake { fail_open: true, ..Fake::default() };
    assert_eq!(recording.start(&fake, 7, &folder, &make).unwrap_err(), "open failed");
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

#[test]
fn a_failed_start_removes_the_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake { fail_start: true, ..Fake::default() };
    assert_eq!(recording.start(&fake, 7, &folder, &make).unwrap_err(), "start failed");
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

#[test]
fn a_recording_without_a_first_frame_is_stopped_and_removed() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake { no_frame: true, ..Fake::default() };
    assert!(recording.start(&fake, 7, &folder, &make).is_err());
    assert!(!folder.exists());
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);
    assert_eq!(recording.running(), None);
}

#[test]
fn an_aborted_recording_is_stopped_and_removed_and_allows_the_next() {
    let parent = tempfile::tempdir().unwrap();
    let first = parent.path().join("first");
    let second = parent.path().join("second");
    let recording = Recording::new();
    let fake = Fake::default();
    recording.start(&fake, 7, &first, &make).unwrap();
    let refused = recording.start(&fake, 7, &second, &make).unwrap_err();
    assert!(refused.contains("is running"), "{refused}");
    assert!(!second.exists());
    recording.abort(&fake);
    assert!(!first.exists());
    recording.start(&fake, 7, &second, &make).unwrap();
    // 같은 창이면 녹화 대상을 다시 준비하지 않는다.
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop", "start", "wait"]);
}
