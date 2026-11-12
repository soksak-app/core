//! Tests of the diagnostic recording state. A fake replaces the recording device. They are compiled only in diagnostic
//! builds.
#![cfg(feature = "diagnostics")]

#[path = "support/folder.rs"]
mod folder;

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::sync::Mutex;

#[path = "support/records.rs"]
mod records;

use soksak_host::event_record::use_host_event_log;
use soksak_host::platform::LayoutRecord;
use soksak_host::recording::{Capture, Plan, Recording, StillCounts, Target, stop_payload};

/// The records of the host are process-wide, so the tests of this file that attach a writer run one at a time: a test reads
/// only the errors that its own recording wrote.
static SERIAL: Mutex<()> = Mutex::new(());

/// A recording device that records calls and fails at the specified stage. A failed start and a failed stop end the
/// native recording, as the native capture does.
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<String>>,
    plans: RefCell<Vec<Plan>>,
    fail_open: bool,
    fail_start: bool,
    fail_first_still: bool,
    fail_stop: bool,
    panic_stop_once: Cell<bool>,
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
    fn start(&self, directory: &Path, plan: Plan, frame_identity: bool) -> Result<(), String> {
        self.calls.borrow_mut().push(if frame_identity {
            "start frameIdentity".into()
        } else {
            "start".into()
        });
        self.plans.borrow_mut().push(plan);
        if self.fail_start {
            return Err("the first still was not written before the window closed".into());
        }
        if self.fail_first_still {
            // The native start ends its recording when still 0 fails and writes its records into the folder before it
            // answers.
            for name in ["stills.jsonl", "display-link.json"] {
                std::fs::write(directory.join(name), "{}\n").map_err(|error| error.to_string())?;
            }
            return Err("window 7 is not on screen".into());
        }
        Ok(())
    }
    fn stop(&self) -> Result<i32, String> {
        self.calls.borrow_mut().push("stop".into());
        if self.panic_stop_once.replace(false) {
            panic!("fixture stop panic");
        }
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

/// The plan of the stills of the recordings of these tests.
const PLAN: Plan = Plan {
    gap: 8.0,
    seconds: 0.0,
    frames: 120,
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
        .start(&fake, WINDOW, &folder, PLAN, true, &make)
        .unwrap();
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    let (directory, count, frame_identity, window) = recording.finish(&fake).unwrap();
    assert_eq!(
        (directory, count, frame_identity, window),
        (folder.clone(), 3, true, Some(WINDOW.window))
    );
    assert!(folder.is_dir());
    assert_eq!(calls(&fake), ["open 7", "start frameIdentity", "stop"]);
    assert_eq!(*fake.plans.borrow(), [PLAN]);
    assert!(recording.finish(&fake).is_err());
}

// contract: recording.state.poisoned-lock-is-recovered
#[test]
fn a_poisoned_recording_state_is_recovered_when_it_ends() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        panic_stop_once: Cell::new(true),
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, PLAN, false, &make)
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
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_stop: true,
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, PLAN, false, &make)
        .unwrap();

    assert_eq!(recording.finish(&fake).unwrap_err(), "stop failed");
    assert!(folder.is_dir(), "retired folder was deleted");
    assert_eq!(
        recording.running(),
        None,
        "retired recording owner remained"
    );
    let next = parent.path().join("next-frames");
    recording
        .start(&Fake::default(), WINDOW, &next, PLAN, false, &make)
        .expect("next recording should start after native ownership retired");
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
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
            .start(&fake, WINDOW, &folder, PLAN, false, &make)
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
        .start(&fake, WINDOW, &folder, PLAN, false, &make)
        .unwrap_err();
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    assert_eq!(calls(&fake), ["open 7"]);

    let blocked = recording
        .start(&fake, WINDOW, &next, PLAN, false, &make)
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
        .start(&fake, WINDOW, &folder, PLAN, false, &make)
        .unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    assert!(folder.is_file());
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);

    std::fs::remove_file(&folder).unwrap();
    recording
        .abort(&fake)
        .expect("abort did not retry directory cleanup");
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
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
        .start(&fake, WINDOW, &folder, PLAN, false, &|_| {
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
            .start(&fake, WINDOW, &folder, PLAN, false, &make)
            .unwrap_err(),
        "the first still was not written before the window closed"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
    // The native start ends its recording when still 0 fails, so the recording asks for no stop.
    assert_eq!(calls(&fake), ["open 7", "start"]);
    recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            PLAN,
            false,
            &make,
        )
        .expect("next start after a failed start");
}

