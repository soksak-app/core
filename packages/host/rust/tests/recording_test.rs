//! Tests of the diagnostic recording state. The state decides from the answers of the recording device and of the filesystem:
//! those decisions are replayed from the case table docs/spec/cases/recording/decisions.json that the Go host replays too, and
//! the removal that the cases leave to the filesystem is judged on the real filesystem. The device itself, the recorder of the
//! window server, is judged by e2e/capture-state.test.mjs, because a recording needs the images of a window of a display. They
//! are compiled only in diagnostic builds.
#![cfg(feature = "diagnostics")]

#[path = "support/folder.rs"]
mod folder;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

#[path = "support/records.rs"]
mod records;

use serde_json::Value;
use soksak_host::event_record::use_host_event_log;
use soksak_host::platform::LayoutRecord;
use soksak_host::recording::{
    Capture, Plan, Recording, StillCounts, StopAnswer, Target, layout_trace, needs_stop,
    panic_removal, panic_stop, refuse_finish, refuse_start, report_panic_cleanup, settle_cleanup,
    stop_failure, stop_payload,
};
use soksak_host::surfaces::LayoutViewport;

/// The recording device of a test whose judged code must not reach the device: a call fails the test.
struct Unreached;

impl Capture for Unreached {
    fn open(&self, _target: Target) -> Result<(), String> {
        panic!("the recording opened its target")
    }
    fn start(&self, _directory: &Path, _plan: Plan) -> Result<(), String> {
        panic!("the recording started")
    }
    fn stop(&self) -> Result<i32, String> {
        panic!("the recording stopped")
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

/// The case table of the decisions of the recording state.
fn cases(table: &str) -> Vec<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/recording/decisions.json"
    );
    let text = std::fs::read_to_string(path).expect("recording case table");
    let all: Value = serde_json::from_str(&text).expect("recording case table JSON");
    all[table].as_array().expect("case list").clone()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn directory_of(case: &Value) -> Option<std::path::PathBuf> {
    text(&case["directory"])
        .filter(|directory| !directory.is_empty())
        .map(Into::into)
}

/// Makes a folder with a file in it and removes its permissions, so the real filesystem refuses its removal.
fn blocked_folder(parent: &Path) -> std::path::PathBuf {
    let folder = parent.join("frames");
    std::fs::create_dir(&folder).unwrap();
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/recording/blocker"),
        folder.join("blocker"),
    )
    .unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o000)).unwrap();
    folder
}

/// Restores the permissions of path that blocked_folder removed.
fn unblock(path: &Path) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Makes a folder with the records that a started recording leaves in it.
fn folder_with_records(parent: &Path) -> std::path::PathBuf {
    let folder = parent.join("frames");
    std::fs::create_dir(&folder).unwrap();
    for name in ["stills.jsonl", "display-link.json"] {
        std::fs::write(folder.join(name), "{}\n").unwrap();
    }
    folder
}

/// The removal result of the real filesystem as a case gives it: the error text, none for a removal that succeeded.
fn removal_of(path: &Path) -> Option<String> {
    std::fs::remove_dir_all(path).err().map(|e| e.to_string())
}

fn require_cleanup(cause: Option<&str>, removal: Option<&str>, owner: bool, error: Option<&str>) {
    let got = settle_cleanup(cause.map(str::to_string), removal);
    assert_eq!(
        (got.retain_owner, got.error.as_deref()),
        (owner, error),
        "cleanup of cause {cause:?} and removal {removal:?}"
    );
}

/// Replays the settle_cleanup case id with the answers that the case gives.
fn replay_cleanup(id: &str) {
    let case = cases("settleCleanup")
        .into_iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("no case {id}"));
    require_cleanup(
        case["cause"].as_str(),
        case["removal"].as_str(),
        case["retainOwner"].as_bool().unwrap(),
        case["error"].as_str(),
    );
}

fn make_new(path: &Path) -> Result<(), String> {
    std::fs::create_dir(path).map_err(|e| e.to_string())
}

// contract: recording.start.rejects-while-running
#[test]
fn start_is_refused_while_a_folder_is_owned() {
    for case in cases("refuseStart") {
        assert_eq!(
            refuse_start(directory_of(&case).as_deref()),
            text(&case["error"]),
            "{}",
            case["id"]
        );
    }
}

// contract: recording.finish.keeps-folder-and-reports-frames
#[test]
fn a_finished_recording_keeps_its_folder_and_reports_frames() {
    for case in cases("refuseFinish") {
        assert_eq!(
            refuse_finish(
                directory_of(&case).as_deref(),
                case["stopped"].as_bool().unwrap()
            ),
            text(&case["error"]),
            "{}",
            case["id"]
        );
    }
    // A recording that is not running has nothing to finish; the finish of a running recording keeps its folder and reports its
    // frames and window, which e2e/capture-state.test.mjs judges with the recorder of the window server.
    assert_eq!(
        Recording::new().finish(&Unreached).unwrap_err(),
        "no capture is running"
    );
}

