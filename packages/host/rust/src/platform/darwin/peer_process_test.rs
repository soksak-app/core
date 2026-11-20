//! The process of a connection and the entry of a process in the process table (docs/spec/sidecars.md#process-identity), read from
//! a real socket and a real child process.

use std::os::unix::net::UnixStream;
use std::process::Command;

use super::{listen, process_entry};

// contract: sidecars.process-identity.reads-the-peer-process-from-the-socket
#[test]
fn the_peer_process_is_the_process_that_connected() {
    let folder = crate::test_folder::Folder::new();
    let listener = listen(&folder.path().join("sockets"), "test-peer").unwrap();
    let _peer = UnixStream::connect(listener.address()).unwrap();
    let connection = listener.accept().unwrap();
    assert_eq!(connection.peer_process(), Ok(std::process::id()));
    listener.remove();
}

// contract: sidecars.process-identity.reads-the-parent-and-the-start-time
#[test]
fn the_process_entry_holds_the_parent_and_the_start_time() {
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut child = Command::new("/bin/sleep").arg("600").spawn().unwrap();
    let entry = process_entry(child.id());
    let after = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    child.kill().unwrap();
    child.wait().unwrap();
    let entry = entry.unwrap().expect("the child is in the process table");
    assert_eq!(entry.parent, std::process::id());
    assert!(
        (before - 1..=after).contains(&entry.started),
        "started {} is not between {before} and {after}",
        entry.started
    );
    assert_eq!(process_entry(0), Ok(None));
}
