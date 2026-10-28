//! Tests of the diagnostic recording state. A fake replaces the recording device. They are compiled only in diagnostic
//! builds.
#![cfg(feature = "diagnostics")]

#[path = "support/folder.rs"]
mod folder;

use std::cell::{Cell, RefCell};
use std::path::Path;

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::recording::{Capture, Recording, Target, stop_payload};

/// A recording device that records calls and fails at the specified stage.
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<String>>,
    fail_open: bool,
    fail_start: bool,
    no_frame: bool,
    fail_stop: bool,
    replace_directory_on_open: Option<std::path::PathBuf>,
    replace_directory_on_stop: Option<std::path::PathBuf>,
}

fn replace_directory_with_file(path: &Path) -> Result<(), String> {
    std::fs::remove_dir_all(path).map_err(|error| error.to_string())?;
    std::fs::write(path, "blocks directory cleanup").map_err(|error| error.to_string())
}

impl Capture for Fake {
    fn open(&self, target: Target) -> Result<(), String> {
        let kind = if target.display { " display" } else { "" };
        self.calls
            .borrow_mut()
            .push(format!("open {}{kind}", target.window));
        if let Some(path) = &self.replace_directory_on_open {
            replace_directory_with_file(path)?;
        }
        if self.fail_open {
            Err("open failed".into())
        } else {
            Ok(())
        }
    }
    fn start(&self, _directory: &Path, frame_identity: bool) -> Result<(), String> {
        self.calls.borrow_mut().push(if frame_identity {
            "start frameIdentity".into()
        } else {
            "start".into()
        });
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
        if let Some(path) = &self.replace_directory_on_stop {
            replace_directory_with_file(path)?;
        }
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
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &folder, true, &make)
        .unwrap();
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let (directory, count, frame_identity) = recording.finish(&fake).unwrap();
    assert_eq!(
        (directory, count, frame_identity),
        (folder.clone(), 3, true)
    );
    assert!(folder.is_dir());
    assert_eq!(
        calls(&fake),
        ["open 7", "start frameIdentity", "wait", "stop"]
    );
    assert!(recording.finish(&fake).is_err());
}

// contract: recording.finish.stop-failure-preserves-folder
#[test]
fn a_stop_failure_keeps_the_folder_returned_by_start() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_stop: true,
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, false, &make)
        .unwrap();

    assert_eq!(recording.finish(&fake).unwrap_err(), "stop failed");
    assert!(folder.is_dir(), "failed recording folder was removed");
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let next = recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            false,
            &make,
        )
        .unwrap_err();
    assert!(
        next.contains("is running"),
        "another capture was allowed: {next}"
    );
}

// contract: recording.start.failed-open-removes-folder
#[test]
fn a_failed_open_removes_the_folder() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_open: true,
        ..Fake::default()
    };
    assert_eq!(
        recording
            .start(&fake, WINDOW, &folder, false, &make)
            .unwrap_err(),
        "open failed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

// contract: recording.start.cleanup-failure-retains-folder-owner
#[test]
fn a_failed_start_cleanup_retains_retry_ownership() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let next = parent.path().join("next-frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_open: true,
        replace_directory_on_open: Some(folder.clone()),
        ..Fake::default()
    };
    let error = recording
        .start(&fake, WINDOW, &folder, false, &make)
        .unwrap_err();
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    assert_eq!(calls(&fake), ["open 7"]);

    let blocked = recording
        .start(&fake, WINDOW, &next, false, &make)
        .unwrap_err();
    assert!(
        blocked.contains("is running"),
        "another capture was allowed: {blocked}"
    );
    assert!(!next.exists());

    std::fs::remove_file(&folder).unwrap();
    recording
        .abort(&fake)
        .expect("abort did not retry folder cleanup");
    assert_eq!(calls(&fake), ["open 7"]);
    assert_eq!(recording.running(), None);
}

// contract: recording.abort.stop-complete-cleanup-retry-skips-stop
#[test]
fn a_directory_cleanup_retry_does_not_stop_a_completed_capture_twice() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        replace_directory_on_stop: Some(folder.clone()),
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, false, &make)
        .unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    assert!(folder.is_file());
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);

    std::fs::remove_file(&folder).unwrap();
    recording
        .abort(&fake)
        .expect("abort did not retry directory cleanup");
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);
    assert_eq!(recording.running(), None);
}

