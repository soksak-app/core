//! Tests of the diagnostic recording state. The recording device records its calls and writes the records of a start, as the
//! native device does. Failures come from the fault points of the recording (`SOKSAK_FAULT_CAPTURE_OPEN`, `_START`, `_STOP`),
//! and a blocked folder is a folder whose permissions the real filesystem refuses to remove. They are compiled only in
//! diagnostic builds.
#![cfg(feature = "diagnostics")]

#[path = "support/folder.rs"]
mod folder;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

#[path = "support/records.rs"]
mod records;

use soksak_host::event_record::use_host_event_log;
use soksak_host::platform::LayoutRecord;
use soksak_host::recording::{
    Capture, Plan, Recording, StillCounts, Target, layout_trace, stop_payload,
};
use soksak_host::surfaces::LayoutViewport;

/// The records of the host are process-wide, so the tests of this file run one at a time: a test reads only the errors that
/// its own recording wrote, and a fault point set by one test is not seen by another.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Sets a fault point of the recording for the lifetime of the guard. The environment is process-wide, so a test that sets
/// a point holds SERIAL.
struct Fault(&'static str);

impl Fault {
    fn set(variable: &'static str, text: &str) -> Fault {
        // SAFETY: the test holds SERIAL, so no other test of this binary reads or writes the environment while it is set.
        unsafe { std::env::set_var(variable, text) };
        Fault(variable)
    }
}

impl Drop for Fault {
    fn drop(&mut self) {
        // SAFETY: the test that set the point still holds SERIAL.
        unsafe { std::env::remove_var(self.0) };
    }
}

const OPEN_FAULT: &str = "SOKSAK_FAULT_CAPTURE_OPEN";
const START_FAULT: &str = "SOKSAK_FAULT_CAPTURE_START";
const STOP_FAULT: &str = "SOKSAK_FAULT_CAPTURE_STOP";

/// A recording device that records its calls and writes the records of a start into its folder before the start answers.
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<String>>,
    plans: RefCell<Vec<Plan>>,
    panic_stop_once: Cell<bool>,
}

impl Capture for Fake {
    fn open(&self, target: Target) -> Result<(), String> {
        let kind = if target.display { " display" } else { "" };
        self.calls
            .borrow_mut()
            .push(format!("open {}{kind}", target.window));
        Ok(())
    }
    fn start(&self, directory: &Path, plan: Plan) -> Result<(), String> {
        self.calls.borrow_mut().push("start".into());
        self.plans.borrow_mut().push(plan);
        for name in ["stills.jsonl", "display-link.json"] {
            std::fs::write(directory.join(name), "{}\n").map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    fn stop(&self) -> Result<i32, String> {
        self.calls.borrow_mut().push("stop".into());
        if self.panic_stop_once.replace(false) {
            panic!("fixture stop panic");
        }
        Ok(3)
    }
}

/// Makes a file in path and removes the permissions of path, so the real filesystem fails the removal of path.
fn block_directory(path: &Path) -> Result<(), String> {
    std::fs::write(path.join("blocker"), "prevent removal").map_err(|error| error.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000))
        .map_err(|error| error.to_string())
}

/// Restores the permissions of path that block_directory removed.
fn unblock_directory(path: &Path) -> Result<(), String> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| error.to_string())
}

const WINDOW: Target = Target {
    window: 7,
    display: false,
};

/// The plan of the stills of the recordings of these tests.
const PLAN: Plan = Plan {
    gap: 8.0,
    seconds: 0.0,
    frames: 120,
};

fn make(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

/// Creates path and blocks its removal, for a failure whose cleanup must fail.
fn make_blocked(path: &Path) -> Result<(), String> {
    make(path)?;
    block_directory(path)
}

fn calls(fake: &Fake) -> Vec<String> {
    fake.calls.borrow().clone()
}

// contract: recording.finish.keeps-folder-and-reports-frames
#[test]
fn a_finished_recording_keeps_its_folder_and_reports_frames() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &folder, PLAN, &make)
        .unwrap();
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let (directory, count, window) = recording.finish(&fake).unwrap();
    assert_eq!(
        (directory, count, window),
        (folder.clone(), 3, Some(WINDOW.window))
    );
    assert!(folder.is_dir());
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
    assert_eq!(*fake.plans.borrow(), [PLAN]);
    assert!(recording.finish(&fake).is_err());
}

