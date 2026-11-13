use super::*;
use crate::surfaces::{LayoutViewport, note_layout_viewport};
use std::cell::{Cell, RefCell};
use std::sync::mpsc;
use std::time::Duration;

/// A clock of the host that does not move, for the native drags of a check whose waits take no time.
fn stopped_clock() -> Duration {
    Duration::ZERO
}

/// The step of a native drag on the clock now of a check: it waits one period after previous, the step before it, with
/// next_step, moving now by the wait, and answers the time of the step.
fn periodic_step(now: &Cell<Duration>, previous: Duration, period: Duration) -> Duration {
    let taken = next_step(previous, period, now.get(), |wait| {
        now.set(now.get() + wait)
    });
    now.set(taken);
    taken
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
#[test]
fn a_native_drag_step_follows_the_step_before_it_by_one_period() {
    // The period runs from the step before, so a wait inside it is no longer than what is left of it, and a step whose
    // time passed is taken at once, from which the next period runs.
    let ms = Duration::from_millis;
    let slept = RefCell::new(Vec::new());
    assert_eq!(
        next_step(ms(100), ms(16), ms(105), |wait| slept
            .borrow_mut()
            .push(wait)),
        ms(116),
        "a step 5 ms into its period"
    );
    assert_eq!(
        *slept.borrow(),
        [ms(11)],
        "the wait of a step 5 ms into its period"
    );
    slept.borrow_mut().clear();
    assert_eq!(
        next_step(ms(100), ms(16), ms(120), |wait| slept
            .borrow_mut()
            .push(wait)),
        ms(120),
        "a step whose time passed"
    );
    assert!(slept.borrow().is_empty(), "a step whose time passed waits");

    // Each input takes 5 ms to deliver. Every round trip is a press, two legs of 32 ms whose steps come 16 ms apart, the
    // last step of each leg delivered 5 ms after its time, and a release: 5 + 37 + 37 + 5 ms.
    let now = Cell::new(Duration::ZERO);
    let gaps = RefCell::new(Vec::new());
    let result = native_drag(
        &NativeDragPlan {
            dx: 20.0,
            dy: 0.0,
            ms: 32.0,
            times: 2,
        },
        (100.0, 50.0),
        || now.get(),
        |_| {
            now.set(now.get() + ms(5));
            Ok(())
        },
        |previous| {
            let taken = periodic_step(&now, previous, ms(16));
            gaps.borrow_mut().push(taken - previous);
            Ok(taken)
        },
        || Ok(()),
    )
    .expect("native drag");
    assert!(
        gaps.borrow().iter().all(|gap| *gap == ms(16)),
        "each step one period of 16 ms after the step before it: {:?}",
        gaps.borrow()
    );
    assert_eq!(result["steps"], json!(8), "2 steps in each of the 4 legs");
    assert_eq!(
        result["took"].as_u64(),
        Some(168),
        "native drag took, want 168 ms: the deliveries are inside the periods"
    );
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
                0 => "move",
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
        |previous| {
            ticks.set(ticks.get() + 1);
            Ok(periodic_step(&now, previous, Duration::from_millis(10)))
        },
        || Ok(()),
    )
    .expect("native drag");
    let trip = |after: u32| {
        vec![
            format!("move 100,50 after {after}"),
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
    assert_eq!(
        result["tripSteps"],
        json!([4, 4]),
        "the 4 steps of each of the 2 round trips"
    );
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
        Ok,
        || Ok(()),
    )
    .expect_err("a failing step");
    assert_eq!(
        error.message,
        "native drag step 1: the window did not accept the input"
    );
    assert_eq!(
        *phases.borrow(),
        [0, 1, 2, 3],
        "the move, down, drag and the release up"
    );
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
            error.message, "the window is on no display with a refresh rate",
            "rate {rate:?}"
        );
    }
}

