use super::*;
use std::cell::{Cell, RefCell};
use std::sync::mpsc;
use std::time::Duration;

struct IdentityCaptureProbe;

impl Capture for IdentityCaptureProbe {
    fn open(&self, _target: Target) -> Result<(), String> {
        Ok(())
    }

    fn start(&self, _directory: &Path, _frame_identity: bool) -> Result<(), String> {
        Ok(())
    }

    fn wait(&self) -> Result<bool, String> {
        Ok(true)
    }

    fn stop(&self) -> Result<i32, String> {
        Ok(1)
    }
}

// contract: recording.finish.layout-trace-failure-preserves-folder
#[test]
fn a_layout_trace_failure_keeps_the_started_capture_folder() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("frames");
    std::fs::create_dir_all(&folder).unwrap();

    let result = finish_capture_stop(&folder, 1, false, || {
        Err(internal("layout trace stop failed"))
    });

    assert_eq!(result.unwrap_err().message, "layout trace stop failed");
    assert!(folder.is_dir(), "failed capture evidence was removed");
}

// contract: diagnostics.capture-document-identity.stop-preserves-captures-without-a-document-source
#[test]
fn capture_stop_preserves_capture_modes_without_document_source() {
    for frame_identity in [false, true] {
        let freeze_calls = Cell::new(0);
        let stop_calls = Cell::new(0);
        let remove_calls = Cell::new(0);
        let (issued, removed, error) = document_identity_stop_sequence(
            frame_identity,
            None,
            None,
            |_| {
                freeze_calls.set(freeze_calls.get() + 1);
                Ok(String::new())
            },
            || {
                stop_calls.set(stop_calls.get() + 1);
                Ok(())
            },
            |_| {
                remove_calls.set(remove_calls.get() + 1);
                Ok(String::new())
            },
        );
        assert_eq!(error, None, "frameIdentity={frame_identity}");
        assert_eq!(issued, None, "frameIdentity={frame_identity}");
        assert!(removed, "frameIdentity={frame_identity}");
        assert_eq!(
            (freeze_calls.get(), stop_calls.get(), remove_calls.get()),
            (0, 1, 0)
        );
    }
}