// contract: recording.state.poisoned-lock-is-recovered
#[test]
fn a_poisoned_recording_state_is_recovered_when_it_ends() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        panic_stop_once: Cell::new(true),
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, PLAN, &make)
        .unwrap();

    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.finish(&fake);
    }));
    assert!(panic.is_err(), "the fake stop did not panic");
    assert_eq!(
        recording.running().as_deref(),
        Some(folder.as_path()),
        "reading a poisoned recording state lost its owned folder"
    );
    recording
        .abort(&fake)
        .expect("abort did not recover the poisoned state and complete cleanup");
    assert_eq!(recording.running(), None);
    assert!(!folder.exists(), "abort retained the recovered folder");
}

// contract: recording.finish.retired-stop-failure-releases-owner
#[test]
fn a_retired_stop_failure_preserves_folder_and_releases_owner() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let fault = Fault::set(STOP_FAULT, "stop failed");
    recording
        .start(&fake, WINDOW, &folder, PLAN, &make)
        .unwrap();

    assert_eq!(recording.finish(&fake).unwrap_err(), "stop failed");
    assert!(folder.is_dir(), "retired folder was deleted");
    assert_eq!(
        recording.running(),
        None,
        "retired recording owner remained"
    );
    drop(fault);
    let next = parent.path().join("next-frames");
    recording
        .start(&Fake::default(), WINDOW, &next, PLAN, &make)
        .expect("next recording should start after native ownership retired");
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
}

// contract: recording.start.failed-open-removes-folder
#[test]
fn a_failed_open_removes_the_folder() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let _fault = Fault::set(OPEN_FAULT, "open failed");
    assert_eq!(
        recording
            .start(&fake, WINDOW, &folder, PLAN, &make)
            .unwrap_err(),
        "open failed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
}

// contract: recording.start.cleanup-failure-retains-folder-owner
#[test]
fn a_failed_start_cleanup_retains_retry_ownership() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let next = parent.path().join("next-frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let _fault = Fault::set(OPEN_FAULT, "open failed");
    let error = recording
        .start(&fake, WINDOW, &folder, PLAN, &make_blocked)
        .unwrap_err();
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    assert_eq!(calls(&fake), ["open 7"]);

    let blocked = recording
        .start(&fake, WINDOW, &next, PLAN, &make)
        .unwrap_err();
    assert!(
        blocked.contains("is running"),
        "another capture was allowed: {blocked}"
    );
    assert!(!next.exists());

    unblock_directory(&folder).unwrap();
    recording
        .abort(&fake)
        .expect("abort did not retry folder cleanup");
    assert_eq!(calls(&fake), ["open 7"]);
    assert_eq!(recording.running(), None);
}

// contract: recording.abort.stop-complete-cleanup-retry-skips-stop
#[test]
fn a_directory_cleanup_retry_does_not_stop_a_completed_capture_twice() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &folder, PLAN, &make)
        .unwrap();
    block_directory(&folder).unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    assert!(folder.is_dir());
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);

    unblock_directory(&folder).unwrap();
    recording
        .abort(&fake)
        .expect("abort did not retry directory cleanup");
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
    assert_eq!(recording.running(), None);
}

// contract: recording.start.make-failure-preserves-unowned-path
#[test]
fn a_make_failure_preserves_a_path_that_recording_did_not_create() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("existing");
    std::fs::create_dir(&folder).unwrap();
    let sentinel = folder.join("owned-by-caller");
    std::fs::write(&sentinel, "preserve").unwrap();
    let recording = Recording::new();
    let fake = Fake::default();

    let error = recording
        .start(&fake, WINDOW, &folder, PLAN, &|_| {
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
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let fault = Fault::set(
        START_FAULT,
        "the first still was not written before the window closed",
    );
    assert_eq!(
        recording
            .start(&fake, WINDOW, &folder, PLAN, &make)
            .unwrap_err(),
        "the first still was not written before the window closed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
    // The native start ends its recording when still 0 fails, so the recording asks for no stop.
    assert_eq!(calls(&fake), ["open 7", "start"]);
    drop(fault);
    recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            PLAN,
            &make,
        )
        .expect("next start after a failed start");
}

// contract: recording.start.no-first-still-removes-folder
#[test]
fn a_failed_first_still_removes_the_folder() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let fault = Fault::set(START_FAULT, "window 7 is not on screen");
    assert_eq!(
        recording
            .start(&fake, WINDOW, &folder, PLAN, &make)
            .unwrap_err(),
        "window 7 is not on screen"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
    // The native start ended its recording with still 0, so the recording asks for no stop.
    assert_eq!(calls(&fake), ["open 7", "start"]);
    drop(fault);
    recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            PLAN,
            &make,
        )
        .expect("next start after a failed first still");
}

