//! The watch of the main thread records a stall, the stacks of the threads and the end of the stall against the real platform
//! (docs/spec/logging.md, stalls). The main run loop answers the heartbeat on the main thread only while the thread runs it, so
//! this target runs its tests on the main thread of its process (`harness = false` in Cargo.toml) and each test runs its
//! scenario in a child process of the same binary: the main thread of the child runs the main run loop or holds the thread. The
//! watch stores its records in the event log of the configuration folder of the test, which the test reads. The decision of
//! each beat is a function of its readings, which the table tests in src/stall_watch_test.rs judge with exact values.

#[path = "support/folder.rs"]
mod folder;

#[path = "support/records.rs"]
mod records;

#[path = "support/main_thread.rs"]
mod main_thread;

#[path = "support/platform/darwin/stall_watch.rs"]
mod system;

fn main() {
    system::main();
}