// contract: recording.finish.retired-stop-failure-releases-owner
#[test]
fn a_retired_stop_failure_preserves_folder_and_releases_owner() {
    for case in cases("stopFailure") {
        assert_eq!(
            stop_failure(case["stop"].as_str().unwrap()),
            case["error"].as_str().unwrap(),
            "{}",
            case["id"]
        );
    }
    // The finish of a recording whose stop failed leaves the empty state: it owns no folder, so the next start is accepted and a
    // finish reports no recording, and it removes nothing, so the folder that the start returned stays.
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    let recording = Recording::new();
    assert_eq!(refuse_start(recording.running().as_deref()), None);
    assert_eq!(
        recording.finish(&Unreached).unwrap_err(),
        "no capture is running"
    );
    assert!(
        folder.is_dir(),
        "the folder of the retired recording was removed"
    );
}

// contract: recording.start.failed-open-removes-folder
#[test]
fn a_failed_open_removes_the_folder() {
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    require_cleanup(
        Some("window 7 is not on screen"),
        removal_of(&folder).as_deref(),
        false,
        Some("window 7 is not on screen"),
    );
    assert!(!folder.exists());
    replay_cleanup("failed-open-folder-removed");
}

// contract: recording.start.failed-start-removes-folder
#[test]
fn a_failed_start_removes_the_folder() {
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    let cause = "the first still was not written before the window closed";
    require_cleanup(
        Some(cause),
        removal_of(&folder).as_deref(),
        false,
        Some(cause),
    );
    assert!(!folder.exists());
    replay_cleanup("failed-start-folder-removed");
}

// contract: recording.start.no-first-still-removes-folder
#[test]
fn a_failed_first_still_removes_the_folder() {
    // The native start ended its recording with still 0 and wrote its records into the folder, so the folder holds them when the
    // removal runs, and no stop follows: the owner is released with the folder.
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    require_cleanup(
        Some("window 7 is not on screen"),
        removal_of(&folder).as_deref(),
        false,
        Some("window 7 is not on screen"),
    );
    assert!(!folder.exists());
    assert!(!needs_stop(None, false));
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
    let error = recording
        .start(&Unreached, WINDOW, &folder, PLAN, &make_new)
        .unwrap_err();
    assert!(error.contains("exists"), "{error}");
    assert!(sentinel.is_file(), "the caller-owned path was deleted");
    assert_eq!(recording.running(), None);
}

// contract: recording.start.cleanup-failure-retains-folder-owner
#[test]
fn a_failed_start_cleanup_retains_retry_ownership() {
    let parent = folder::Folder::new();
    let folder = blocked_folder(parent.path());
    let removal = removal_of(&folder).expect("the filesystem removed a folder without permissions");
    let want = format!("window 7 is not on screen; capture directory cleanup failed: {removal}");
    require_cleanup(
        Some("window 7 is not on screen"),
        Some(&removal),
        true,
        Some(&want),
    );
    // The folder stays owned: another start is refused until the cleanup completes.
    assert!(refuse_start(Some(&folder)).is_some());
    unblock(&folder);
    require_cleanup(None, removal_of(&folder).as_deref(), false, None);
    assert!(!folder.exists());
    replay_cleanup("failed-start-folder-kept");
}

// contract: recording.abort.stops-removes-and-allows-next
#[test]
fn an_aborted_recording_is_stopped_and_removed_and_allows_the_next() {
    for case in cases("needsStop") {
        assert_eq!(
            needs_stop(
                directory_of(&case).as_deref(),
                case["stopped"].as_bool().unwrap()
            ),
            case["stop"].as_bool().unwrap(),
            "{}",
            case["id"]
        );
    }
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    require_cleanup(None, removal_of(&folder).as_deref(), false, None);
    assert!(!folder.exists(), "the aborted folder remains");
    replay_cleanup("abort-nothing-failed");
    // An abort of a recording that is not running does nothing, so the next recording starts.
    Recording::new().abort(&Unreached).unwrap();
}

// contract: recording.abort.retired-stop-failure-removes-folder
#[test]
fn an_abort_removes_retired_folder_and_reports_stop_error() {
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    let stop = stop_failure("stop failed");
    require_cleanup(
        Some(&stop),
        removal_of(&folder).as_deref(),
        false,
        Some("capture stop failed: stop failed"),
    );
    assert!(!folder.exists(), "retired folder was kept");
    replay_cleanup("abort-stop-failed-folder-removed");
}

