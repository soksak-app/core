use super::*;

fn pointer(phase: i32, button: i32, clicks: i32) -> Pointer {
    Pointer {
        x: 10.5,
        y: 20.0,
        phase,
        button,
        delta_x: 3.0,
        delta_y: -4.0,
        clicks,
        activate: false,
    }
}

fn params(call: &Call) -> Value {
    serde_json::from_str(&call.params).unwrap()
}

fn key(name: &str, text: Option<&str>, modifiers: u32, down: bool) -> Key {
    Key {
        key: name.to_string(),
        text: text.map(str::to_string),
        modifiers,
        down,
    }
}

// contract: platform.windows.input.pointer-phase-becomes-mouse-event
#[test]
fn a_pointer_phase_becomes_its_mouse_event() {
    let closed = [false, false];
    for (open, phase, button, want) in [
        (
            closed,
            PHASE_MOVE,
            0,
            json!({"type": "mouseMoved", "x": 10.5, "y": 20.0, "button": "none", "buttons": 0, "clickCount": 0}),
        ),
        (
            closed,
            PHASE_PRESS,
            0,
            json!({"type": "mousePressed", "x": 10.5, "y": 20.0, "button": "left", "buttons": 1, "clickCount": 2}),
        ),
        (
            closed,
            PHASE_PRESS,
            1,
            json!({"type": "mousePressed", "x": 10.5, "y": 20.0, "button": "right", "buttons": 2, "clickCount": 2}),
        ),
        (
            [true, false],
            PHASE_DRAG,
            0,
            json!({"type": "mouseMoved", "x": 10.5, "y": 20.0, "button": "left", "buttons": 1, "clickCount": 0}),
        ),
        (
            [true, false],
            PHASE_RELEASE,
            0,
            json!({"type": "mouseReleased", "x": 10.5, "y": 20.0, "button": "left", "buttons": 0, "clickCount": 2}),
        ),
        (
            [true, true],
            PHASE_RELEASE,
            0,
            json!({"type": "mouseReleased", "x": 10.5, "y": 20.0, "button": "left", "buttons": 2, "clickCount": 2}),
        ),
        (
            [true, false],
            PHASE_MOVE,
            0,
            json!({"type": "mouseMoved", "x": 10.5, "y": 20.0, "button": "none", "buttons": 1, "clickCount": 0}),
        ),
        (
            closed,
            PHASE_SCROLL,
            0,
            json!({"type": "mouseWheel", "x": 10.5, "y": 20.0, "button": "none", "buttons": 0, "clickCount": 0, "deltaX": 3.0, "deltaY": -4.0}),
        ),
    ] {
        let call = PressState { open }
            .call(&pointer(phase, button, 2))
            .unwrap();
        assert_eq!(call.method, "Input.dispatchMouseEvent");
        assert_eq!(params(&call), want);
    }
}

// contract: platform.windows.input.pointer-breaking-press-rules-is-not-sent
#[test]
fn a_pointer_that_breaks_the_press_rules_is_not_sent() {
    let closed = [false, false];
    for (open, phase, button, clicks, want) in [
        ([true, false], PHASE_PRESS, 0, 1, Delivery::PressOpen),
        (closed, PHASE_DRAG, 0, 0, Delivery::Rejected),
        (closed, PHASE_RELEASE, 0, 1, Delivery::Rejected),
        (closed, PHASE_PRESS, 0, 0, Delivery::Rejected),
        (closed, PHASE_PRESS, 0, 4, Delivery::Rejected),
        (closed, 5, 0, 1, Delivery::Rejected),
        (closed, PHASE_PRESS, 2, 1, Delivery::Rejected),
    ] {
        let got = PressState { open }.call(&pointer(phase, button, clicks));
        assert_eq!(got, Err(want));
    }
}

// contract: platform.windows.input.only-delivered-pointer-changes-press
#[test]
fn only_a_delivered_pointer_changes_the_press() {
    let mut state = PressState::default();
    state.delivered(PHASE_PRESS, 1);
    assert_eq!(state.open, [false, true]);
    state.delivered(PHASE_DRAG, 1);
    assert_eq!(state.open, [false, true]);
    state.delivered(PHASE_RELEASE, 1);
    assert_eq!(state.open, [false, false]);
}