// contract: recording.start.make-failure-preserves-unowned-path
#[test]
fn a_make_failure_preserves_a_path_that_recording_did_not_create() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("existing");
    std::fs::create_dir(&folder).unwrap();
    let sentinel = folder.join("owned-by-caller");
    std::fs::write(&sentinel, "preserve").unwrap();
    let recording = Recording::new();
    let fake = Fake::default();

    let error = recording
        .start(&fake, WINDOW, &folder, false, &|_| {
            Err("path is not available".into())
        })
        .unwrap_err();
    assert!(error.contains("path is not available"), "{error}");
    assert!(sentinel.is_file(), "the caller-owned path was deleted");
    assert_eq!(recording.running(), None);
    assert!(calls(&fake).is_empty());
}

// contract: recording.start.failed-start-removes-folder
#[test]
fn a_failed_start_removes_the_folder() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_start: true,
        ..Fake::default()
    };
    assert_eq!(
        recording
            .start(&fake, WINDOW, &folder, false, &make)
            .unwrap_err(),
        "start failed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

// contract: recording.start.no-first-frame-stops-and-removes
#[test]
fn a_recording_without_a_first_frame_is_stopped_and_removed() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        no_frame: true,
        ..Fake::default()
    };
    assert!(
        recording
            .start(&fake, WINDOW, &folder, false, &make)
            .is_err()
    );
    assert!(!folder.exists());
    assert_eq!(calls(&fake), ["open 7", "start", "wait", "stop"]);
    assert_eq!(recording.running(), None);
}

// contract: recording.start.rejects-while-running, recording.abort.stops-removes-and-allows-next, recording.target.prepared-each-recording
#[test]
fn an_aborted_recording_is_stopped_and_removed_and_allows_the_next() {
    let parent = folder::Folder::new();
    let first = parent.path().join("first");
    let second = parent.path().join("second");
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &first, false, &make)
        .unwrap();
    let refused = recording
        .start(&fake, WINDOW, &second, false, &make)
        .unwrap_err();
    assert!(refused.contains("is running"), "{refused}");
    assert!(!second.exists());
    recording.abort(&fake).unwrap();
    assert!(!first.exists());
    recording
        .start(&fake, WINDOW, &second, false, &make)
        .unwrap();
    // The preparation decides the output size from the window size at that time, so even the same window is prepared
    // again for every recording.
    assert_eq!(
        calls(&fake),
        ["open 7", "start", "wait", "stop", "open 7", "start", "wait"]
    );
}

// contract: recording.abort.stop-failure-preserves-retry-state
#[test]
fn an_abort_reports_a_stop_failure_and_preserves_cleanup_state() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_stop: true,
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, false, &make)
        .unwrap();
    let error = recording.abort(&fake).unwrap_err();
    assert!(error.contains("stop failed"), "{error}");
    assert!(
        folder.exists(),
        "the folder was removed before capture stopped"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let next = recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            false,
            &make,
        )
        .unwrap_err();
    assert!(
        next.contains("is running"),
        "another capture was allowed: {next}"
    );
}

// contract: recording.target.different-target-reopened
#[test]
fn a_different_target_is_prepared_again() {
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &parent.path().join("window"), false, &make)
        .unwrap();
    recording.finish(&fake).unwrap();
    let display = Target {
        window: 7,
        display: true,
    };
    recording
        .start(&fake, display, &parent.path().join("display"), false, &make)
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

// contract: diagnostics.capture-start.forwards-frame-identity
#[test]
fn recording_start_forwards_frame_identity() {
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &parent.path().join("frames"), true, &make)
        .unwrap();
    assert_eq!(calls(&fake), ["open 7", "start frameIdentity", "wait"]);
}

// contract: diagnostics.capture-stop.payload-reports-frame-limit
#[test]
fn the_stop_payload_reports_a_normal_frame_limit() {
    let payload = stop_payload(Path::new("/tmp/frames"), 600, true, 42.5, &[], false);
    assert_eq!(
        payload,
        serde_json::json!({"frames": "/tmp/frames", "callbackStatus": "/tmp/frames/callback-status.jsonl", "displayLink": "/tmp/frames/display-link.json", "count": 600, "limited": true, "longestGap": 42.5, "layouts": []})
    );
}

// contract: diagnostics.capture-stop.payload-reports-callback-status
#[test]
fn the_stop_payload_names_the_callback_status_artifact() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, false, 0.0, &[], false);
    assert_eq!(
        payload["callbackStatus"],
        "/tmp/frames/callback-status.jsonl"
    );
}

