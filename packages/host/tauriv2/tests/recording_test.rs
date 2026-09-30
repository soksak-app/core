//! 진단 녹화 상태 테스트. 녹화 장치는 가짜가 대신한다. 진단 빌드에서만 컴파일한다.
#![cfg(feature = "diagnostics")]

use std::cell::RefCell;
use std::path::Path;

use soksak_host_tauriv2::recording::{stop_payload, Capture, Recording, Target};

/// 호출을 기록하고 지정한 단계에서 실패하는 녹화 장치.
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<String>>,
    fail_open: bool,
    fail_start: bool,
    no_frame: bool,
    fail_stop: bool,
}

impl Capture for Fake {
    fn open(&self, target: Target) -> Result<(), String> {
        let kind = if target.display { " display" } else { "" };
        self.calls
            .borrow_mut()
            .push(format!("open {}{kind}", target.window));
        if self.fail_open {
            Err("open failed".into())
        } else {
            Ok(())
        }
    }
    fn start(&self, _directory: &Path) -> Result<(), String> {
        self.calls.borrow_mut().push("start".into());
        if self.fail_start {
            Err("start failed".into())
        } else {
            Ok(())
        }
    }
    fn wait(&self) -> Result<bool, String> {
        self.calls.borrow_mut().push("wait".into());
        Ok(!self.no_frame)
    }
    fn stop(&self) -> Result<i32, String> {
        self.calls.borrow_mut().push("stop".into());
        if self.fail_stop {
            Err("stop failed".into())
        } else {
            Ok(3)
        }
    }
}

const WINDOW: Target = Target {
    window: 7,
    display: false,
};

fn make(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

fn calls(fake: &Fake) -> Vec<String> {
    fake.calls.borrow().clone()
}

// contract: recording.finish.keeps-folder-and-reports-frames
#[test]
fn a_finished_recording_keeps_its_folder_and_reports_frames() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    recording.start(&fake, WINDOW, &folder, &make).unwrap();
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let (directory, count) = recording.finish(&fake).unwrap();
    assert_eq!((directory, count), (folder.clone(), 3));
    assert!(folder.is_dir());
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);
    assert!(recording.finish(&fake).is_err());
}

// contract: recording.start.failed-open-removes-folder
#[test]
fn a_failed_open_removes_the_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_open: true,
        ..Fake::default()
    };
    assert_eq!(
        recording.start(&fake, WINDOW, &folder, &make).unwrap_err(),
        "open failed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

// contract: recording.start.failed-start-removes-folder
#[test]
fn a_failed_start_removes_the_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_start: true,
        ..Fake::default()
    };
    assert_eq!(
        recording.start(&fake, WINDOW, &folder, &make).unwrap_err(),
        "start failed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

// contract: recording.start.no-first-frame-stops-and-removes
#[test]
fn a_recording_without_a_first_frame_is_stopped_and_removed() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        no_frame: true,
        ..Fake::default()
    };
    assert!(recording.start(&fake, WINDOW, &folder, &make).is_err());
    assert!(!folder.exists());
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);
    assert_eq!(recording.running(), None);
}

// contract: recording.start.rejects-while-running, recording.abort.stops-removes-and-allows-next, recording.target.same-target-not-reopened
#[test]
fn an_aborted_recording_is_stopped_and_removed_and_allows_the_next() {
    let parent = tempfile::tempdir().unwrap();
    let first = parent.path().join("first");
    let second = parent.path().join("second");
    let recording = Recording::new();
    let fake = Fake::default();
    recording.start(&fake, WINDOW, &first, &make).unwrap();
    let refused = recording.start(&fake, WINDOW, &second, &make).unwrap_err();
    assert!(refused.contains("is running"), "{refused}");
    assert!(!second.exists());
    recording.abort(&fake).unwrap();
    assert!(!first.exists());
    recording.start(&fake, WINDOW, &second, &make).unwrap();
    // 같은 창이면 녹화 대상을 다시 준비하지 않는다.
    assert_eq!(
        calls(&fake),
        ["open 7", "start", "wait", "stop", "start", "wait"]
    );
}

// contract: recording.abort.reports-stop-failure-and-removes-folder
#[test]
fn an_abort_reports_a_stop_failure_and_still_removes_the_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_stop: true,
        ..Fake::default()
    };
    recording.start(&fake, WINDOW, &folder, &make).unwrap();
    let error = recording.abort(&fake).unwrap_err();
    assert!(error.contains("stop failed"), "{error}");
    assert!(!folder.exists(), "the aborted folder remains");
    assert_eq!(recording.running(), None);
}

// contract: recording.target.different-target-reopened
#[test]
fn a_different_target_is_prepared_again() {
    let parent = tempfile::tempdir().unwrap();
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &parent.path().join("window"), &make)
        .unwrap();
    recording.finish(&fake).unwrap();
    let display = Target {
        window: 7,
        display: true,
    };
    recording
        .start(&fake, display, &parent.path().join("display"), &make)
        .unwrap();
    recording.finish(&fake).unwrap();
    assert_eq!(
        calls(&fake),
        [
            "open 7",
            "start",
            "wait",
            "stop",
            "open 7 display",
            "start",
            "wait",
            "stop"
        ]
    );
}

// contract: diagnostics.capture-stop.payload-reports-frame-limit
#[test]
fn the_stop_payload_reports_a_normal_frame_limit() {
    let payload = stop_payload(Path::new("/tmp/frames"), 600, true, 42.5, &[]);
    assert_eq!(
        payload,
        serde_json::json!({"frames": "/tmp/frames", "count": 600, "limited": true, "longestGap": 42.5, "layouts": []})
    );
}

// contract: diagnostics.capture-stop.payload-reports-unbounded
#[test]
fn the_stop_payload_reports_an_unbounded_recording() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, false, 0.0, &[]);
    assert_eq!(payload["limited"], false);
}

#[test]
fn the_stop_payload_requires_a_layout_timeline() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, false, 0.0, &[]);
    assert!(
        payload["layouts"].is_array(),
        "capture stop omitted layouts: {payload}"
    );
}

#[test]
fn the_stop_payload_preserves_layout_stages() {
    let payload = stop_payload(
        Path::new("/tmp/frames"),
        3,
        false,
        0.0,
        &[[7.0, 10.0, 20.0, 30.0]],
    );
    assert_eq!(
        payload["layouts"],
        serde_json::json!([{"ticket":7,"begun":10.0,"presented":20.0,"committed":30.0}])
    );
}
