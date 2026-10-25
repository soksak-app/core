use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc::{TryRecvError, sync_channel};

use super::{Failure, Message, Outgoing, Owner, Process, Sidecars};

#[derive(Clone)]
struct TestOwner;

impl Owner for TestOwner {
    fn key(&self) -> String {
        "window-a".into()
    }

    fn root(&self) -> Result<String, String> {
        Ok("/project".into())
    }

    fn deliver(&self, _message: Message) {}

    fn deliver_failure(&self, _failure: Failure) {}
}

// contract: sidecars.native-view-removal.closes-stdio-session
#[test]
fn native_view_removal_still_closes_a_standard_io_session() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<TestOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    let owner = TestOwner;
    let surface = "tab-standard";
    let (sender, receiver) = sync_channel(2);
    {
        let mut state = sidecars.core.state.lock().unwrap();
        state.owners.insert(surface.into(), owner.clone());
        state.roots.insert(surface.into(), "/project".into());
        state.running.insert(
            "fixture-standard".into(),
            Process {
                child: None,
                outbox: sender,
                writing: Arc::new(AtomicUsize::new(0)),
                persistent: None,
                surfaces: HashSet::from([surface.into()]),
                closed_surfaces: HashSet::new(),
            },
        );
    }

    sidecars
        .native_views_removed(&owner, &HashSet::from([surface.to_string()]))
        .unwrap();

    let Outgoing::Line(line) = receiver.try_recv().unwrap() else {
        panic!("native view removal sent a non-line message")
    };
    let request: serde_json::Value = serde_json::from_slice(&line.bytes).unwrap();
    assert_eq!(request["surface"], surface);
    assert_eq!(request["closed"], true);
    assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
}
