//! The wake of the native ring through the platform (docs/spec/logging.md#writers). A byte of the pipe wakes one reader, so this
//! file holds the one reader of its process: no test here starts a host writer.

#[path = "support/platform/native_event.rs"]
mod native_event;

use std::time::Duration;

use soksak_host::platform;

#[test]
fn a_native_event_ends_the_wait_of_the_platform() {
    let system = platform::current().unwrap();
    let mut wait = system.native_event_wake().unwrap();
    let mut buffer = [0u8; 4096];
    assert_eq!(system.pull_native_events(&mut buffer).unwrap(), 0);
    let (ended, ends) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        loop {
            wait().unwrap();
            if ended.send(()).is_err() {
                return;
            }
        }
    });
    assert!(
        ends.recv_timeout(Duration::from_millis(100)).is_err(),
        "the wait ended with an empty ring"
    );
    assert!(native_event::record(c"native.test.wake"));
    ends.recv_timeout(Duration::from_secs(5))
        .expect("the wait did not end after a native event");
    assert!(system.pull_native_events(&mut buffer).unwrap() > 0);
}
