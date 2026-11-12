use super::*;
use crate::recording::NewWindowCapture;
use std::sync::mpsc;

/// What answers the wait for a held window of the probe: the window that the hold took, or the end of the wait.
enum HoldEvent {
    Held(isize),
    Ended(&'static str),
}

/// A capture whose hold of a new window the test answers: `Held` gives the number of the window that the hold took, and
/// the end of the wait answers the wait with the error of the native library.
struct NewWindowProbe {
    hold_error: Option<String>,
    open_error: Option<String>,
    events: Mutex<mpsc::Receiver<HoldEvent>>,
    ends: Mutex<mpsc::Sender<HoldEvent>>,
    opened: Mutex<mpsc::Sender<Target>>,
    released: AtomicU64,
    /// The plan that the start of the recording received.
    plan: Mutex<Option<Plan>>,
}

/// The plan of the stills of the recordings of these tests.
const TEST_PLAN: Plan = Plan {
    gap: 8.0,
    seconds: 0.0,
    frames: 120,
};

fn probe(
    hold_error: Option<&str>,
    open_error: Option<&str>,
) -> (
    Arc<NewWindowProbe>,
    mpsc::Sender<HoldEvent>,
    mpsc::Receiver<Target>,
) {
    let (hold, events) = mpsc::channel();
    let (opened, on_opened) = mpsc::channel();
    (
        Arc::new(NewWindowProbe {
            hold_error: hold_error.map(str::to_string),
            open_error: open_error.map(str::to_string),
            events: Mutex::new(events),
            ends: Mutex::new(hold.clone()),
            opened: Mutex::new(opened),
            released: AtomicU64::new(0),
            plan: Mutex::new(None),
        }),
        hold,
        on_opened,
    )
}

impl Capture for NewWindowProbe {
    fn open(&self, target: Target) -> Result<(), String> {
        self.opened.lock().unwrap().send(target).unwrap();
        self.open_error.clone().map_or(Ok(()), Err)
    }
    fn start(&self, _directory: &Path, plan: Plan, _frame_identity: bool) -> Result<(), String> {
        *self.plan.lock().unwrap() = Some(plan);
        Ok(())
    }
    fn stop(&self) -> Result<i32, String> {
        Ok(1)
    }
}

impl NewWindowCapture for NewWindowProbe {
    fn hold_new_window(&self) -> Result<(), String> {
        self.hold_error.clone().map_or(Ok(()), Err)
    }
    fn wait_new_window(
        &self,
        register_end: &dyn Fn(Box<dyn Fn(&'static str) + Send + Sync>),
    ) -> Result<isize, String> {
        let end = Mutex::new(self.ends.lock().unwrap().clone());
        register_end(Box::new(move |reason| {
            // The probe keeps its receiver for its life, so the send of an end reaches it.
            end.lock()
                .unwrap()
                .send(HoldEvent::Ended(reason))
                .expect("the probe receives the end of its wait");
        }));
        match self.events.lock().unwrap().recv().unwrap() {
            HoldEvent::Held(number) => Ok(number),
            HoldEvent::Ended(reason) => Err(format!("no new window was shown before {reason}")),
        }
    }
    fn release_new_window(&self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}

fn make(directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())
}

// contract: diagnostics.capture-start.new-window-is-strict-boolean
#[test]
fn the_new_window_option_is_a_strict_boolean_without_display() {
    let parse = |json: Value| parse_capture_start_options(json.as_object().unwrap());
    assert!(
        parse(json!({"gap": 8, "frames": 10, "newWindow": true}))
            .unwrap()
            .new_window
    );
    assert!(!parse(json!({"gap": 8, "frames": 10})).unwrap().new_window);
    for value in [json!(null), json!("true"), json!(1)] {
        assert_eq!(
            parse(json!({ "gap": 8, "frames": 10, "newWindow": value }))
                .unwrap_err()
                .message,
            "newWindow must be a boolean"
        );
    }
    assert_eq!(
        parse(json!({"gap": 8, "frames": 10, "newWindow": true, "display": true}))
            .unwrap_err()
            .message,
        "newWindow records the new window alone and cannot be combined with display"
    );
}

// contract: diagnostics.capture-start.new-window-answers-once-held
#[test]
fn a_new_window_recording_answers_once_the_hold_is_set_and_records_the_held_window() {
    let parent = tempfile::tempdir().unwrap();
    let directory = parent.path().join("frames");
    let (capture, hold, opened) = probe(None, None);
    let recording = Recording::new();
    recording
        .start_new_window(capture.clone(), &directory, TEST_PLAN, false, &make)
        .unwrap();
    assert_eq!(recording.running(), Some(directory.clone()));
    assert!(
        opened.try_recv().is_err(),
        "the recording opened before a window was shown"
    );
    hold.send(HoldEvent::Held(31)).unwrap();
    assert_eq!(
        opened.recv().unwrap(),
        Target {
            window: 31,
            display: false
        }
    );
    let (finished, count, _, window) = recording.finish(capture.as_ref()).unwrap();
    assert_eq!((finished, count, window), (directory, 1, Some(31)));
    assert_eq!(
        capture.released.load(Ordering::SeqCst),
        0,
        "a recording that started released its hold; its start shows the window"
    );
    assert_eq!(*capture.plan.lock().unwrap(), Some(TEST_PLAN));
}

// contract: diagnostics.capture-start.new-window-answers-once-held
#[test]
fn a_failed_hold_starts_no_recording() {
    let parent = tempfile::tempdir().unwrap();
    let (capture, _hold, _opened) =
        probe(Some("a new window is already held for a recording"), None);
    let recording = Recording::new();
    let error = recording
        .start_new_window(
            capture,
            &parent.path().join("frames"),
            TEST_PLAN,
            false,
            &make,
        )
        .unwrap_err();
    assert_eq!(error, "a new window is already held for a recording");
    assert_eq!(recording.running(), None);
}

// contract: diagnostics.capture-start.new-window-hold-ends
#[test]
fn the_stop_ends_a_hold_that_no_show_took() {
    let parent = tempfile::tempdir().unwrap();
    let directory = parent.path().join("frames");
    let (capture, _hold, _opened) = probe(None, None);
    let recording = Recording::new();
    recording
        .start_new_window(capture.clone(), &directory, TEST_PLAN, false, &make)
        .unwrap();
    let error = recording.finish(capture.as_ref()).unwrap_err();
    assert_eq!(
        error,
        "no new window was shown before the stop of the recording"
    );
    assert_eq!(recording.running(), None);
}

// contract: diagnostics.capture-start.new-window-hold-ends
#[test]
fn a_failure_after_the_hold_releases_the_held_window() {
    let parent = tempfile::tempdir().unwrap();
    let directory = parent.path().join("frames");
    let (capture, hold, opened) = probe(None, Some("window 31 not found"));
    let recording = Recording::new();
    recording
        .start_new_window(capture.clone(), &directory, TEST_PLAN, false, &make)
        .unwrap();
    hold.send(HoldEvent::Held(31)).unwrap();
    opened.recv().unwrap();
    let error = recording.finish(capture.as_ref()).unwrap_err();
    assert!(error.contains("window 31 not found"), "{error}");
    assert_eq!(capture.released.load(Ordering::SeqCst), 1);
}
