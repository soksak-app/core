//! The owner of the sidecar sends of a test. It records each message and each failure that the sidecar code delivers to it and
//! answers nothing but its project root, which a send of the host that names no root, such as the image detach of a reload,
//! reads from its window. A delivery never waits for the test, so the reader of a sidecar is never blocked by it, and a failure
//! that the test did not take is reported when the receiving side of the recorder is dropped.

#![allow(dead_code)]

use std::ops::Deref;
use std::sync::mpsc::{Receiver, Sender, channel};

use serde_json::value::RawValue;
use soksak_host::sidecars::{Failure, Message, Owner, Sidecars};

/// A window that records the sidecar messages and the failures it received.
#[derive(Clone)]
pub struct SidecarRecorder {
    key: String,
    /// The project root that a send of this recorder passes to the sidecars.
    pub project_root: String,
    messages: Sender<Message>,
    failures: Sender<Failure>,
}

impl Owner for SidecarRecorder {
    fn key(&self) -> String {
        self.key.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.project_root.clone())
    }

    fn deliver(&self, message: Message) {
        // A delivery after the test dropped its receiving side has no reader; the send is not an error of the sidecar.
        let _ = self.messages.send(message);
    }
    fn deliver_failure(&self, failure: Failure) {
        // A failure after the test dropped its receiving side has no reader; the check of the receiving side reports the
        // failures that arrived before.
        let _ = self.failures.send(failure);
    }
}

/// The send of a message of a window that states its project root.
pub trait SendAsRecorder {
    /// Sends body of surface to the sidecar name with the project root of the recorder.
    fn send_as(
        &self,
        owner: &SidecarRecorder,
        name: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String>;
    /// Sends body of surface as a request that continues the inputs named by cids.
    fn send_with_cids_as(
        &self,
        owner: &SidecarRecorder,
        name: &str,
        surface: &str,
        body: &RawValue,
        cids: &[String],
    ) -> Result<(), String>;
}

impl SendAsRecorder for Sidecars<SidecarRecorder> {
    fn send_as(
        &self,
        owner: &SidecarRecorder,
        name: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        self.send_with_cids_as(owner, name, surface, body, &[])
    }

    fn send_with_cids_as(
        &self,
        owner: &SidecarRecorder,
        name: &str,
        surface: &str,
        body: &RawValue,
        cids: &[String],
    ) -> Result<(), String> {
        self.send_at_root(owner, name, surface, &owner.project_root, body, cids)
    }
}

/// The messages that a recorder received. A check that takes no failure drops it with the failures that arrived untaken, and
/// that is reported.
pub struct Messages {
    received: Receiver<Message>,
    untaken: Option<Receiver<Failure>>,
}

impl Deref for Messages {
    type Target = Receiver<Message>;
    fn deref(&self) -> &Receiver<Message> {
        &self.received
    }
}

impl Drop for Messages {
    fn drop(&mut self) {
        if let Some(failures) = &self.untaken {
            report_untaken(failures);
        }
    }
}

/// The failures that a recorder received. The failures that the check did not take are reported when it is dropped.
pub struct Failures(Receiver<Failure>);

impl Deref for Failures {
    type Target = Receiver<Failure>;
    fn deref(&self) -> &Receiver<Failure> {
        &self.0
    }
}

impl Drop for Failures {
    fn drop(&mut self) {
        report_untaken(&self.0);
    }
}

/// Panics with the first failure that arrived and was not taken, unless the thread already panics.
fn report_untaken(failures: &Receiver<Failure>) {
    if std::thread::panicking() {
        return;
    }
    if let Ok(failure) = failures.try_recv() {
        panic!("sidecar failure that the test did not take: {failure:?}");
    }
}

/// A recorder of the window key with the project root root, and its messages. An arriving failure that the check does not take
/// is reported when the messages are dropped.
pub fn owner(key: &str, root: &str) -> (SidecarRecorder, Messages) {
    let (messages, received) = channel();
    let (failures, untaken) = channel();
    (
        SidecarRecorder {
            key: key.into(),
            project_root: root.into(),
            messages,
            failures,
        },
        Messages {
            received,
            untaken: Some(untaken),
        },
    )
}

/// A recorder whose failures the check takes.
pub fn failing_owner(key: &str, root: &str) -> (SidecarRecorder, Messages, Failures) {
    let (messages, received) = channel();
    let (failures, taken) = channel();
    (
        SidecarRecorder {
            key: key.into(),
            project_root: root.into(),
            messages,
            failures,
        },
        Messages {
            received,
            untaken: None,
        },
        Failures(taken),
    )
}