// contract: platform.windows.input.key-becomes-key-event
#[test]
fn a_key_becomes_its_key_event() {
    for (input, want) in [
        (
            key("a", None, 0, true),
            json!({"type": "keyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "text": "a", "unmodifiedText": "a", "modifiers": 0}),
        ),
        (
            key("a", None, 0, false),
            json!({"type": "keyUp", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "modifiers": 0}),
        ),
        (
            key("7", None, 0, true),
            json!({"type": "keyDown", "key": "7", "code": "Digit7", "windowsVirtualKeyCode": 55, "text": "7", "unmodifiedText": "7", "modifiers": 0}),
        ),
        (
            key("Enter", None, 0, true),
            json!({"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r", "unmodifiedText": "\r", "modifiers": 0}),
        ),
        (
            key("Space", None, 0, true),
            json!({"type": "keyDown", "key": " ", "code": "Space", "windowsVirtualKeyCode": 32, "text": " ", "unmodifiedText": " ", "modifiers": 0}),
        ),
        (
            key("ArrowLeft", None, 0, true),
            json!({"type": "rawKeyDown", "key": "ArrowLeft", "code": "ArrowLeft", "windowsVirtualKeyCode": 37, "modifiers": 0}),
        ),
        (
            key("c", None, 2, true),
            json!({"type": "rawKeyDown", "key": "c", "code": "KeyC", "windowsVirtualKeyCode": 67, "modifiers": 2}),
        ),
        (
            key("c", None, 15, true),
            json!({"type": "rawKeyDown", "key": "c", "code": "KeyC", "windowsVirtualKeyCode": 67, "modifiers": 15}),
        ),
        (
            key("a", None, 2, true),
            json!({"type": "rawKeyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "modifiers": 2}),
        ),
        (
            key("a", None, 8, true),
            json!({"type": "rawKeyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "modifiers": 4}),
        ),
        (
            key("A", None, 1, true),
            json!({"type": "keyDown", "key": "A", "code": "KeyA", "windowsVirtualKeyCode": 65, "text": "A", "unmodifiedText": "A", "modifiers": 8}),
        ),
        (
            key("a", Some("한"), 4, true),
            json!({"type": "keyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "text": "한", "unmodifiedText": "한", "modifiers": 1}),
        ),
        (
            key("한", None, 0, true),
            json!({"type": "keyDown", "key": "한", "text": "한", "unmodifiedText": "한", "modifiers": 0}),
        ),
    ] {
        let call = key_call(&input).unwrap();
        assert_eq!(call.method, "Input.dispatchKeyEvent");
        assert_eq!(params(&call), want);
    }
}

// contract: platform.windows.input.key-without-name-or-character-is-not-sent
#[test]
fn a_key_that_is_no_name_and_no_character_is_not_sent() {
    for name in ["", "Enterr", "ab"] {
        assert_eq!(key_call(&key(name, None, 0, true)), Err(Delivery::Rejected));
    }
}

/// Holds the calls of a queue, which end when the test completes them, and the waits of a queue.
#[derive(Default)]
struct Fake {
    methods: RefCell<Vec<&'static str>>,
    params: RefCell<Vec<String>>,
    completes: RefCell<Vec<Option<Complete>>>,
    refuse: RefCell<Option<String>>,
    timers: RefCell<Vec<Option<Task>>>,
}

impl Fake {
    fn complete(&self, index: usize, result: Result<(), String>) {
        let complete = self.completes.borrow_mut()[index].take().unwrap();
        complete(result);
    }

    fn fire(&self, index: usize) {
        let timer = self.timers.borrow_mut()[index].take().unwrap();
        timer();
    }

    fn after(self: &Rc<Self>) -> After {
        let fake = self.clone();
        Rc::new(move |_, task| {
            let index = fake.timers.borrow().len();
            fake.timers.borrow_mut().push(Some(task));
            let fake = fake.clone();
            Box::new(move || fake.timers.borrow_mut()[index] = None)
        })
    }
}

struct FakeTransport(Rc<Fake>);

impl Transport for FakeTransport {
    fn send(&self, call: &Call, complete: Complete) -> Result<(), String> {
        if let Some(refused) = self.0.refuse.borrow().clone() {
            return Err(refused);
        }
        self.0.methods.borrow_mut().push(call.method);
        self.0.params.borrow_mut().push(call.params.clone());
        self.0.completes.borrow_mut().push(Some(complete));
        Ok(())
    }
}

const WAIT: Duration = Duration::from_secs(1);
const FOCUS: &str = "Emulation.setFocusEmulationEnabled";

fn call(method: &'static str) -> Call {
    Call {
        method,
        params: "{}".to_string(),
    }
}

fn queue() -> (InputQueue, Rc<Fake>) {
    let fake = Rc::new(Fake::default());
    let after = fake.after();
    (
        InputQueue::new(Box::new(FakeTransport(fake.clone())), after),
        fake,
    )
}

/// A queue whose focus emulation already completed, so that the next call is the first one of the fake after its index 0.
fn focused_queue() -> (InputQueue, Rc<Fake>) {
    let (queue, fake) = queue();
    queue.0.state.borrow_mut().focused = true;
    (queue, fake)
}

type Answers = Rc<RefCell<Vec<Result<(), InputFailure>>>>;

fn answers() -> (Answers, impl Fn() -> Answer) {
    let got: Answers = Rc::default();
    let held = got.clone();
    let answer = move || -> Answer {
        let held = held.clone();
        Box::new(move |result: Result<(), InputFailure>| held.borrow_mut().push(result))
    };
    (got, answer)
}

// contract: platform.windows.input.queue-sends-one-call-at-a-time
#[test]
fn a_queue_sends_one_call_at_a_time() {
    let (queue, fake) = queue();
    let (got, answer) = answers();
    queue.push(call("a"), WAIT, Some(answer())).unwrap();
    queue.push(call("b"), WAIT, Some(answer())).unwrap();
    assert_eq!(*fake.methods.borrow(), [FOCUS]);
    fake.complete(0, Ok(()));
    assert_eq!(*fake.methods.borrow(), [FOCUS, "a"]);
    fake.complete(1, Ok(()));
    assert_eq!(got.borrow().len(), 1);
    fake.complete(2, Ok(()));
    assert_eq!(got.borrow().len(), 2);
}

// contract: platform.windows.input.queue-emulates-focus-before-first-input-only
#[test]
fn a_queue_emulates_the_focus_before_its_first_input_only() {
    let (queue, fake) = queue();
    queue.push(call("a"), WAIT, None).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&fake.params.borrow()[0]).unwrap(),
        json!({"enabled": true})
    );
    fake.complete(0, Ok(()));
    fake.complete(1, Ok(()));
    queue.push(call("b"), WAIT, None).unwrap();
    assert_eq!(*fake.methods.borrow(), [FOCUS, "a", "b"]);
}

// contract: platform.windows.input.failed-call-answers-its-failure
#[test]
fn a_call_that_fails_answers_its_failure() {
    let (queue, fake) = focused_queue();
    let (got, answer) = answers();
    queue.push(call("a"), WAIT, Some(answer())).unwrap();
    fake.complete(0, Err("refused".to_string()));
    assert_eq!(
        *got.borrow(),
        [Err(InputFailure::Failed("refused".to_string()))]
    );
}

// contract: platform.windows.input.unanswered-failure-goes-to-next-input
#[test]
fn the_failure_of_a_call_with_no_answer_goes_to_the_next_input() {
    let (queue, fake) = focused_queue();
    queue.push(call("a"), WAIT, None).unwrap();
    fake.complete(0, Err("refused".to_string()));
    let failure = queue.push(call("b"), WAIT, None).unwrap_err();
    assert!(failure.contains("refused"), "{failure}");
    queue.push(call("c"), WAIT, None).unwrap();
}

// contract: platform.windows.input.call-that-cannot-start-answers-and-next-runs
#[test]
fn a_call_that_cannot_start_answers_its_failure_and_the_next_one_runs() {
    let (queue, fake) = focused_queue();
    let (got, answer) = answers();
    *fake.refuse.borrow_mut() = Some("no call".to_string());
    queue.push(call("a"), WAIT, Some(answer())).unwrap();
    assert_eq!(
        *got.borrow(),
        [Err(InputFailure::Failed("no call".to_string()))]
    );
    *fake.refuse.borrow_mut() = None;
    queue.push(call("b"), WAIT, None).unwrap();
    assert_eq!(*fake.methods.borrow(), ["b"]);
}

// contract: platform.windows.input.incomplete-call-ends-wait-and-stops-queue
#[test]
fn a_call_that_does_not_complete_ends_its_wait_and_stops_the_queue() {
    let (queue, fake) = focused_queue();
    let (got, answer) = answers();
    queue.push(call("a"), WAIT, Some(answer())).unwrap();
    fake.fire(0);
    assert_eq!(*got.borrow(), [Err(InputFailure::TimedOut)]);
    let failure = queue.push(call("b"), WAIT, None).unwrap_err();
    assert!(failure.contains("did not complete"), "{failure}");
    fake.complete(0, Ok(()));
    assert_eq!(got.borrow().len(), 1);
    queue.push(call("c"), WAIT, None).unwrap();
    assert_eq!(*fake.methods.borrow(), ["a", "c"]);
}

// contract: platform.windows.input.completed-call-ends-its-wait
#[test]
fn a_completed_call_ends_its_wait() {
    let (queue, fake) = focused_queue();
    queue.push(call("a"), WAIT, None).unwrap();
    fake.complete(0, Ok(()));
    assert!(fake.timers.borrow()[0].is_none());
}

// contract: platform.windows.input.call-answer-becomes-pointer-result
#[test]
fn an_answer_of_a_call_becomes_the_pointer_result() {
    assert_eq!(pointer_delivery(&Ok(())), Delivery::Delivered);
    assert_eq!(
        pointer_delivery(&Err(InputFailure::TimedOut)),
        Delivery::Unreceived
    );
    assert_eq!(
        pointer_delivery(&Err(InputFailure::Failed("refused".to_string()))),
        Delivery::Rejected
    );
}

// contract: platform.windows.capture.view-that-does-not-draw-is-refused
#[test]
fn a_capture_of_a_view_that_does_not_draw_is_refused() {
    assert_eq!(capture_refusal(false, true, true), Ok(()));
    for (minimized, shown, visible, want) in [
        (true, true, true, "minimized"),
        (false, false, true, "not shown"),
        (false, true, false, "hidden"),
    ] {
        let failure = capture_refusal(minimized, shown, visible).unwrap_err();
        assert!(failure.contains(want), "{failure}");
    }
}

type CaptureAnswers = Rc<RefCell<Vec<Result<(), String>>>>;

fn capture_done() -> (CaptureAnswers, Complete) {
    let got: CaptureAnswers = Rc::default();
    let held = got.clone();
    (got, Box::new(move |result| held.borrow_mut().push(result)))
}

// contract: platform.windows.capture.incomplete-capture-ends-its-wait
#[test]
fn a_capture_that_does_not_complete_ends_its_wait() {
    let fake = Rc::new(Fake::default());
    let (got, done) = capture_done();
    let finish = capture_wait(&fake.after(), WAIT, done);
    fake.fire(0);
    let answered = got.borrow()[0].clone().unwrap_err();
    assert!(answered.contains("covered"), "{answered}");
    finish(Ok(()));
    assert_eq!(got.borrow().len(), 1);
}

// contract: platform.windows.capture.completed-capture-answers-once
#[test]
fn a_completed_capture_answers_once() {
    let fake = Rc::new(Fake::default());
    let (got, done) = capture_done();
    let finish = capture_wait(&fake.after(), WAIT, done);
    finish(Ok(()));
    assert_eq!(*got.borrow(), [Ok(())]);
    assert!(fake.timers.borrow()[0].is_none());
}

// contract: platform.windows.capture.still-must-be-an-image
#[test]
fn a_still_must_be_an_image() {
    assert!(check_still(b"\x89PNG\r\n\x1a\nrest").is_ok());
    assert!(check_still(b"").is_err());
    assert!(check_still(b"not an image").is_err());
}