// contract: recording.start.rejects-while-running, recording.abort.stops-removes-and-allows-next, recording.target.prepared-each-recording
#[test]
fn an_aborted_recording_is_stopped_and_removed_and_allows_the_next() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let first = parent.path().join("first");
    let second = parent.path().join("second");
    let recording = Recording::new();
    let fake = Fake::default();
    recording.start(&fake, WINDOW, &first, PLAN, &make).unwrap();
    let refused = recording
        .start(&fake, WINDOW, &second, PLAN, &make)
        .unwrap_err();
    assert!(refused.contains("is running"), "{refused}");
    assert!(!second.exists());
    recording.abort(&fake).unwrap();
    assert!(!first.exists());
    recording
        .start(&fake, WINDOW, &second, PLAN, &make)
        .unwrap();
    // The preparation reads the windows of the target at that time, so even the same window is prepared again for every
    // recording.
    assert_eq!(calls(&fake), ["open 7", "start", "stop", "open 7", "start"]);
}

// contract: recording.abort.retired-stop-failure-removes-folder
#[test]
fn an_abort_removes_retired_folder_and_reports_stop_error() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let fault = Fault::set(STOP_FAULT, "stop failed");
    recording
        .start(&fake, WINDOW, &folder, PLAN, &make)
        .unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(error.contains("stop failed"), "{error}");
    assert!(!folder.exists(), "retired folder was kept");
    assert_eq!(recording.running(), None);
    drop(fault);
    recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            PLAN,
            &make,
        )
        .expect("next start after an abort whose stop failed");
}

// contract: recording.abort.retired-stop-failure-cleanup-retry-skips-stop
#[test]
fn an_abort_retries_retired_folder_cleanup_without_repeating_stop() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake::default();
    let _fault = Fault::set(STOP_FAULT, "stop failed");
    recording
        .start(&fake, WINDOW, &folder, PLAN, &make)
        .unwrap();
    block_directory(&folder).unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(error.contains("stop failed"), "{error}");
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert!(folder.is_dir());
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    unblock_directory(&folder).unwrap();
    recording.abort(&fake).unwrap();
    assert_eq!(recording.running(), None);
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
}

// contract: recording.target.different-target-reopened
#[test]
fn a_different_target_is_prepared_again() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(&fake, WINDOW, &parent.path().join("window"), PLAN, &make)
        .unwrap();
    recording.finish(&fake).unwrap();
    let display = Target {
        window: 7,
        display: true,
    };
    recording
        .start(&fake, display, &parent.path().join("display"), PLAN, &make)
        .unwrap();
    recording.finish(&fake).unwrap();
    assert_eq!(
        calls(&fake),
        ["open 7", "start", "stop", "open 7 display", "start", "stop"]
    );
}

// contract: recording.finish.reports-the-recorded-window
#[test]
fn a_finished_recording_reports_its_window() {
    let _serial = serial();
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    let display = Target {
        window: 7,
        display: true,
    };
    recording
        .start(&fake, display, &parent.path().join("display"), PLAN, &make)
        .unwrap();
    // A display recording has no window of its own.
    assert_eq!(recording.finish(&fake).unwrap().2, None);
    let window = Target {
        window: 9,
        display: false,
    };
    recording
        .start(&fake, window, &parent.path().join("window"), PLAN, &make)
        .unwrap();
    assert_eq!(recording.finish(&fake).unwrap().2, Some(9));
}

/// The counts of the stills of the recordings of the payload tests.
const STILLS: StillCounts = StillCounts {
    missed: 0,
    late: 0,
    longest_gap: 0.0,
};

// contract: diagnostics.capture-stop.payload-reports-stills
#[test]
fn the_stop_payload_reports_the_stills() {
    let payload = stop_payload(
        Path::new("/tmp/frames"),
        598,
        StillCounts {
            missed: 2,
            late: 5,
            longest_gap: 42.5,
        },
        Some(31),
    );
    assert_eq!(
        payload,
        serde_json::json!({"frames": "/tmp/frames", "stills": "/tmp/frames/stills.jsonl", "displayLink": "/tmp/frames/display-link.json", "count": 598, "missed": 2, "late": 5, "longestGap": 42.5, "window": 31})
    );
    // A display recording has no window of its own: the member is null, not absent.
    let display = stop_payload(Path::new("/tmp/frames"), 3, STILLS, None);
    assert_eq!(display.get("window"), Some(&serde_json::Value::Null));
}

// contract: diagnostics.layout-trace.reply-reports-layouts
#[test]
fn a_layout_trace_without_transactions_reports_an_empty_list() {
    assert_eq!(layout_trace(&[], &HashMap::new()), serde_json::json!([]));
}

