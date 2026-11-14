//! Tests of the relay of the memory pressure reports (docs/spec/hosts.md#memory-pressure). The relay runs on the real memory
//! pressure source of the platform, whose reports belong to the main thread, so this target runs its tests on the main thread of
//! its process (`harness = false`); the level of a report is delivered through the fault injection of the platform.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};
use soksak_host::memory_pressure::{parse_level, start};
use soksak_host::platform;

#[path = "support/main_thread.rs"]
mod main_thread;

// The source of the platform is the one source of the process, so the relay test starts it once and starts it again.
// contract: host.memory-pressure.relays-level-and-seq
fn the_memory_pressure_relays_level_and_seq() -> Result<(), String> {
    let system = platform::current()?;
    let sent: Rc<RefCell<Vec<(String, Value)>>> = Rc::new(RefCell::new(Vec::new()));
    let record = sent.clone();
    start(
        |report| system.on_memory_pressure(report),
        move |name: &str, payload: Value| record.borrow_mut().push((name.to_string(), payload)),
    )?;
    system.inject_memory_pressure("warn")?;
    system.inject_memory_pressure("normal")?;
    let want = vec![
        (
            "memory-pressure".to_string(),
            json!({"level": "warn", "seq": 1}),
        ),
        (
            "memory-pressure".to_string(),
            json!({"level": "normal", "seq": 2}),
        ),
    ];
    if *sent.borrow() != want {
        return Err(format!("sent {:?}, want {want:?}", sent.borrow()));
    }
    // A refused start leaves the report of the running source in place.
    let refused = start(
        |report| system.on_memory_pressure(report),
        |_: &str, _: Value| {},
    );
    if refused != Err("failed to start the memory pressure source".to_string()) {
        return Err(format!("a second start returned {refused:?}"));
    }
    system.inject_memory_pressure("critical")?;
    let want_third = (
        "memory-pressure".to_string(),
        json!({"level": "critical", "seq": 3}),
    );
    if sent.borrow().get(2) != Some(&want_third) {
        return Err(format!(
            "after a refused start the source sent {:?}, want {want_third:?}",
            sent.borrow().get(2)
        ));
    }
    Ok(())
}

// contract: diagnostics.memory-pressure.level-validates
fn the_memory_pressure_level_validates() -> Result<(), String> {
    for level in ["normal", "warn", "critical"] {
        if parse_level(Some(&json!(level))) != Ok(level.to_string()) {
            return Err(format!("the level {level} was not accepted"));
        }
    }
    for raw in [
        None,
        Some(json!(null)),
        Some(json!("severe")),
        Some(json!("Warn")),
        Some(json!(1)),
        Some(json!({})),
    ] {
        if parse_level(raw.as_ref()) != Err("level must be normal, warn or critical".to_string()) {
            return Err(format!("{raw:?} was not refused with the level text"));
        }
    }
    Ok(())
}

const TESTS: &[main_thread::MainTest] = &[
    (
        "the_memory_pressure_relays_level_and_seq",
        the_memory_pressure_relays_level_and_seq,
    ),
    (
        "the_memory_pressure_level_validates",
        the_memory_pressure_level_validates,
    ),
];

fn main() {
    main_thread::run(TESTS);
}