// contract: diagnostics.capture-stop.payload-names-opt-in-frame-identity-artifact
#[test]
fn the_stop_payload_names_the_opt_in_frame_identity_artifact() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, false, 0.0, &[], true);
    assert_eq!(payload["frameIdentity"]["status"], "complete");
    assert_eq!(
        payload["frameIdentity"]["manifest"],
        "/tmp/frames/frame-identities/manifest.json"
    );
}

// contract: diagnostics.capture-stop.payload-reports-unbounded
#[test]
fn the_stop_payload_reports_an_unbounded_recording() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, false, 0.0, &[], false);
    assert_eq!(payload["limited"], false);
}

// contract: diagnostics.capture-stop.payload-reports-layout-timeline
#[test]
fn the_stop_payload_requires_a_layout_timeline() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, false, 0.0, &[], false);
    assert!(
        payload["layouts"].is_array(),
        "capture stop omitted layouts: {payload}"
    );
}

// contract: diagnostics.capture-stop.payload-preserves-layout-stages
#[test]
fn the_stop_payload_preserves_layout_stages() {
    let payload = stop_payload(
        Path::new("/tmp/frames"),
        3,
        false,
        0.0,
        &[[7.0, 10.0, 20.0, 30.0, 15.0]],
        false,
    );
    assert_eq!(
        payload["layouts"],
        serde_json::json!([{"ticket":7,"begun":10.0,"requested":15.0,"presented":20.0,"committed":30.0}])
    );
}

/// A recording device that becomes active before its start call panics.
struct Panicking {
    active: Cell<bool>,
    stops: Cell<usize>,
    fail_first_stop: bool,
}

impl Capture for Panicking {
    fn open(&self, _target: Target) -> Result<(), String> {
        Ok(())
    }
    fn start(&self, _directory: &Path, _frame_identity: bool) -> Result<(), String> {
        self.active.set(true);
        panic!("capture start panicked")
    }
    fn wait(&self) -> Result<bool, String> {
        Ok(true)
    }
    fn stop(&self) -> Result<i32, String> {
        self.stops.set(self.stops.get() + 1);
        if self.fail_first_stop && self.stops.get() == 1 {
            return Err("first stop failed".into());
        }
        self.active.set(false);
        Ok(0)
    }
}

// contract: recording.start.panicking-capture-is-cleaned-up
#[test]
fn a_panicking_capture_start_stops_partial_capture_before_unwinding() {
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        fail_first_stop: false,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, false, &make);
    }));
    assert!(panicked.is_err());
    assert_eq!(capture.stops.get(), 1, "partial capture was not stopped");
    assert!(
        !capture.active.get(),
        "capture remained active after start panicked"
    );
    assert!(!folder.exists(), "folder remained after start panicked");
    assert_eq!(recording.running(), None);
    writer.flush(std::time::Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let errors: Vec<String> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| {
            event["event"] == "host.record.error" && event["fields"]["where"] == "recording"
        })
        .map(|event| event["fields"]["text"].as_str().unwrap().to_string())
        .collect();
    assert!(errors.is_empty(), "errors {errors:?}");
}

// contract: recording.start.panic-cleanup-failure-blocks-next-start
#[test]
fn a_failed_panic_cleanup_retains_state_until_abort_retries() {
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let next = config.path().join("next-frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        fail_first_stop: true,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, false, &make);
    }));
    assert!(panicked.is_err());
    assert!(
        capture.active.get(),
        "failed stop was reported as a cleanup"
    );
    assert!(
        folder.is_dir(),
        "the owned folder was removed before capture stopped"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));

    let error = recording
        .start(&Fake::default(), WINDOW, &next, false, &make)
        .unwrap_err();
    assert!(
        error.contains("is running"),
        "a new capture was allowed: {error}"
    );
    assert!(!next.exists());

    recording
        .abort(&capture)
        .expect("abort did not retry capture cleanup");
    assert_eq!(capture.stops.get(), 2);
    assert!(!capture.active.get());
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
    writer.flush(std::time::Duration::from_secs(5)).unwrap();
    use_host_event_log(None);
    let errors: Vec<String> = records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| {
            event["event"] == "host.record.error" && event["fields"]["where"] == "recording"
        })
        .map(|event| event["fields"]["text"].as_str().unwrap().to_string())
        .collect();
    assert!(
        errors
            .iter()
            .any(|error| error.contains("first stop failed")),
        "cleanup failure was not reported: {errors:?}"
    );
}
