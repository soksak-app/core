//! The watch of the policy file holds the file before it reads it (docs/spec/logging.md#classes-and-policy): a write in place
//! that lands right after the creation gives a notification of its own, or the read that follows the watch sees it. The same
//! case runs in the Go host.
#![cfg(feature = "diagnostics")]

#[path = "support/folder.rs"]
mod folder;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::mpsc::channel;
use std::time::Duration;

use soksak_host_tauriv2::event_log::{self, Options};
use soksak_host_tauriv2::log_policy::start_log_policy;
use soksak_host_tauriv2::log_policy_watch_hook::set_log_policy_watch_hook;

// contract: log.policy.event-reaches-every-document
#[test]
fn a_created_policy_file_is_watched_before_its_read() {
    let config = folder::Folder::new();
    let policy_path = config.path().join("log-policy.json");
    let log = std::sync::Arc::new(
        event_log::start(Options {
            directory: config.path().join("logs"),
            role: "host".into(),
            boot: "b1".into(),
            queue_events: 64,
            queue_bytes: 64 * 1024,
            batch_interval: Duration::from_millis(20),
            rotate_bytes: 1 << 30,
            pull: None,
            pull_loss: None,
            policy_path: Some(policy_path.clone()),
            retention_bytes: 1 << 40,
        })
        .unwrap(),
    );
    let (sender, reads) = channel::<Vec<PathBuf>>();
    let sender = Mutex::new(sender);
    set_log_policy_watch_hook(Some(Box::new(move |watched: &[PathBuf]| {
        sender.lock().unwrap().send(watched.to_vec()).unwrap();
    })));
    let watch = start_log_policy(&log, None).unwrap();
    fs::write(&policy_path, r#"{"schema":9}"#).unwrap();
    let watched = reads
        .recv_timeout(Duration::from_secs(10))
        .expect("no notification of the created policy file within 10 seconds");
    drop(watch);
    set_log_policy_watch_hook(None);
    assert!(
        watched.contains(&policy_path),
        "the read of the created policy file started while the watch held {watched:?}, without the file"
    );
}
