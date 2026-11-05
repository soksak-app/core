use std::thread::{ThreadId, current, sleep};
use std::time::Duration;

use super::*;

/// The workers of the runtime only await: a command body runs on the blocking threads, so the number of processors does not
/// decide how many workers the host holds.
#[test]
fn the_asynchronous_runtime_has_two_workers() {
    let runtime = async_runtime().unwrap();
    assert_eq!(runtime.metrics().num_workers(), 2);
}

/// A blocking thread that a burst of commands started ends one second after its last task, so the next task starts a new one.
#[test]
fn an_idle_blocking_thread_of_the_runtime_ends_after_one_second() {
    let runtime = async_runtime().unwrap();
    let thread = || -> ThreadId {
        runtime
            .block_on(runtime.spawn_blocking(|| current().id()))
            .unwrap()
    };
    let first = thread();
    sleep(Duration::from_secs(3));
    assert_ne!(thread(), first, "the idle thread ended");
}