// contract: diagnostics.layout-trace.reply-preserves-layout-stages
#[test]
fn a_layout_trace_keeps_the_stages_of_each_transaction() {
    // The transaction of ticket 8 began without a preparation of the trace, so it has no viewport.
    let viewports = HashMap::from([(
        7,
        LayoutViewport {
            width: 1800.0,
            height: 1081.0,
        },
    )]);
    let layouts = layout_trace(
        &[
            LayoutRecord {
                ticket: 7,
                begun: 10.0,
                requested: 15.0,
                presented: 20.0,
                committed: 30.0,
                commit_path: Some("view-join"),
                open_at_commit: 1.0,
                flushed: 35.0,
                displayed: 41.6,
                refreshed: 33.3,
            },
            LayoutRecord {
                ticket: 8,
                begun: 40.0,
                requested: f64::NAN,
                presented: f64::NAN,
                committed: f64::NAN,
                commit_path: None,
                open_at_commit: f64::NAN,
                flushed: f64::NAN,
                displayed: f64::NAN,
                refreshed: f64::NAN,
            },
        ],
        &viewports,
    );
    assert_eq!(
        layouts,
        serde_json::json!([
            {"ticket":7,"begun":10.0,"requested":15.0,"presented":20.0,"committed":30.0,"commitPath":"view-join","openAtCommit":1.0,"flushed":35.0,"displayed":41.6,"refreshed":33.3,"viewport":{"width":1800.0,"height":1081.0}},
            {"ticket":8,"begun":40.0,"requested":null,"presented":null,"committed":null,"commitPath":null,"openAtCommit":null,"flushed":null,"displayed":null,"refreshed":null,"viewport":null}
        ])
    );
}

/// A recording device that becomes active before its start call panics. A stop ends the native recording; a panicking stop
/// leaves it active.
struct Panicking {
    active: Cell<bool>,
    stops: Cell<usize>,
    panic_first_stop: bool,
}

impl Capture for Panicking {
    fn open(&self, _target: Target) -> Result<(), String> {
        Ok(())
    }
    fn start(&self, _directory: &Path, _plan: Plan) -> Result<(), String> {
        self.active.set(true);
        panic!("capture start panicked")
    }
    fn stop(&self) -> Result<i32, String> {
        self.stops.set(self.stops.get() + 1);
        if self.stops.get() == 1 && self.panic_first_stop {
            panic!("first stop panicked");
        }
        self.active.set(false);
        Ok(0)
    }
}

// contract: recording.start.panicking-capture-is-cleaned-up
#[test]
fn a_panicking_capture_start_stops_partial_capture_before_unwinding() {
    let _serial = serial();
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        panic_first_stop: false,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, PLAN, &make);
    }));
    assert!(panicked.is_err());
    assert_eq!(capture.stops.get(), 1, "partial capture was not stopped");
    assert!(
        !capture.active.get(),
        "capture remained active after start panicked"
    );
    assert!(!folder.exists(), "folder remained after start panicked");
    assert_eq!(recording.running(), None);
    writer.flush().unwrap();
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

// contract: recording.start.panicking-capture-retired-stop-error-releases-owner
#[test]
fn a_panicking_start_releases_retired_capture_after_stop_error() {
    let _serial = serial();
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        panic_first_stop: false,
    };
    let _fault = Fault::set(STOP_FAULT, "first stop failed");
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, PLAN, &make);
    }));
    assert!(panicked.is_err());
    assert!(!capture.active.get(), "the native recording was not ended");
    assert!(!folder.exists(), "retired folder was retained");
    assert_eq!(recording.running(), None);
    writer.flush().unwrap();
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
            .any(|error| error.contains("capture stop failed: first stop failed")),
        "stop error was not reported: {errors:?}"
    );
}

// contract: recording.start.panic-cleanup-failure-blocks-next-start
#[test]
fn a_failed_panic_cleanup_retains_state_until_abort_retries() {
    let _serial = serial();
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let next = config.path().join("next-frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        panic_first_stop: true,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, PLAN, &make);
    }));
    assert!(panicked.is_err());
    assert!(
        capture.active.get(),
        "a panicking stop was reported as a cleanup"
    );
    assert!(
        folder.is_dir(),
        "the owned folder was removed before capture stopped"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));

    let error = recording
        .start(&Fake::default(), WINDOW, &next, PLAN, &make)
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
    writer.flush().unwrap();
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
            .any(|error| error.contains("capture stop panicked")),
        "cleanup failure was not reported: {errors:?}"
    );
}