// contract: diagnostics.capture-document-identity.stop-orders-freeze-capture-and-cleanup
#[test]
fn capture_stop_freezes_and_removes_selected_source_in_order() {
    let source = ("surface-a".to_string(), 7);
    let phases = RefCell::new(Vec::new());
    let (issued, removed, error) = document_identity_stop_sequence(
        true,
        Some(&source),
        None,
        |generation| {
            phases.borrow_mut().push("freeze");
            assert_eq!(generation, 7);
            Ok(r#"{"generation":7,"atlasSlots":300,"issuedSlots":2}"#.into())
        },
        || {
            phases.borrow_mut().push("capture-stop");
            Ok(())
        },
        |generation| {
            phases.borrow_mut().push("remove");
            assert_eq!(generation, 7);
            Ok(r#"{"generation":7,"removed":true}"#.into())
        },
    );
    assert_eq!(error, None);
    assert_eq!(issued, Some(2));
    assert!(removed);
    assert_eq!(*phases.borrow(), ["freeze", "capture-stop", "remove"]);
}

// contract: diagnostics.capture-document-identity.stop-does-not-credit-unconfirmed-freeze
#[test]
fn capture_stop_continues_cleanup_after_freeze_failure_without_issued_count() {
    let source = ("surface-a".to_string(), 7);
    let stop_calls = Cell::new(0);
    let remove_calls = Cell::new(0);
    let (issued, removed, error) = document_identity_stop_sequence(
        true,
        Some(&source),
        None,
        |_| Err("freeze timeout".into()),
        || {
            stop_calls.set(stop_calls.get() + 1);
            Ok(())
        },
        |_| {
            remove_calls.set(remove_calls.get() + 1);
            Ok(r#"{"generation":7,"removed":true}"#.into())
        },
    );
    assert!(error.is_some());
    assert_eq!(issued, None);
    assert!(removed);
    assert_eq!((stop_calls.get(), remove_calls.get()), (1, 1));
}

// contract: diagnostics.capture-document-identity.stop-drains-late-start-before-cleanup
#[test]
fn capture_stop_does_not_credit_a_timed_out_start_count() {
    let source = ("surface-a".to_string(), 7);
    let phases = RefCell::new(Vec::new());
    let (issued, removed, error) = document_identity_stop_sequence(
        true,
        Some(&source),
        Some("start callback timed out".into()),
        |_| {
            phases.borrow_mut().push("freeze");
            Ok(r#"{"generation":7,"atlasSlots":300,"issuedSlots":2}"#.into())
        },
        || {
            phases.borrow_mut().push("capture-stop");
            Ok(())
        },
        |_| {
            phases.borrow_mut().push("remove");
            Ok(r#"{"generation":7,"removed":true}"#.into())
        },
    );
    assert!(error.is_some());
    assert_eq!(issued, None);
    assert!(removed);
    assert_eq!(*phases.borrow(), ["freeze", "capture-stop", "remove"]);
}

// contract: diagnostics.capture-document-identity.start-validates-current-root-generation
#[test]
fn capture_document_identity_start_resolves_only_the_current_root_document() {
    let documents = Documents::default();
    let key = ("surface-a".to_string(), String::new());
    documents.reserve(&key).unwrap();
    assert!(documents.set(&key, 41));
    documents.views().register("surface-a", "fixture", 9);
    let request = CaptureDocumentIdentityRequest {
        surface: "surface-a".into(),
        generation: 9,
    };
    assert_eq!(
        resolve_document_frame_identity_root(&documents, Some(9), &request).unwrap(),
        41
    );
    assert!(resolve_document_frame_identity_root(&documents, Some(8), &request).is_err());
    assert!(resolve_document_frame_identity_root(&documents, None, &request).is_err());
    assert!(
        resolve_document_frame_identity_root(&Documents::default(), Some(9), &request).is_err()
    );
}

// contract: diagnostics.capture-document-identity.start-rejects-invalid-parameters
#[test]
fn capture_document_identity_start_rejects_missing_empty_and_unsafe_generations() {
    for value in [
        json!({"surface":"surface-a"}),
        json!({"surface":"","generation":1}),
        json!({"surface":"surface-a","generation":0}),
        json!({"surface":"surface-a","generation":9007199254740992u64}),
        json!({"surface":"surface-a","generation":1.5}),
    ] {
        let params = value.as_object().unwrap().clone();
        assert!(
            parse_capture_document_identity_request(&params).is_err(),
            "accepted {value}"
        );
    }
}

// contract: diagnostics.capture-document-identity.start-validates-native-metadata
#[test]
fn capture_document_identity_start_requires_generation_and_measured_roi_metadata() {
    let valid =
        r#"{"generation":7,"atlasSlots":300,"roi":{"x":1,"y":2,"width":30,"height":40,"scale":2}}"#;
    let reply = validate_document_frame_identity_start_reply(valid, 7).unwrap();
    assert_eq!(reply["generation"], 7);
    let zero_origin =
        r#"{"generation":7,"atlasSlots":300,"roi":{"x":0,"y":0,"width":30,"height":40,"scale":2}}"#;
    assert!(validate_document_frame_identity_start_reply(zero_origin, 7).is_ok());
    for invalid in [
        r#"{"generation":8,"atlasSlots":300,"roi":{"x":1,"y":2,"width":30,"height":40,"scale":2}}"#,
        r#"{"generation":7,"atlasSlots":513,"roi":{"x":1,"y":2,"width":30,"height":40,"scale":2}}"#,
        r#"{"generation":7,"atlasSlots":300,"roi":{"x":1,"y":2,"width":0,"height":40,"scale":2}}"#,
        r#"{"generation":7,"atlasSlots":300,"roi":{"y":2,"width":30,"height":40,"scale":2}}"#,
        r#"{"generation":7,"atlasSlots":300,"roi":{"x":1,"width":30,"height":40,"scale":2}}"#,
        "null",
    ] {
        assert!(validate_document_frame_identity_start_reply(invalid, 7).is_err());
    }
}

// contract: diagnostics.capture-document-identity.stop-requires-issued-slots-field
#[test]
fn capture_stop_requires_issued_slots_presence_and_accepts_zero() {
    assert_eq!(
        document_frame_identity_issued_slots(
            r#"{"generation":7,"atlasSlots":300,"issuedSlots":0}"#,
            7
        )
        .unwrap(),
        0
    );
    assert!(
        document_frame_identity_issued_slots(r#"{"generation":7,"atlasSlots":300}"#, 7).is_err()
    );
}

// contract: diagnostics.capture-document-identity.start-selects-one-source-per-capture
#[test]
fn recording_selects_one_document_identity_source() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("frames");
    let recording = Recording::new();
    recording
        .start_with_document_identity(
            &IdentityCaptureProbe,
            Target {
                window: 1,
                display: false,
            },
            &directory,
            true,
            true,
            &|path| std::fs::create_dir_all(path).map_err(|error| error.to_string()),
        )
        .unwrap();
    assert_eq!(recording.frame_identity_state(), (true, None));
    recording
        .select_frame_identity_source("surface-a", 7)
        .unwrap();
    assert!(
        recording
            .select_frame_identity_source("surface-b", 8)
            .is_err()
    );
    assert_eq!(
        recording.frame_identity_state(),
        (true, Some(("surface-a".into(), 7)))
    );
    assert!(recording.clear_frame_identity_source("surface-a", 7));
    assert_eq!(recording.frame_identity_state(), (true, None));
}

// contract: diagnostics.capture-document-identity.start-requires-explicit-capture-endpoint
#[test]
fn recording_rejects_document_source_for_drag_owned_identity_capture() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("frames");
    let recording = Recording::new();
    recording
        .start(
            &IdentityCaptureProbe,
            Target {
                window: 1,
                display: false,
            },
            &directory,
            true,
            &|path| std::fs::create_dir_all(path).map_err(|error| error.to_string()),
        )
        .unwrap();
    assert!(
        recording
            .select_frame_identity_source("surface-a", 7)
            .is_err()
    );
}

// contract: diagnostics.capture-start.waits-for-prior-identity-removal
#[test]
fn capture_start_waits_for_prior_identity_removal() {
    let (recording_started, wait_recording_started) = mpsc::channel();
    let (allow_trace, wait_for_trace) = mpsc::channel();
    let (trace_started, wait_trace_started) = mpsc::channel();
    let (stop_started, wait_stop_started) = mpsc::channel();
    let start = std::thread::spawn(move || {
        super::with_document_frame_identity_lifecycle(|| {
            recording_started.send(()).unwrap();
            wait_for_trace.recv().unwrap();
            trace_started.send(()).unwrap();
            Ok::<_, Failure>(())
        });
    });
    wait_recording_started
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    let stop = std::thread::spawn(move || {
        super::with_document_frame_identity_lifecycle(|| {
            stop_started.send(()).unwrap();
            Ok::<_, Failure>(())
        });
    });
    assert!(
        wait_stop_started.try_recv().is_err(),
        "stop entered while new capture trace initialization was pending"
    );
    allow_trace.send(()).unwrap();
    wait_trace_started
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    wait_stop_started
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    start.join().unwrap();
    stop.join().unwrap();
}

// contract: diagnostics.capture-stop.bounds-identity-callback-wait
#[test]
fn document_frame_identity_callback_wait_is_bounded() {
    let (sender, receiver) = mpsc::channel();
    let callback = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(25));
        sender.send(Ok("late reply".to_string()))
    });
    let result = super::await_document_frame_identity_reply(receiver, Duration::from_millis(1));
    assert!(
        matches!(&result, Err(error) if error.contains("timed out")),
        "late identity callback result = {result:?}"
    );
    assert!(
        callback.join().unwrap().is_err(),
        "late callback send unexpectedly found a receiver"
    );
}

// contract: diagnostics.capture-document-identity.reports-late-callback-errors
#[test]
fn late_document_frame_identity_callback_errors_are_logged_as_errors() {
    let success = super::late_document_frame_identity_entry(Ok("reply".into()));
    assert_eq!(success.level, "info");
    let failure = super::late_document_frame_identity_entry(Err("native failure".into()));
    assert_eq!(failure.level, "error");
    assert!(failure.text.contains("native failure"));
}

// contract: diagnostics.capture-document-identity.cleanup-source-survives-recording-stop
#[test]
fn recording_retains_selected_source_until_native_removal() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("frames");
    let recording = Recording::new();
    recording
        .start_with_document_identity(
            &IdentityCaptureProbe,
            Target {
                window: 1,
                display: false,
            },
            &directory,
            true,
            true,
            &|path| std::fs::create_dir_all(path).map_err(|error| error.to_string()),
        )
        .unwrap();
    recording
        .select_frame_identity_source("surface-a", 7)
        .unwrap();
    recording.finish(&IdentityCaptureProbe).unwrap();
    assert_eq!(
        recording.frame_identity_state(),
        (false, Some(("surface-a".into(), 7)))
    );
    assert!(recording.clear_frame_identity_source("surface-a", 7));
    assert_eq!(recording.frame_identity_state(), (false, None));
}

// contract: diagnostics.capture-start.rejects-unconfirmed-identity-cleanup
#[test]
fn recording_rejects_start_while_document_identity_cleanup_is_incomplete() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("next-frames");
    let recording = Recording::new();
    let initial_directory = temporary.path().join("frames");
    recording
        .start_with_document_identity(
            &IdentityCaptureProbe,
            Target {
                window: 1,
                display: false,
            },
            &initial_directory,
            true,
            true,
            &|path| std::fs::create_dir_all(path).map_err(|error| error.to_string()),
        )
        .unwrap();
    recording
        .select_frame_identity_source("surface-a", 7)
        .unwrap();
    recording.finish(&IdentityCaptureProbe).unwrap();
    let result = recording.start_with_document_identity(
        &IdentityCaptureProbe,
        Target {
            window: 2,
            display: false,
        },
        &directory,
        true,
        true,
        &|_| panic!("new recording was prepared before old marker removal"),
    );
    assert!(
        matches!(result, Err(error) if error.contains("cleanup for surface \"surface-a\" generation 7 is incomplete"))
    );
}
