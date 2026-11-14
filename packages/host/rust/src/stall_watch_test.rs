use std::time::Duration;

use serde_json::json;

use super::*;

/// The state of a watch with no open stall.
const IDLE: StallState = StallState {
    stalled_from: None,
    cpu: None,
};

fn open(from: u64, cpu: Option<u64>) -> StallState {
    StallState {
        stalled_from: Some(from),
        cpu,
    }
}

fn reading(
    now: u64,
    last: u64,
    watch_late_ms: u64,
    schedule: Result<(i32, u64), String>,
) -> StallReading {
    StallReading {
        now,
        last,
        watch_late: Duration::from_millis(watch_late_ms),
        schedule,
    }
}

fn outcome(
    next: StallState,
    starts: bool,
    record: Option<(Level, &'static str, serde_json::Value)>,
    schedule_error: Option<&str>,
) -> StallOutcome {
    StallOutcome {
        next,
        starts,
        record: record.map(|(level, event, fields)| StallRecord {
            level,
            event,
            fields,
        }),
        schedule_error: schedule_error.map(str::to_string),
    }
}

const MS: u64 = 1_000_000;

// contract: host.stall.watch-late-separates-scheduling, host.stall.watch-late-separates-blocked-main, host.stall.carries-priority, host.stall.resumed-carries-cpu
#[test]
fn the_step_decides_each_beat_from_its_readings() {
    let unreadable = || Err("process schedule: errno 3".to_string());
    let cases: Vec<(&str, StallState, StallReading, StallOutcome)> = vec![
        (
            "a beat that answers in time stores nothing",
            IDLE,
            reading(250, 200, 0, Ok((0, 0))),
            outcome(IDLE, false, None, None),
        ),
        (
            "a stall that is 999 ms late is not a stall",
            IDLE,
            reading(999, 0, 0, Ok((31, 0))),
            outcome(IDLE, false, None, None),
        ),
        (
            "a stall found on a late wake of the watch carries the lateness of the watch",
            IDLE,
            reading(1850, 0, 1600, Ok((31, 0))),
            outcome(
                open(0, Some(0)),
                true,
                Some((
                    Level::Warn,
                    "host.stall",
                    json!({"late_ms": 1850, "watch_late_ms": 1600, "priority": 31}),
                )),
                None,
            ),
        ),
        (
            "a stall of a blocked main thread has no lateness of the watch",
            IDLE,
            reading(1000, 0, 0, Ok((31, 0))),
            outcome(
                open(0, Some(0)),
                true,
                Some((
                    Level::Warn,
                    "host.stall",
                    json!({"late_ms": 1000, "watch_late_ms": 0, "priority": 31}),
                )),
                None,
            ),
        ),
        (
            "a stall of a background process carries its priority and the CPU time it starts from",
            IDLE,
            reading(1000, 0, 0, Ok((4, 100 * MS))),
            outcome(
                open(0, Some(100 * MS)),
                true,
                Some((
                    Level::Warn,
                    "host.stall",
                    json!({"late_ms": 1000, "watch_late_ms": 0, "priority": 4}),
                )),
                None,
            ),
        ),
        (
            "a stall whose schedule cannot be read leaves out the priority and the CPU time",
            IDLE,
            reading(1000, 0, 0, unreadable()),
            outcome(
                open(0, None),
                true,
                Some((
                    Level::Warn,
                    "host.stall",
                    json!({"late_ms": 1000, "watch_late_ms": 0}),
                )),
                Some("process schedule: errno 3"),
            ),
        ),
        (
            "an open stall that did not move stores nothing",
            open(500, Some(100 * MS)),
            reading(2000, 500, 0, Ok((0, 0))),
            outcome(open(500, Some(100 * MS)), false, None, None),
        ),
        (
            "the end of a stall reports its length and the CPU time since its start",
            open(500, Some(100 * MS)),
            reading(1750, 1750, 0, Ok((4, 130 * MS))),
            outcome(
                StallState {
                    stalled_from: None,
                    cpu: Some(100 * MS),
                },
                false,
                Some((
                    Level::Info,
                    "host.stall.resumed",
                    json!({"stalled_ms": 1250, "cpu_ms": 30}),
                )),
                None,
            ),
        ),
        (
            "the end of a stall whose start had no CPU reading reports no CPU time",
            open(500, None),
            reading(1750, 1750, 0, Ok((4, 130 * MS))),
            outcome(
                IDLE,
                false,
                Some((
                    Level::Info,
                    "host.stall.resumed",
                    json!({"stalled_ms": 1250}),
                )),
                None,
            ),
        ),
        (
            "the end of a stall whose schedule cannot be read reports its length without CPU time",
            open(500, Some(100 * MS)),
            reading(1750, 1750, 0, unreadable()),
            outcome(
                StallState {
                    stalled_from: None,
                    cpu: Some(100 * MS),
                },
                false,
                Some((
                    Level::Info,
                    "host.stall.resumed",
                    json!({"stalled_ms": 1250}),
                )),
                Some("process schedule: errno 3"),
            ),
        ),
    ];
    for (name, state, reading, want) in cases {
        assert_eq!(stall_step(&state, &reading), want, "{name}");
    }
}

// contract: host.stall.sample-keeps-the-watch-running, host.stall.stop-waits-for-the-sample, host.stall.ends-when-the-run-loop-waits
#[test]
fn the_loop_step_decides_the_sample_and_the_wait_of_each_beat() {
    let starting = || {
        outcome(
            open(0, None),
            true,
            Some((Level::Warn, "host.stall", json!({}))),
            None,
        )
    };
    let decision = |sample, await_awake| StallLoopDecision {
        sample,
        await_awake,
    };
    let cases: Vec<(&str, StallOutcome, bool, bool, StallLoopDecision)> = vec![
        (
            "a beat with no open stall blocks until the run loop wakes",
            outcome(IDLE, false, None, None),
            false,
            false,
            decision(StallAction::None, true),
        ),
        (
            "a beat that keeps a stall open keeps the beat",
            outcome(open(500, None), false, None, None),
            false,
            false,
            decision(StallAction::None, false),
        ),
        (
            "a beat that ends a stall blocks until the run loop wakes",
            outcome(
                IDLE,
                false,
                Some((Level::Info, "host.stall.resumed", json!({}))),
                None,
            ),
            false,
            false,
            decision(StallAction::None, true),
        ),
        (
            "a stall starts its sample and keeps the beat",
            starting(),
            false,
            false,
            decision(StallAction::Start, false),
        ),
        (
            "a stall during a running sample reports the running sample",
            starting(),
            true,
            false,
            decision(StallAction::Running, false),
        ),
        (
            "a stall after the stop is not recorded and ends the watch",
            starting(),
            false,
            true,
            decision(StallAction::Stopped, false),
        ),
        (
            "a stall after the stop during a running sample ends the watch",
            starting(),
            true,
            true,
            decision(StallAction::Stopped, false),
        ),
        (
            "a beat that starts no stall leaves a running sample and the stop to the loop condition",
            outcome(IDLE, false, None, None),
            true,
            true,
            decision(StallAction::None, true),
        ),
    ];
    for (name, outcome, sampling, stopped, want) in cases {
        assert_eq!(stall_loop_step(&outcome, sampling, stopped), want, "{name}");
    }
}
