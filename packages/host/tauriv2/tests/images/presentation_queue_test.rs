use super::present_on_ui;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

#[test]
fn image_commit_runs_after_the_framework_event_releases_its_lock() {
    let event_lock = Arc::new(Mutex::new(()));
    let event = event_lock.lock().expect("hold framework event lock");
    let commit_lock = Arc::clone(&event_lock);
    let (enqueue, queued) = mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(1);
    let worker = std::thread::spawn(move || {
        present_on_ui(
            Box::new(move || {
                let _guard = commit_lock
                    .try_lock()
                    .map_err(|error| format!("redraw re-entered framework event lock: {error}"))?;
                Ok(())
            }),
            |work| enqueue.send(work).map_err(|error| error.to_string()),
        )
    });
    let callback = queued.recv_timeout(Duration::from_secs(2));
    drop(event);
    if let Ok(callback) = callback {
        callback();
    }
    let result = worker.join().expect("join image presentation worker");
    assert_eq!(
        result,
        Ok(()),
        "image commit must run outside the framework event lock"
    );
}

#[test]
fn image_enqueue_failure_reaches_the_frame_handler() {
    let result = present_on_ui(Box::new(|| panic!("refused work ran")), |_| {
        Err("native queue refused".into())
    });
    assert_eq!(result, Err("native queue refused".into()));
}

#[test]
fn native_image_failure_reaches_the_frame_handler() {
    let result = present_on_ui(
        Box::new(|| Err("native presentation refused".into())),
        |work| {
            work();
            Ok(())
        },
    );
    assert_eq!(result, Err("native presentation refused".into()));
}
