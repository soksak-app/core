//! The wake of the native ring through the platform (docs/spec/logging.md#writers). A byte of the pipe wakes one reader, so this
//! file holds the one reader of its process: no test here starts a host writer.

#[path = "support/platform/native_event.rs"]
mod native_event;

use soksak_host::platform;

// contract: log.native.wake-stores-a-record-at-once
#[test]
fn a_native_event_ends_the_wait_of_the_platform() {
    let system = platform::current().unwrap();
    let mut wait = system.native_event_wake().unwrap();
    let mut buffer = [0u8; 4096];
    assert_eq!(system.pull_native_events(&mut buffer).unwrap(), 0);
    // The wait ends exactly when the pipe of the wake is readable, so a pipe that is not readable with an empty ring is a wait that
    // does not end.
    assert!(
        !native_event::wake_is_ready(),
        "the wait ends with an empty ring"
    );
    let (ended, ends) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        loop {
            wait().unwrap();
            if ended.send(()).is_err() {
                return;
            }
        }
    });
    assert!(native_event::record(c"native.test.wake"));
    ends.recv()
        .expect("the wait did not end after a native event");
    assert!(system.pull_native_events(&mut buffer).unwrap() > 0);
}
