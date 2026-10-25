use super::*;
use std::sync::mpsc;

#[test]
fn a_pending_newer_frame_is_required_after_the_wait_begins() {
    let images = Images::default();
    let key = ("surface".into(), "view".into());
    images
        .reserve(&key, "owner", "sidecar")
        .expect("reserve image");
    assert!(images.set(&key, 100));
    let config = images
        .configure_raster(&key, 800, 600, 2.0, true)
        .expect("configure raster")
        .expect("new raster");
    images
        .lock()
        .states
        .get_mut(&key)
        .expect("image state")
        .last_sequence = 1;
    let began = Instant::now();
    let timeout = Duration::from_millis(500);
    let waiter = images.clone();
    let (started, waiting) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        waiter.wait_current_observed(timeout, || {
            started.send(()).expect("signal initialized wait");
        })
    });
    waiting
        .recv_timeout(Duration::from_secs(2))
        .expect("wait begins");
    let arrival_elapsed = {
        // Hold the owner lock across presentation and the next arrival so the waiter wakes after both.
        let mut inner = images.lock();
        let state = inner.states.get_mut(&key).expect("image state");
        state.presented_raster = config.raster;
        state.presented_sequence = 1;
        state.last_sequence = 2;
        images.changed();
        began.elapsed()
    };
    let result = worker.join().expect("join image wait");
    assert!(
        arrival_elapsed < timeout,
        "controlled arrival missed the active wait deadline: {arrival_elapsed:?}"
    );
    assert_eq!(
        result,
        Err("presentationTimeout".into()),
        "the newer accepted frame remains pending after the earlier frame completed"
    );
    assert!(
        !images.current_presented(),
        "instantaneous status still reports the pending newer frame"
    );
    assert_eq!(
        images.wait_current(Duration::ZERO),
        Err("presentationTimeout".into()),
        "a new wait must require the already accepted second frame"
    );
}
