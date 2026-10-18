//! Tests of the relay of the memory pressure reports (docs/spec/hosts.md#memory-pressure). A fake source stands for the
//! native owner, which the native test memory_pressure_test checks.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};
use soksak_host_tauriv2::memory_pressure::{Report, parse_level, start};

// contract: host.memory-pressure.relays-level-and-seq
#[test]
fn the_memory_pressure_relays_level_and_seq() {
    let registered: Rc<RefCell<Option<Report>>> = Rc::new(RefCell::new(None));
    let sent: Rc<RefCell<Vec<(String, Value)>>> = Rc::new(RefCell::new(Vec::new()));
    let keep = registered.clone();
    let record = sent.clone();
    start(
        move |report| {
            *keep.borrow_mut() = Some(report);
            Ok(())
        },
        move |name: &str, payload: Value| record.borrow_mut().push((name.to_string(), payload)),
    )
    .unwrap();
    let report = registered
        .borrow_mut()
        .take()
        .expect("the host registered no report function");
    report("warn", 1);
    report("normal", 2);
    assert_eq!(
        *sent.borrow(),
        vec![
            (
                "memory-pressure".to_string(),
                json!({"level": "warn", "seq": 1})
            ),
            (
                "memory-pressure".to_string(),
                json!({"level": "normal", "seq": 2})
            ),
        ]
    );
    assert_eq!(
        start(
            |_| Err("failed to start the memory pressure source".to_string()),
            |_: &str, _: Value| {}
        ),
        Err("failed to start the memory pressure source".to_string())
    );
}

// contract: diagnostics.memory-pressure.level-validates
#[test]
fn the_memory_pressure_level_validates() {
    for level in ["normal", "warn", "critical"] {
        assert_eq!(parse_level(Some(&json!(level))), Ok(level.to_string()));
    }
    for raw in [
        None,
        Some(json!(null)),
        Some(json!("severe")),
        Some(json!("Warn")),
        Some(json!(1)),
        Some(json!({})),
    ] {
        assert_eq!(
            parse_level(raw.as_ref()),
            Err("level must be normal, warn or critical".to_string()),
            "{raw:?}"
        );
    }
}
