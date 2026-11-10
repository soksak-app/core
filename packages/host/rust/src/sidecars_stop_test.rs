//! Checks that a stop of the sidecars waits for no room in the queue of a persistent service
//! (docs/spec/persistent-services.md#closing-and-recovery).

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{channel, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{Outgoing, QueuedLine, ReplyWaiters, send_close_owner_and_shutdown};

/// Bounds a check whose end does not come; the end of each check is the return of the call.
const END: Duration = Duration::from_secs(5);

// A stop sends close-owner without waiting for room in the queue of the service: a full queue fails the close at once.
// contract: sidecars-transport.stop.waits-for-no-room
#[test]
fn a_close_of_a_persistent_owner_waits_for_no_room_in_its_queue() {
    let (outbox, _queue) = sync_channel::<Outgoing>(1);
    outbox
        .try_send(Outgoing::Line(QueuedLine::new(b"{}\n".to_vec())))
        .unwrap();
    let (closed, ended) = channel();
    std::thread::spawn(move || {
        let close_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
        let shutdown_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
        let connected = AtomicBool::new(true);
        let result = send_close_owner_and_shutdown(
            &outbox,
            &close_waiters,
            &shutdown_waiters,
            &connected,
            "fixture",
            Instant::now() + Duration::from_secs(60),
        );
        closed
            .send(result.is_err())
            .expect("the test holds the receiver");
    });
    let failed = ended
        .recv_timeout(END)
        .expect("the close waits for room in the full queue of the service");
    assert!(failed, "the close of a service whose queue is full succeeded");
}
