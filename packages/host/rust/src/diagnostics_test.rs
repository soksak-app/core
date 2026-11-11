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
    fn has_stream(&self) -> Result<bool, String> {
        Ok(false)
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
fn capture_stop_does_not_credit_an_unconfirmed_start_count() {
    let source = ("surface-a".to_string(), 7);
    let phases = RefCell::new(Vec::new());
    let (issued, removed, error) = document_identity_stop_sequence(
        true,
        Some(&source),
        Some("the start callback failed".into()),
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
    assert_eq!(recording.frame_identity_state(), (false, None));
    assert!(
        recording
            .select_frame_identity_source("surface-b", 8)
            .is_err()
    );
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
    let (allow_trace, wait_for_trace) = mpsc::channel::<()>();
    let (stop_entered, wait_stop_entered) = mpsc::channel();
    let traced = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let tracing = std::sync::Arc::clone(&traced);
    let start = std::thread::spawn(move || {
        super::with_document_frame_identity_lifecycle(|| {
            recording_started.send(()).unwrap();
            wait_for_trace.recv().unwrap();
            tracing.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, Failure>(())
        })
        .expect("capture start could not acquire the frame identity lifecycle");
    });
    wait_recording_started.recv().unwrap();
    // While the capture start holds the lifecycle, no other operation can enter it.
    assert!(
        matches!(
            DOCUMENT_FRAME_IDENTITY.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ),
        "the lifecycle was free while new capture trace initialization was pending"
    );
    // The stop enters after the start returned, which is after its trace initialization.
    let stop = std::thread::spawn(move || {
        super::with_document_frame_identity_lifecycle(|| {
            stop_entered
                .send(traced.load(std::sync::atomic::Ordering::SeqCst))
                .unwrap();
            Ok::<_, Failure>(())
        })
        .expect("capture stop could not acquire the frame identity lifecycle");
    });
    allow_trace.send(()).unwrap();
    assert!(
        wait_stop_entered.recv().unwrap(),
        "stop entered while new capture trace initialization was pending"
    );
    start.join().unwrap();
    stop.join().unwrap();
}

// contract: diagnostics.capture-document-identity.callback-ends-the-wait
#[test]
fn document_frame_identity_callback_ends_the_wait() {
    let (sender, receiver) = mpsc::channel();
    // The library answers once on every path, from another thread and after the wait began; the wait ends by that answer.
    let callback = std::thread::spawn(move || sender.send(Ok("late reply".to_string())));
    let result = super::await_document_frame_identity_reply(receiver);
    assert_eq!(result.as_deref(), Ok("late reply"));
    assert!(
        callback.join().unwrap().is_ok(),
        "the callback found no receiver"
    );
}

// contract: diagnostics.capture-document-identity.callback-ends-the-wait
#[test]
fn a_document_frame_identity_callback_that_is_dropped_ends_the_wait() {
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    drop(sender);
    let result = super::await_document_frame_identity_reply(receiver);
    assert!(
        matches!(&result, Err(error) if error.contains("ended before replying")),
        "{result:?}"
    );
}

// contract: diagnostics.capture-document-identity.schedule-error-preserves-callback-error
#[test]
fn document_frame_identity_preserves_synchronous_callback_error_when_scheduling_fails() {
    let (sender, receiver) = mpsc::channel();
    sender
        .send(Err("native callback failed".to_string()))
        .unwrap();

    let result = super::await_document_frame_identity_schedule_result(
        Err("native operation was not scheduled".into()),
        receiver,
    );
    let Err(error) = result else {
        panic!("schedule and callback failures were accepted as success: {result:?}");
    };
    assert!(
        error.contains("native operation was not scheduled"),
        "{error}"
    );
    assert!(error.contains("native callback failed"), "{error}");
}

// contract: diagnostics.capture-document-identity.schedule-error-preserves-callback-error
#[test]
fn document_frame_identity_preserves_synchronous_success_reply() {
    let (sender, receiver) = mpsc::channel();
    sender.send(Ok("native reply".to_string())).unwrap();

    let result = super::await_document_frame_identity_schedule_result(Ok(()), receiver);
    assert_eq!(result.as_deref(), Ok("native reply"));
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

/// A clock of the host that does not move, for the native drags of a check whose waits take no time.
fn stopped_clock() -> Duration {
    Duration::ZERO
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
#[test]
fn native_drag_delivers_the_press_the_steps_and_the_release_of_each_round_trip() {
    for (params, expected) in [
        (json!({}), false),
        (json!({"native": false}), false),
        (json!({"native": true}), true),
    ] {
        let mut params = params.as_object().unwrap().clone();
        let native = parse_drag_native(&mut params).expect("a valid native");
        assert_eq!(native, expected, "native of {params:?}");
        assert!(
            !params.contains_key("native"),
            "native is forwarded to the page"
        );
    }
    for value in [json!(null), json!("true"), json!(1)] {
        let mut params = json!({"native": value}).as_object().unwrap().clone();
        let error = parse_drag_native(&mut params).expect_err("an invalid native");
        assert_eq!(error.message, "native must be a boolean", "native {value}");
    }

    // Two round trips of two legs of two steps each from the boundary at 100,50. Each step takes 10 ms of the clock, so a
    // leg of 20 ms ends at its second step.
    let plan = NativeDragPlan {
        dx: 20.0,
        dy: -8.0,
        ms: 20.0,
        times: 2,
    };
    let delivered = RefCell::new(Vec::new());
    let now = Cell::new(Duration::ZERO);
    let ticks = Cell::new(0u32);
    let result = native_drag(
        &plan,
        (100.0, 50.0),
        || now.get(),
        |pointer| {
            assert!(
                !pointer.activate && pointer.button == 0,
                "native drag input {pointer:?} activates or uses another button than the primary one"
            );
            let phase = match pointer.phase {
                1 => "down",
                2 => "drag",
                3 => "up",
                other => panic!("native drag input of phase {other}"),
            };
            delivered.borrow_mut().push(format!(
                "{phase} {},{} after {}",
                pointer.x,
                pointer.y,
                ticks.get()
            ));
            Ok(())
        },
    || {
        now.set(now.get() + Duration::from_millis(10));
        ticks.set(ticks.get() + 1);
        Ok(())
    },
        || Ok(()),
    )
    .expect("native drag");
    let trip = |after: u32| {
        vec![
            format!("down 100,50 after {after}"),
            format!("drag 110,46 after {}", after + 1),
            format!("drag 120,42 after {}", after + 2),
            format!("drag 110,46 after {}", after + 3),
            format!("drag 100,50 after {}", after + 4),
            format!("up 100,50 after {}", after + 4),
        ]
    };
    let mut want = trip(0);
    want.extend(trip(4));
    assert_eq!(*delivered.borrow(), want, "native drag inputs");
    assert_eq!(result["from"], json!({"x": 100.0, "y": 50.0}));
    assert_eq!(result["steps"], json!(8));
    assert_eq!(result["asked"], json!(80));
    assert!(
        result["took"].is_u64(),
        "native drag result took {}",
        result["took"]
    );

    // A step that fails releases the press that is open, and the error names both.
    let phases = RefCell::new(Vec::new());
    let error = native_drag(
        &NativeDragPlan {
            dx: 20.0,
            dy: 0.0,
            ms: 20.0,
            times: 1,
        },
        (100.0, 50.0),
        stopped_clock,
        |pointer| {
            phases.borrow_mut().push(pointer.phase);
            if pointer.phase == 2 {
                return Err(Failure::params("the window did not accept the input"));
            }
            Ok(())
        },
        || Ok(()),
        || Ok(()),
    )
    .expect_err("a failing step");
    assert_eq!(
        error.message,
        "native drag step 1: the window did not accept the input"
    );
    assert_eq!(*phases.borrow(), [1, 2, 3], "down, drag and the release up");
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
#[test]
fn step_period_follows_the_refresh_rate_and_assumes_none() {
    assert_eq!(
        step_period(Some(120)).expect("120 Hz"),
        Duration::from_nanos(8_333_333)
    );
    assert_eq!(
        step_period(Some(60)).expect("60 Hz"),
        Duration::from_nanos(16_666_666)
    );
    for rate in [None, Some(0)] {
        let error = step_period(rate).expect_err("no refresh rate");
        assert_eq!(
            error.message,
            "the window is on no display with a refresh rate",
            "rate {rate:?}"
        );
    }
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
#[test]
fn send_legs_paces_each_step_by_the_refresh_rate_read_at_that_step() {
    let rates = RefCell::new(std::collections::VecDeque::from([
        Some(120),
        Some(60),
        Some(60),
        Some(60),
    ]));
    let now = Cell::new(Duration::ZERO);
    let waits = RefCell::new(Vec::new());
    let sends = RefCell::new(Vec::new());
    send_legs(
        1,
        20.0,
        || Ok(rates.borrow_mut().pop_front().expect("a rate for each step")),
        |period| {
            waits.borrow_mut().push(period);
            now.set(now.get() + period);
        },
        || now.get(),
        |step| {
            sends.borrow_mut().push(step);
            true
        },
    );
    assert_eq!(
        *waits.borrow(),
        [
            Duration::from_nanos(8_333_333),
            Duration::from_nanos(16_666_666),
            Duration::from_nanos(16_666_666),
            Duration::from_nanos(16_666_666),
        ],
        "each step waits the period of the rate read at that step"
    );
    let lasts: Vec<bool> = sends
        .borrow()
        .iter()
        .map(|step| step.as_ref().expect("a step").1)
        .collect();
    assert_eq!(lasts, [false, true, false, true], "the last step of each leg");

    let rates = RefCell::new(std::collections::VecDeque::from([Some(120), None]));
    let now = Cell::new(Duration::ZERO);
    let waits = RefCell::new(Vec::new());
    let sends = RefCell::new(Vec::new());
    send_legs(
        1,
        20.0,
        || Ok(rates.borrow_mut().pop_front().expect("a rate for each step")),
        |period| {
            waits.borrow_mut().push(period);
            now.set(now.get() + period);
        },
        || now.get(),
        |step| {
            sends.borrow_mut().push(step);
            true
        },
    );
    assert_eq!(*waits.borrow(), [Duration::from_nanos(8_333_333)]);
    assert_eq!(
        sends.borrow()[1],
        Err("the window is on no display with a refresh rate".to_string()),
        "a missing rate sends one error and ends the drag"
    );
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
#[test]
fn a_native_drag_presses_only_after_the_window_presented_its_layout() {
    // The window answers late on the clock of the check, which only the answers move: each press must follow the answer,
    // and took leaves the waits out.
    let late = Duration::from_millis(40);
    let now = Cell::new(Duration::ZERO);
    let events = RefCell::new(Vec::<String>::new());
    let answers = Cell::new(0);
    let plan = NativeDragPlan {
        dx: 20.0,
        dy: 0.0,
        ms: 20.0,
        times: 3,
    };
    let phase = |pointer: platform::Pointer| match pointer.phase {
        1 => "down".to_string(),
        2 => "drag".to_string(),
        3 => "up".to_string(),
        other => panic!("native drag input of phase {other}"),
    };
    let result = native_drag(
        &plan,
        (100.0, 50.0),
        || now.get(),
        |pointer| {
            events.borrow_mut().push(phase(pointer));
            Ok(())
        },
        || {
            now.set(now.get() + Duration::from_millis(10));
            Ok(())
        },
        || {
            now.set(now.get() + late);
            answers.set(answers.get() + 1);
            events
                .borrow_mut()
                .push(format!("presented {}", answers.get()));
            Ok(())
        },
    )
    .expect("native drag");
    let mut want = Vec::new();
    for answer in 1..=3 {
        want.push(format!("presented {answer}"));
        want.extend(["down", "drag", "drag", "drag", "drag", "up"].map(String::from));
    }
    assert_eq!(*events.borrow(), want, "native drag with a late window");
    let waits = result["pressWaits"]
        .as_array()
        .expect("pressWaits is an array");
    assert_eq!(waits.len(), 3, "the wait before each of the 3 presses");
    for (i, wait) in waits.iter().enumerate() {
        assert_eq!(
            wait.as_u64(),
            Some(late.as_millis() as u64),
            "pressWaits[{i}], want the {late:?} the window took to answer"
        );
    }
    assert_eq!(
        result["took"].as_u64(),
        Some(120),
        "native drag took with steps of 10 ms, want 120 without the waits",
    );

    // A wait that fails delivers no press.
    events.borrow_mut().clear();
    let error = native_drag(
        &NativeDragPlan {
            dx: 20.0,
            dy: 0.0,
            ms: 20.0,
            times: 2,
        },
        (100.0, 50.0),
        || now.get(),
        |pointer| {
            events.borrow_mut().push(phase(pointer));
            Ok(())
        },
        || {
            now.set(now.get() + Duration::from_millis(10));
            Ok(())
        },
        || {
            if events.borrow().is_empty() {
                Ok(())
            } else {
                Err(Failure::params("the window did not present within 10s"))
            }
        },
    )
    .expect_err("a failing wait");
    assert_eq!(
        error.message,
        "native drag wait before the press of round trip 2: the window did not present within 10s"
    );
    assert_eq!(
        *events.borrow(),
        ["down", "drag", "drag", "drag", "drag", "up"],
        "only the first round trip"
    );
}

// contract: diagnostics.drag.native-reads-boundary-after-presentation
// A press goes where the last frame drew, so a boundary that a change just made takes the press only after the window
// presented it.
#[test]
fn a_native_drag_asks_for_its_boundary_after_the_window_presented_it() {
    let order = RefCell::new(Vec::new());
    let from = presented_boundary(
        || {
            order.borrow_mut().push("presented");
            Ok(0.0)
        },
        || {
            order.borrow_mut().push("boundary");
            Ok((7.0, 9.0))
        },
    )
    .expect("a presented boundary");
    assert_eq!(from, (7.0, 9.0));
    assert_eq!(*order.borrow(), ["presented", "boundary"]);
    let error = presented_boundary(
        || Err(Failure::params("the window did not present")),
        || panic!("a window that did not present was asked for its boundary"),
    )
    .expect_err("a failed wait");
    assert_eq!(error.message, "the window did not present");
}

// contract: recording.drag.layout-trace-after-settle
#[test]
fn a_recorded_drag_stops_its_layout_trace_after_the_last_placement_is_presented() {
    let order = RefCell::new(Vec::new());
    let (settled, stopped) = stop_after_settled(
        || {
            order.borrow_mut().push("settle");
            Ok::<_, Failure>(1)
        },
        || {
            order.borrow_mut().push("stop");
            Ok::<_, Failure>(2)
        },
    );
    assert_eq!((settled.unwrap(), stopped.unwrap()), (1, 2));
    assert_eq!(*order.borrow(), ["settle", "stop"]);

    let order = RefCell::new(Vec::new());
    let (settled, stopped) = stop_after_settled(
        || -> Result<(), Failure> {
            order.borrow_mut().push("settle");
            Err(internal("the drag was not presented"))
        },
        || {
            order.borrow_mut().push("stop");
            Ok::<_, Failure>(())
        },
    );
    assert_eq!(settled.unwrap_err().message, "the drag was not presented");
    assert!(stopped.is_ok());
    assert_eq!(
        *order.borrow(),
        ["settle", "stop"],
        "the trace stops also when the drag fails"
    );
}

/// Receives the one message of receiver that the end of a hold sends; the end is the event that the test waits for.
fn settles<T>(receiver: &mpsc::Receiver<T>) -> Option<T> {
    receiver.recv().ok()
}

/// Runs hold_modal_content for window on a thread and sends () when it returns.
fn held_modal_content(window: &'static str) -> mpsc::Receiver<()> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        hold_modal_content(window);
        sender
            .send(())
            .expect("the test dropped the receiver of the held modal content");
    });
    receiver
}

/// Reads the hold of window as diagnostics.modal.held does when it arrives, before the end that the test then makes, and
/// sends () on a thread when the wait of that answer returns.
fn modal_held_answer(window: &'static str) -> mpsc::Receiver<()> {
    let hold = modal_held_hold(window).unwrap_or_else(|failure| {
        panic!("diagnostics.modal.held answered {failure:?} while the hold was on")
    });
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        await_modal_held(&hold);
        sender
            .send(())
            .expect("the test dropped the receiver of diagnostics.modal.held");
    });
    receiver
}

// contract: diagnostics.modal-hold.ends-with-window-or-connection
#[test]
fn a_modal_hold_ends_with_the_connection_that_turned_it_on() {
    let window = "modal-hold-connection";
    let connection = crate::endpoint::ConnectionEnd::open();
    modal_hold(window, true, &connection);
    let held = held_modal_content(window);
    let answered = modal_held_answer(window);
    connection.close();
    assert!(
        settles(&held).is_some(),
        "the held modal content answer was not sent when the connection of the hold closed"
    );
    assert!(
        settles(&answered).is_some(),
        "diagnostics.modal.held did not answer at the end of the hold by its connection"
    );
    assert!(
        settles(&held_modal_content(window)).is_some(),
        "a modal content answer after the end of the hold was held"
    );
}

// contract: diagnostics.modal-hold.ends-with-window-or-connection
#[test]
fn the_close_of_another_connection_keeps_the_modal_hold() {
    let window = "modal-hold-other-connection";
    let holder = crate::endpoint::ConnectionEnd::open();
    let other = crate::endpoint::ConnectionEnd::open();
    modal_hold(window, true, &holder);
    let held = held_modal_content(window);
    other.close();
    // The close runs the ends of its connection before it returns, so the hold is still there or it is not.
    assert!(
        super::modal_hold_of(window).is_some(),
        "the close of a connection that did not turn the hold on ended the hold"
    );
    modal_hold(window, false, &other);
    assert!(
        settles(&held).is_some(),
        "turning the hold off did not send the held answer"
    );
    holder.close();
}

// contract: diagnostics.modal-hold.ends-with-window-or-connection
#[test]
fn a_modal_hold_ends_with_its_window() {
    let window = "modal-hold-window";
    let connection = crate::endpoint::ConnectionEnd::open();
    modal_hold(window, true, &connection);
    let held = held_modal_content(window);
    let answered = modal_held_answer(window);
    end_window_holds(window);
    assert!(
        settles(&held).is_some(),
        "the held modal content answer was not sent when its window closed"
    );
    assert!(
        settles(&answered).is_some(),
        "diagnostics.modal.held did not answer when the window of the hold closed"
    );
    connection.close();
}

/// Remembers a hold of surface in window by connection whose release sends the surface to the returned receiver.
fn surface_hold(
    window: &str,
    surface: &'static str,
    connection: &crate::endpoint::ConnectionEnd,
) -> mpsc::Receiver<&'static str> {
    let (sender, receiver) = mpsc::channel();
    remember_surface_hold(window, surface, connection, move || {
        sender
            .send(surface)
            .expect("the test dropped the receiver of the release");
    });
    receiver
}

// contract: diagnostics.surface-hold.released-at-connection-close
#[test]
fn the_close_of_the_connection_of_a_surface_hold_releases_the_surface() {
    let connection = crate::endpoint::ConnectionEnd::open();
    let released = surface_hold("surface-hold-close", "tab-1", &connection);
    assert!(
        released.try_recv().is_err(),
        "the surface was released while its connection was open"
    );
    connection.close();
    assert_eq!(settles(&released), Some("tab-1"));
    connection.close();
    assert!(
        released.try_recv().is_err(),
        "the surface was released twice"
    );
}

// contract: diagnostics.surface-hold.released-at-connection-close
#[test]
fn a_later_hold_of_the_surface_keeps_it_at_the_close_of_the_earlier_connection() {
    let earlier = crate::endpoint::ConnectionEnd::open();
    let later = crate::endpoint::ConnectionEnd::open();
    let first = surface_hold("surface-hold-later", "tab-1", &earlier);
    let second = surface_hold("surface-hold-later", "tab-1", &later);
    earlier.close();
    // The close runs the release of its connection before it returns.
    assert!(
        first.try_recv().is_err(),
        "the close of the earlier connection released a surface that a later hold took"
    );
    later.close();
    assert_eq!(settles(&second), Some("tab-1"));
}

// contract: diagnostics.surface-hold.released-at-connection-close
#[test]
fn a_surface_hold_of_a_closed_connection_is_released_at_once() {
    let connection = crate::endpoint::ConnectionEnd::open();
    connection.close();
    let released = surface_hold("surface-hold-closed", "tab-1", &connection);
    assert_eq!(settles(&released), Some("tab-1"));
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn unreached_window_objects_answer_the_end_of_their_wait() {
    let counts = platform::WindowObjects {
        window_compositions: 1,
        surface_hosts: 2,
        input_registrations: 3,
    };
    let answer = native_objects_answer(None, counts, false, super::WAIT_END_WINDOW);
    let Err(failure) = answer else {
        panic!("unreached counts without expected counts were answered as {answer:?}");
    };
    assert_eq!(
        failure.message,
        "the window object counts ended before the application handled an event: the window closed"
    );
    assert!(native_objects_answer(None, counts, true, "").is_ok());
    let expected = platform::WindowObjects::default();
    let Err(unreached) =
        native_objects_answer(Some(expected), counts, false, super::WAIT_END_CONNECTION)
    else {
        panic!("unreached expected counts were answered");
    };
    assert_eq!(unreached.code, crate::endpoint::TIMED_OUT);
    assert_eq!(
        unreached.message,
        format!(
            "window object counts did not reach {expected} before the endpoint connection of the request closed; they are {counts}"
        )
    );
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_process_exit_answer_names_the_end_of_its_wait() {
    assert_eq!(
        super::process_exit_answer(7, true, None).ok(),
        Some(Value::Null)
    );
    let Err(ended) = super::process_exit_answer(7, false, Some(super::WAIT_END_PAGE)) else {
        panic!("an ended wait was answered as an exit");
    };
    assert_eq!(ended.code, crate::endpoint::TIMED_OUT);
    assert_eq!(
        ended.message,
        "process 7 did not exit before the page of the window ended"
    );
    let Err(unregistered) = super::process_exit_answer(7, false, None) else {
        panic!("a wait that could not be registered was answered as an exit");
    };
    assert_eq!(
        unregistered.message,
        "process 7 exit wait could not be registered"
    );
}

/// A native wait of the test: start registers the answer and sends () on started; its end answers false, once.
type TestAnswer = Arc<Mutex<Option<Box<dyn FnOnce(bool) + Send>>>>;

/// The thread of a native wait of the test, which returns the result of the wait.
type TestWait = std::thread::JoinHandle<Result<(bool, Option<&'static str>), Failure>>;

fn test_native_wait(
    label: &'static str,
    connection: &crate::endpoint::ConnectionEnd,
) -> (mpsc::Receiver<()>, TestAnswer, TestWait) {
    let (started, on_started) = mpsc::channel();
    let answer: TestAnswer = Arc::new(Mutex::new(None));
    let slot = answer.clone();
    let connection = connection.clone();
    let wait = std::thread::spawn(move || {
        super::native_wait(
            label,
            &connection,
            |work| {
                work();
                Ok(())
            },
            move |done| {
                *slot.lock().unwrap() = Some(done);
                let ended = slot.clone();
                started.send(()).unwrap();
                Ok(Box::new(move |_| {
                    if let Some(done) = ended.lock().unwrap().take() {
                        done(false);
                    }
                }) as super::NativeEnd)
            },
        )
    });
    (on_started, answer, wait)
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_native_wait_ends_by_its_answer_without_an_end() {
    let connection = crate::endpoint::ConnectionEnd::open();
    let (started, answer, wait) = test_native_wait("native-wait-answer", &connection);
    started.recv().unwrap();
    (answer.lock().unwrap().take().unwrap())(true);
    assert_eq!(wait.join().unwrap().unwrap(), (true, None));
    // An end after the answer finds no wait.
    connection.close();
    super::end_native_waits("native-wait-answer", super::WAIT_END_WINDOW);
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_native_wait_ends_with_the_connection_of_its_request() {
    let connection = crate::endpoint::ConnectionEnd::open();
    let (started, _answer, wait) = test_native_wait("native-wait-connection", &connection);
    started.recv().unwrap();
    connection.close();
    assert_eq!(
        wait.join().unwrap().unwrap(),
        (false, Some(super::WAIT_END_CONNECTION))
    );
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_native_wait_ends_with_its_window_and_its_page() {
    for (label, end) in [
        ("native-wait-window", super::WAIT_END_WINDOW),
        ("native-wait-page", super::WAIT_END_PAGE),
    ] {
        let connection = crate::endpoint::ConnectionEnd::open();
        let (started, _answer, wait) = test_native_wait(label, &connection);
        started.recv().unwrap();
        if end == super::WAIT_END_WINDOW {
            end_window_holds(label);
        } else {
            super::end_native_waits(label, end);
        }
        assert_eq!(wait.join().unwrap().unwrap(), (false, Some(end)));
        connection.close();
    }
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_native_wait_of_another_window_keeps_waiting() {
    let connection = crate::endpoint::ConnectionEnd::open();
    let (started, answer, wait) = test_native_wait("native-wait-kept", &connection);
    started.recv().unwrap();
    // An end that reached the wait would be in its queue before the answer, since the end is sent before it returns.
    super::end_native_waits("native-wait-other", super::WAIT_END_WINDOW);
    (answer.lock().unwrap().take().unwrap())(true);
    assert_eq!(wait.join().unwrap().unwrap(), (true, None));
    connection.close();
}

/// Runs a capture operation of window on connection on a thread: the operation sends its token on started and waits
/// until the end of the test gives it the reason of the end of that token, which it returns.
fn test_capture_wait(
    label: &'static str,
    connection: &crate::endpoint::ConnectionEnd,
) -> (mpsc::Receiver<u64>, std::thread::JoinHandle<&'static str>) {
    let (started, on_started) = mpsc::channel();
    let connection = connection.clone();
    let wait = std::thread::spawn(move || {
        let (ended, on_ended) = mpsc::channel::<(u64, &'static str)>();
        let ended = Mutex::new(ended);
        super::await_capture(
            label,
            &connection,
            move |token, reason| {
                ended
                    .lock()
                    .unwrap()
                    .send((token, reason))
                    .expect("the capture operation receives its end");
            },
            move |token| {
                started.send(token).unwrap();
                let (ended_token, reason) = on_ended.recv().unwrap();
                assert_eq!(
                    ended_token, token,
                    "the end names the token of the operation"
                );
                reason
            },
        )
    });
    (on_started, wait)
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_capture_wait_ends_with_the_connection_of_its_request() {
    let connection = crate::endpoint::ConnectionEnd::open();
    let (started, wait) = test_capture_wait("capture-wait-connection", &connection);
    started.recv().unwrap();
    connection.close();
    assert_eq!(wait.join().unwrap(), super::WAIT_END_CONNECTION);
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn a_capture_wait_ends_with_its_window_and_its_page() {
    for (label, end) in [
        ("capture-wait-window", super::WAIT_END_WINDOW),
        ("capture-wait-page", super::WAIT_END_PAGE),
    ] {
        let connection = crate::endpoint::ConnectionEnd::open();
        let (started, wait) = test_capture_wait(label, &connection);
        started.recv().unwrap();
        if end == super::WAIT_END_WINDOW {
            end_window_holds(label);
        } else {
            super::end_native_waits(label, end);
        }
        assert_eq!(wait.join().unwrap(), end);
        // The close after the end ends nothing more: the end runs once.
        connection.close();
    }
}

// contract: diagnostics.native-wait.ends-by-its-event-or-its-end
#[test]
fn an_answered_capture_operation_takes_back_its_ends() {
    let connection = crate::endpoint::ConnectionEnd::open();
    let ends = Arc::new(Mutex::new(Vec::new()));
    let recorded = ends.clone();
    let mut answered = 0;
    let value = super::await_capture(
        "capture-wait-answered",
        &connection,
        move |token, reason| recorded.lock().unwrap().push((token, reason)),
        |token| {
            answered = token;
            "answered"
        },
    );
    assert_eq!(value, "answered");
    // The connection runs its ends in its close and the window in end_native_waits, so an end left behind is recorded
    // when they return.
    connection.close();
    super::end_native_waits("capture-wait-answered", super::WAIT_END_WINDOW);
    assert!(
        ends.lock().unwrap().is_empty(),
        "the operation that answered was ended after it returned: {:?}",
        ends.lock().unwrap()
    );
    let later = super::await_capture(
        "capture-wait-answered",
        &crate::endpoint::ConnectionEnd::open(),
        |_, _| {},
        |token| token,
    );
    assert!(
        later > answered,
        "the later operation has the token {later}, not larger than {answered}"
    );
}

// contract: diagnostics.drag.page-receives-every-step
#[test]
fn a_page_drag_sends_every_step() {
    let mut sent = 0;
    send_steps(8, Duration::from_millis(1), || {
        sent += 1;
        true
    });
    assert_eq!(
        sent, 8,
        "the page received {sent} of the 8 steps of its drag"
    );
    let mut after_failure = 0;
    send_steps(8, Duration::from_millis(1), || {
        after_failure += 1;
        false
    });
    assert_eq!(
        after_failure, 1,
        "a step that the window refused did not end the run"
    );
}