// contract: recording.start.no-first-still-removes-folder
#[test]
fn a_failed_first_still_removes_the_folder() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_first_still: true,
        ..Fake::default()
    };
    assert_eq!(
        recording
            .start(&fake, WINDOW, &folder, PLAN, false, &make)
            .unwrap_err(),
        "window 7 is not on screen"
    );
    assert!(!folder.exists());
    assert_eq!(recording.running(), None);
    // The native start ended its recording with still 0, so the recording asks for no stop.
    assert_eq!(calls(&fake), ["open 7", "start"]);
    recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            PLAN,
            false,
            &make,
        )
        .expect("next start after a failed first still");
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
        .start(&fake, WINDOW, &first, PLAN, false, &make)
        .unwrap();
    let refused = recording
        .start(&fake, WINDOW, &second, PLAN, false, &make)
        .unwrap_err();
    assert!(refused.contains("is running"), "{refused}");
    assert!(!second.exists());
    recording.abort(&fake).unwrap();
    assert!(!first.exists());
    recording
        .start(&fake, WINDOW, &second, PLAN, false, &make)
        .unwrap();
    // The preparation reads the windows of the target at that time, so even the same window is prepared again for every
    // recording.
    assert_eq!(calls(&fake), ["open 7", "start", "stop", "open 7", "start"]);
}

// contract: recording.abort.retired-stop-failure-removes-folder
#[test]
fn an_abort_removes_retired_folder_and_reports_stop_error() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_stop: true,
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, PLAN, false, &make)
        .unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(error.contains("stop failed"), "{error}");
    assert!(!folder.exists(), "retired folder was kept");
    assert_eq!(recording.running(), None);
    recording
        .start(
            &Fake::default(),
            WINDOW,
            &parent.path().join("next"),
            PLAN,
            false,
            &make,
        )
        .expect("next start after an abort whose stop failed");
}

// contract: recording.abort.retired-stop-failure-cleanup-retry-skips-stop
#[test]
fn an_abort_retries_retired_folder_cleanup_without_repeating_stop() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    let fake = Fake {
        fail_stop: true,
        replace_directory_on_stop: Some(folder.clone()),
        ..Fake::default()
    };
    recording
        .start(&fake, WINDOW, &folder, PLAN, false, &make)
        .unwrap();

    let error = recording.abort(&fake).unwrap_err();
    assert!(error.contains("stop failed"), "{error}");
    assert!(
        error.contains("capture directory cleanup failed"),
        "{error}"
    );
    assert!(folder.is_file());
    assert_eq!(recording.running().as_deref(), Some(folder.as_path()));
    std::fs::remove_file(&folder).unwrap();
    recording.abort(&fake).unwrap();
    assert_eq!(recording.running(), None);
    assert_eq!(calls(&fake), ["open 7", "start", "stop"]);
}

// contract: recording.target.different-target-reopened
#[test]
fn a_different_target_is_prepared_again() {
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(
            &fake,
            WINDOW,
            &parent.path().join("window"),
            PLAN,
            false,
            &make,
        )
        .unwrap();
    recording.finish(&fake).unwrap();
    let display = Target {
        window: 7,
        display: true,
    };
    recording
        .start(
            &fake,
            display,
            &parent.path().join("display"),
            PLAN,
            false,
            &make,
        )
        .unwrap();
    recording.finish(&fake).unwrap();
    assert_eq!(
        calls(&fake),
        ["open 7", "start", "stop", "open 7 display", "start", "stop"]
    );
}

// contract: diagnostics.capture-start.forwards-frame-identity
#[test]
fn recording_start_forwards_frame_identity() {
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    recording
        .start(
            &fake,
            WINDOW,
            &parent.path().join("frames"),
            PLAN,
            true,
            &make,
        )
        .unwrap();
    assert_eq!(calls(&fake), ["open 7", "start frameIdentity"]);
}