// contract: diagnostics.drag.page-legs-follow-the-refresh-rate
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
        || {
            Ok(rates
                .borrow_mut()
                .pop_front()
                .expect("a rate for each step"))
        },
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
    assert_eq!(
        lasts,
        [false, true, false, true],
        "the last step of each leg"
    );
    for (index, step) in sends.borrow().iter().enumerate() {
        let (fraction, last) = *step.as_ref().expect("a step");
        assert!(
            if last {
                fraction == 1.0
            } else {
                fraction > 0.0 && fraction < 1.0
            },
            "step {index} reached {fraction} of its leg with last {last}"
        );
    }

    let rates = RefCell::new(std::collections::VecDeque::from([Some(120), None]));
    let now = Cell::new(Duration::ZERO);
    let waits = RefCell::new(Vec::new());
    let sends = RefCell::new(Vec::new());
    send_legs(
        1,
        20.0,
        || {
            Ok(rates
                .borrow_mut()
                .pop_front()
                .expect("a rate for each step"))
        },
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
        0 => "move".to_string(),
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
        |previous| Ok(periodic_step(&now, previous, Duration::from_millis(10))),
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
        want.push("move".to_string());
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
        |previous| Ok(periodic_step(&now, previous, Duration::from_millis(10))),
        || {
            if !events.borrow().iter().any(|phase| phase == "up") {
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
        ["move", "down", "drag", "drag", "drag", "drag", "up", "move"],
        "the first round trip and the move before the second press"
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

// A drag answers whatever happened to its recording: the recording is the log of the drag, so what failed of it is told in
// captureError, and the steps and the layout trace are in every result.
// contract: recording.drag.recording-failure-is-told
#[test]
fn a_recorded_drag_tells_what_failed_of_its_recording() {
    let took = || {
        let mut result = Map::new();
        result.insert("took".into(), json!(100));
        result
    };
    let traced = || json!([{"ticket": 1}]);
    assert_eq!(
        Value::Object(recorded_drag_result(
            took(),
            vec![1.0, 2.0],
            traced(),
            None,
            None
        )),
        json!({"took": 100, "ticks": [1.0, 2.0], "layouts": [{"ticket": 1}]})
    );
    assert_eq!(
        Value::Object(recorded_drag_result(
            took(),
            vec![1.0, 2.0],
            traced(),
            None,
            Some("the recording did not start: no window".into())
        )),
        json!({"took": 100, "ticks": [1.0, 2.0], "layouts": [{"ticket": 1}],
            "captureError": "the recording did not start: no window"})
    );
    assert_eq!(
        Value::Object(recorded_drag_result(
            took(),
            vec![1.0],
            traced(),
            Some(DragRecording {
                frames: "/frames".into(),
                window: json!(7)
            }),
            None
        )),
        json!({"took": 100, "ticks": [1.0], "layouts": [{"ticket": 1}], "frames": "/frames", "window": 7})
    );
}

/// A transaction of ticket that began at begun and has no other stage.
fn begun_record(ticket: u64, begun: f64) -> platform::LayoutRecord {
    platform::LayoutRecord {
        ticket,
        begun,
        requested: f64::NAN,
        presented: f64::NAN,
        committed: f64::NAN,
        commit_path: None,
        open_at_commit: f64::NAN,
        flushed: f64::NAN,
        displayed: f64::NAN,
        refreshed: f64::NAN,
    }
}

// The layout trace keeps the viewport of each preparation that began its transaction during the trace with the transaction of
// its ticket: the start keeps the viewports from then on and the stop takes them with the records, each in its own main-thread
// turn, as a preparation notes its viewport in the turn that begins its transaction. A preparation outside a trace keeps
// nothing (docs/spec/native-surfaces.md#layout-transaction).
// contract: diagnostics.layout-trace.reply-carries-layout-viewport
#[test]
fn the_layout_trace_keeps_the_viewport_of_each_preparation() {
    let size = |width, height| LayoutViewport { width, height };
    note_layout_viewport(1, size(1200.0, 760.0));
    start_traced_layouts(|| Ok(())).unwrap();
    note_layout_viewport(2, size(1800.0, 1081.0));
    let layouts =
        stop_traced_layouts(|| Ok(vec![begun_record(1, 10.0), begun_record(2, 20.0)])).unwrap();
    assert_eq!(
        [&layouts[0]["viewport"], &layouts[1]["viewport"]],
        [&Value::Null, &json!({"width": 1800.0, "height": 1081.0})]
    );
    note_layout_viewport(3, size(1200.0, 760.0));
    start_traced_layouts(|| Ok(())).unwrap();
    let layouts = stop_traced_layouts(|| Ok(vec![begun_record(3, 30.0)])).unwrap();
    assert_eq!(layouts[0]["viewport"], Value::Null);
    // A failed stop of the native trace still ends the keeping of the viewports.
    start_traced_layouts(|| Ok(())).unwrap();
    assert_eq!(
        stop_traced_layouts(|| Err("the trace failed".to_string())).unwrap_err(),
        "the trace failed"
    );
    note_layout_viewport(4, size(1200.0, 760.0));
    assert!(held_layout_viewports().is_none());
}

// One run holds the layout trace at a time, because a native start discards what the trace recorded; only the run that holds
// the trace stops it.
// contract: diagnostics.layout-trace.one-run-at-a-time
#[test]
fn the_layout_trace_has_one_run_at_a_time() {
    let starts = Cell::new(0);
    let drag = Arc::new(LayoutTraceRun { endpoint: false });
    let other = Arc::new(LayoutTraceRun { endpoint: true });
    start_layout_trace(&drag, || {
        starts.set(starts.get() + 1);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        start_layout_trace(&other, || {
            starts.set(starts.get() + 1);
            Ok(())
        })
        .unwrap_err()
        .message,
        "the layout trace is already running"
    );
    assert_eq!(
        stop_layout_trace(&other, || Ok(())).unwrap_err().message,
        "no layout trace is running"
    );
    assert_eq!(stop_layout_trace(&drag, || Ok(3)).unwrap(), 3);
    assert_eq!(
        starts.get(),
        1,
        "a start while the trace runs reached the native trace"
    );
    // A start that fails leaves the trace to the next run.
    assert!(start_layout_trace(&other, || Err(internal("no trace"))).is_err());
    start_layout_trace(&other, || Ok(())).unwrap();
    stop_layout_trace(&other, || Ok(())).unwrap();
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
    // A display of 125 Hz has a period of 8 ms, so a round trip of 32 ms legs takes 4 steps each way. The clock advances only
    // by the waits, so the count does not depend on the machine.
    let run = |refuse_after: Option<usize>| {
        let now = std::cell::Cell::new(Duration::ZERO);
        let mut sent = 0;
        send_legs(
            1,
            32.0,
            || Ok(Some(125)),
            |period| now.set(now.get() + period),
            || now.get(),
            |step| {
                assert!(
                    step.is_ok(),
                    "a step of a window at 125 Hz failed: {step:?}"
                );
                sent += 1;
                refuse_after.is_none_or(|limit| sent < limit)
            },
        );
        sent
    };
    let sent = run(None);
    assert_eq!(
        sent, 8,
        "the page received {sent} of the 8 steps of its drag"
    );
    let after_failure = run(Some(1));
    assert_eq!(
        after_failure, 1,
        "a step that the window refused did not end the run"
    );
}
