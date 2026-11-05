//! Checks that a flush request that the writer finds while it answers another flush request is answered too.

use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::lock_test::folder::Folder;
use super::{EventLog, Message, Options};

const DEADLINE: Duration = Duration::from_secs(5);

// The source puts the second request in the queue while the writer pulls for the first, so the writer finds it in the same
// drain. An interval of an hour keeps the end of an interval out of the answer.
#[test]
fn a_flush_that_a_flush_finds_behind_it_is_answered() {
    let directory = Folder::new("event-log-flush");
    let queue: Arc<Mutex<Option<SyncSender<Message>>>> = Arc::new(Mutex::new(None));
    let held: Arc<Mutex<Option<Message>>> = Arc::new(Mutex::new(None));
    let (source_queue, source_held) = (queue.clone(), held.clone());
    let log = EventLog::start(Options {
        directory: directory.path().to_path_buf(),
        role: "probe".into(),
        boot: "flush".into(),
        layer: "sok",
        clock: || 42,
        spawn: |body| {
            std::thread::Builder::new()
                .name("probe-writer".into())
                .spawn(body)
                .map_err(|error| error.to_string())
        },
        queue_events: 64,
        queue_bytes: 1 << 20,
        batch_interval: Duration::from_secs(3600),
        rotate_bytes: 0,
        pull: Some(Box::new(move |_| {
            if let Some(message) = source_held.lock().unwrap().take() {
                let queue = source_queue.lock().unwrap();
                assert!(queue.as_ref().unwrap().try_send(message).is_ok());
            }
        })),
        wake: Some(Box::new(|_| Ok(()))),
        policy_path: None,
        prune: None,
    })
    .unwrap();
    *queue.lock().unwrap() = Some(log.sender.clone());
    let (done, second) = sync_channel(1);
    *held.lock().unwrap() = Some(Message::Flush(done));

    log.flush(DEADLINE).unwrap();

    second
        .recv_timeout(DEADLINE)
        .expect("the flush behind the flush is answered");
    log.close();
}
