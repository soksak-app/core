//! Tests of the main-thread service of the GPUI framework adapter.

use soksak_host::framework::Framework as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// The library waits on the main thread for the result of a task that it posts there (exposure::app_on_main), so the
/// port requires a task posted on the main thread to run before post returns; a queued task would wait for the thread
/// that waits for it.
// contract: gpuikit.service.post-on-the-main-thread-runs-at-once
#[test]
fn a_task_posted_on_the_main_thread_runs_before_post_returns() {
    super::MAIN_THREAD.get_or_init(|| std::thread::current().id());
    // The queue of the service exists and nothing drains it, as while the main thread runs the posting task.
    let (sender, _queue) = futures::channel::mpsc::unbounded();
    super::REQUESTS.get_or_init(|| sender);
    let ran = Arc::new(AtomicBool::new(false));
    let task_ran = Arc::clone(&ran);
    let result = crate::Framework.post(Box::new(move || task_ran.store(true, Ordering::SeqCst)));
    assert!(
        result.is_ok(),
        "post on the main thread failed: {:?}",
        result.err().map(|error| error.to_string())
    );
    assert!(
        ran.load(Ordering::SeqCst),
        "the task posted on the main thread did not run before post returned"
    );
}