// contract: recording.finish.reports-the-recorded-window
#[test]
fn a_finished_recording_reports_its_window() {
    let parent = folder::Folder::new();
    let recording = Recording::new();
    let fake = Fake::default();
    let display = Target {
        window: 7,
        display: true,
    };
    recording
        .start(
            &fake,
            display,
            &parent.path().join("display"),
            PLAN,
            false,
            &make,
        )
        .unwrap();
    // A display recording has no window of its own.
    assert_eq!(recording.finish(&fake).unwrap().3, None);
    let window = Target {
        window: 9,
        display: false,
    };
    recording
        .start(
            &fake,
            window,
            &parent.path().join("window"),
            PLAN,
            false,
            &make,
        )
        .unwrap();
    assert_eq!(recording.finish(&fake).unwrap().3, Some(9));
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
        &[],
        false,
        Some(31),
    );
    assert_eq!(
        payload,
        serde_json::json!({"frames": "/tmp/frames", "stills": "/tmp/frames/stills.jsonl", "displayLink": "/tmp/frames/display-link.json", "count": 598, "missed": 2, "late": 5, "longestGap": 42.5, "layouts": [], "window": 31})
    );
    // A display recording has no window of its own: the member is null, not absent.
    let display = stop_payload(Path::new("/tmp/frames"), 3, STILLS, &[], false, None);
    assert_eq!(display.get("window"), Some(&serde_json::Value::Null));
}

// contract: diagnostics.capture-stop.payload-names-opt-in-frame-identity-artifact
#[test]
fn the_stop_payload_names_the_opt_in_frame_identity_artifact() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, STILLS, &[], true, None);
    assert_eq!(payload["frameIdentity"]["status"], "complete");
    assert_eq!(
        payload["frameIdentity"]["manifest"],
        "/tmp/frames/frame-identities/manifest.json"
    );
}

// contract: diagnostics.capture-stop.payload-reports-layout-timeline
#[test]
fn the_stop_payload_requires_a_layout_timeline() {
    let payload = stop_payload(Path::new("/tmp/frames"), 3, STILLS, &[], false, None);
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
        STILLS,
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
            },
        ],
        false,
        None,
    );
    assert_eq!(
        payload["layouts"],
        serde_json::json!([
            {"ticket":7,"begun":10.0,"requested":15.0,"presented":20.0,"committed":30.0,"commitPath":"view-join","openAtCommit":1.0,"flushed":35.0},
            {"ticket":8,"begun":40.0,"requested":null,"presented":null,"committed":null,"commitPath":null,"openAtCommit":null,"flushed":null}
        ])
    );
}

/// A recording device that becomes active before its start call panics. A failed stop ends the native recording, as the
/// native capture does; a panicking stop leaves it active.
struct Panicking {
    active: Cell<bool>,
    stops: Cell<usize>,
    fail_first_stop: bool,
    panic_first_stop: bool,
}

impl Capture for Panicking {
    fn open(&self, _target: Target) -> Result<(), String> {
        Ok(())
    }
    fn start(&self, _directory: &Path, _plan: Plan, _frame_identity: bool) -> Result<(), String> {
        self.active.set(true);
        panic!("capture start panicked")
    }
    fn stop(&self) -> Result<i32, String> {
        self.stops.set(self.stops.get() + 1);
        if self.stops.get() == 1 {
            if self.panic_first_stop {
                panic!("first stop panicked");
            }
            if self.fail_first_stop {
                self.active.set(false);
                return Err("first stop failed".into());
            }
        }
        self.active.set(false);
        Ok(0)
    }
}

// contract: recording.start.panicking-capture-is-cleaned-up
#[test]
fn a_panicking_capture_start_stops_partial_capture_before_unwinding() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        fail_first_stop: false,
        panic_first_stop: false,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, PLAN, false, &make);
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
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        fail_first_stop: true,
        panic_first_stop: false,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, PLAN, false, &make);
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
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    let folder = config.path().join("frames");
    let next = config.path().join("next-frames");
    let recording = Recording::new();
    let capture = Panicking {
        active: Cell::new(false),
        stops: Cell::new(0),
        fail_first_stop: false,
        panic_first_stop: true,
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&capture, WINDOW, &folder, PLAN, false, &make);
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
        .start(&Fake::default(), WINDOW, &next, PLAN, false, &make)
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
