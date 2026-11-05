//! The wake of the native ring through the platform (docs/spec/logging.md#writers). A byte of the pipe wakes one reader, so this
//! file holds the one reader of its process: no test here starts a host writer.
#![cfg(target_os = "macos")]

use std::time::Duration;

use soksak_host::platform;

unsafe extern "C" {
    fn sp_event(
        class: u8,
        level: u8,
        name: *const std::ffi::c_char,
        fields_json: *const std::ffi::c_char,
    ) -> bool;
}

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
    assert!(unsafe { sp_event(0, 0, c"native.test.wake".as_ptr(), c"{}".as_ptr()) });
    ends.recv_timeout(Duration::from_secs(5))
        .expect("the wait did not end after a native event");
    assert!(system.pull_native_events(&mut buffer).unwrap() > 0);
}
