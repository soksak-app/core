//! The notices of the writes of the event log are coalesced to the latest write (docs/spec/debug.md).

use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use soksak_host_tauriv2::debug_follow::coalesce_log_notices;

// contract: debug.follow.coalesces-writes-into-a-notice
#[test]
fn log_notices_coalesce_to_the_latest_write_without_blocking_the_writer() {
    let (release_sender, release_receiver) = channel::<()>();
    let release_receiver = Arc::new(Mutex::new(release_receiver));
    let (notice_sender, notice_receiver) = channel::<(PathBuf, u64)>();
    let notice_sender = Mutex::new(notice_sender);
    let (observe, stop) = coalesce_log_notices(move |path: &Path, size: u64| {
        release_receiver.lock().unwrap().recv().unwrap();
        notice_sender
            .lock()
            .unwrap()
            .send((path.to_path_buf(), size))
            .unwrap();
    });
    let started = Instant::now();
    for size in 1..=50u64 {
        observe(Path::new("logs/host-b1.jsonl"), size);
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the writer waited {:?} for the notices",
        started.elapsed()
    );
    // The first notice is released by one permit, and the coalesced notice by the second.
    release_sender.send(()).unwrap();
    release_sender.send(()).unwrap();
    let mut last = (PathBuf::new(), 0);
    for _ in 0..2 {
        last = notice_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("a notice did not arrive");
        if last.1 == 50 {
            break;
        }
    }
    assert_eq!(last, (PathBuf::from("logs/host-b1.jsonl"), 50));
    assert!(
        notice_receiver
            .recv_timeout(Duration::from_millis(200))
            .is_err(),
        "a notice follows the latest write"
    );
    stop();
}
