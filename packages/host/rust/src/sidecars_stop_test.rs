//! Checks that a stop of the sidecars waits for no room in the queue of a persistent service and for no image present that
//! waits for the main thread (docs/spec/persistent-services.md#closing-and-recovery,
//! docs/spec/sidecars.md#declaration-and-startup).

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{
    Failure, Message, Outgoing, Owner, QueuedLine, ReplyWaiters, Sidecars,
    send_close_owner_and_shutdown,
};

// A stop sends close-owner without waiting for room in the queue of the service: a full queue fails the close at once.
// contract: sidecars-transport.stop.waits-for-no-room
#[test]
fn a_close_of_a_persistent_owner_waits_for_no_room_in_its_queue() {
    let (outbox, _queue) = sync_channel::<Outgoing>(1);
    outbox
        .try_send(Outgoing::Line(QueuedLine::new(b"{}\n".to_vec())))
        .unwrap();
    let close_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
    let shutdown_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
    let connected = AtomicBool::new(true);
    // A close that waits for room in the full queue does not return, and the check stops at the limit of its runner.
    let result = send_close_owner_and_shutdown(
        &outbox,
        &close_waiters,
        &shutdown_waiters,
        &connected,
        "fixture",
        Instant::now() + Duration::from_secs(60),
    );
    assert!(
        result.is_err(),
        "the close of a service whose queue is full succeeded"
    );
}

#[derive(Clone)]
struct StopOwner;

impl Owner for StopOwner {
    fn key(&self) -> String {
        "window-a".to_string()
    }
    fn root(&self) -> Result<String, String> {
        Ok("/".to_string())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, _failure: Failure) {}
}

// The stop of the sidecars refuses the image presents of its sidecars, so a present after the stop does not reach the main thread
// that runs the stop.
// contract: images.presentation.ends-with-the-sidecar-stop
#[test]
fn a_stop_refuses_the_image_presents_of_its_sidecars() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<StopOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    sidecars.stop();
    assert_eq!(
        crate::images::present_on_ui(
            Box::new(|| panic!("a present after the stop ran")),
            |_| panic!("a present after the stop was enqueued"),
            sidecars.presents(),
        ),
        Err(crate::images::PRESENTS_REFUSED.to_string())
    );
}