// contract: recording.abort.retired-stop-failure-cleanup-retry-skips-stop
#[test]
fn an_abort_retries_retired_folder_cleanup_without_repeating_stop() {
    let parent = folder::Folder::new();
    let folder = blocked_folder(parent.path());
    let removal = removal_of(&folder).expect("the filesystem removed a folder without permissions");
    let stop = stop_failure("stop failed");
    let want =
        format!("capture stop failed: stop failed; capture directory cleanup failed: {removal}");
    require_cleanup(Some(&stop), Some(&removal), true, Some(&want));
    // The native recording has ended, so the retry stops nothing and removes the folder.
    assert!(!needs_stop(Some(&folder), true));
    unblock(&folder);
    require_cleanup(None, removal_of(&folder).as_deref(), false, None);
    assert!(!folder.exists());
    replay_cleanup("abort-stop-failed-folder-kept");
}

// contract: recording.abort.stop-complete-cleanup-retry-skips-stop
#[test]
fn a_directory_cleanup_retry_does_not_stop_a_completed_capture_twice() {
    let parent = folder::Folder::new();
    let folder = blocked_folder(parent.path());
    let removal = removal_of(&folder).expect("the filesystem removed a folder without permissions");
    let want = format!("capture directory cleanup failed: {removal}");
    require_cleanup(None, Some(&removal), true, Some(&want));
    assert!(!needs_stop(Some(&folder), true));
    unblock(&folder);
    require_cleanup(None, removal_of(&folder).as_deref(), false, None);
    assert!(!folder.exists());
    replay_cleanup("abort-folder-kept");
}

// contract: recording.state.poisoned-lock-is-recovered
#[test]
fn a_poisoned_recording_state_is_recovered_when_it_ends() {
    let parent = folder::Folder::new();
    let folder = parent.path().join("frames");
    let recording = Recording::new();
    // The folder is made while the state lock is held, so a panic there poisons the lock.
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = recording.start(&Unreached, WINDOW, &folder, PLAN, &|_| {
            panic!("the creation of the folder panicked")
        });
    }));
    assert!(panic.is_err(), "the creation did not panic");
    assert_eq!(
        recording.running(),
        None,
        "reading a poisoned recording state failed"
    );
    recording
        .abort(&Unreached)
        .expect("abort did not recover the poisoned state");
    assert_eq!(recording.running(), None);
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

/// The records of the host are process-wide, so the tests that read the errors of their own cleanup run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The errors that a cleanup after a panic wrote to the application log of a real event writer.
fn reported_errors(cleanup: &soksak_host::recording::PanicCleanup) -> Vec<String> {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let config = folder::Folder::new();
    let writer = records::start_writer(config.path());
    report_panic_cleanup(cleanup);
    writer.flush().unwrap();
    use_host_event_log(None);
    records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| {
            event["event"] == "host.record.error" && event["fields"]["where"] == "recording"
        })
        .map(|event| event["fields"]["text"].as_str().unwrap().to_string())
        .collect()
}

// contract: recording.start.panicking-capture-is-cleaned-up
#[test]
fn a_panicking_capture_start_stops_partial_capture_before_unwinding() {
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    // The start reached the capture and the stop succeeded: the capture ends and the folder is removed.
    let cleanup = panic_removal(
        panic_stop(true, Some(StopAnswer::Stopped)),
        removal_of(&folder).as_deref(),
    );
    assert!(cleanup.capture_stopped && !cleanup.retain_owner && cleanup.errors.is_empty());
    assert!(!folder.exists(), "folder remained after start panicked");
    assert_eq!(reported_errors(&cleanup), Vec::<String>::new());
}

// contract: recording.start.panicking-capture-retired-stop-error-releases-owner
#[test]
fn a_panicking_start_releases_retired_capture_after_stop_error() {
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    let cleanup = panic_removal(
        panic_stop(true, Some(StopAnswer::Failed("first stop failed".into()))),
        removal_of(&folder).as_deref(),
    );
    assert!(
        cleanup.capture_stopped,
        "the native recording was not ended"
    );
    assert!(!cleanup.retain_owner);
    assert!(!folder.exists(), "retired folder was retained");
    let errors = reported_errors(&cleanup);
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
    let parent = folder::Folder::new();
    let folder = folder_with_records(parent.path());
    // A stop that panicked leaves the capture active, so the folder is not removed and the owner stays.
    let cleanup = panic_stop(true, Some(StopAnswer::Panicked));
    assert!(!cleanup.capture_stopped && cleanup.retain_owner);
    assert!(
        folder.is_dir(),
        "the owned folder was removed before capture stopped"
    );
    assert!(
        refuse_start(Some(&folder)).is_some(),
        "a new capture was allowed"
    );
    let errors = reported_errors(&cleanup);
    assert!(
        errors
            .iter()
            .any(|error| error.contains("capture stop panicked")),
        "cleanup failure was not reported: {errors:?}"
    );
    // The retry stops the capture that stayed active and removes the folder.
    assert!(needs_stop(Some(&folder), cleanup.capture_stopped));
    require_cleanup(None, removal_of(&folder).as_deref(), false, None);
    assert!(!folder.exists());
}
