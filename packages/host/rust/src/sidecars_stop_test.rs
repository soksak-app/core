//! Checks that a stop of the sidecars waits for no image present that waits for the main thread, and the close of the
//! owner of a replacement (docs/spec/sidecars.md#declaration-and-startup, docs/spec/persistent-services.md#updates).

use std::process::{Command, Stdio};
use std::thread;

use super::{
    Failure, Message, Owner, ProcessExit, Replacement, Sidecars, await_replaced_service,
};

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

// A stop ends the wait of a replacement for the end of the process of the replaced service: the wait returns while that
// process runs, and the replacement ends (docs/spec/persistent-services.md#updates).
// contract: sidecars-transport.replace.waits-for-the-end-of-the-service-process
#[test]
fn a_stop_ends_the_wait_of_a_replacement() {
    let folder = crate::test_folder::Folder::new();
    let sidecars = Sidecars::<StopOwner>::new(&[], folder.path().to_path_buf()).unwrap();
    // The process of the replaced service reads its input, whose write end the Child holds, so it runs until the check
    // ends it and ends with the check process also when the check is killed.
    let mut service = Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    sidecars.core.state.lock().unwrap().replacing.insert(
        "fixture".to_string(),
        Replacement {
            running: Some("0.0.6".to_string()),
            installed: Some("0.0.7".to_string()),
            pid: service.id(),
        },
    );
    thread::scope(|scope| {
        let waiting = scope.spawn(|| await_replaced_service(&sidecars.core, "fixture"));
        // A stop that does not end the wait leaves it waiting, and the check stops at the limit of its runner.
        sidecars.stop();
        waiting.join().unwrap();
    });
    assert!(
        !sidecars
            .core
            .state
            .lock()
            .unwrap()
            .replacing
            .contains_key("fixture"),
        "the replacement that the stop ended is still recorded"
    );
    assert!(
        service.try_wait().unwrap().is_none(),
        "the wait ended by the exit of the service process and not by the stop"
    );
    service.kill().unwrap();
    service.wait().unwrap();
}

// The exit wait of a sidecar ends the process group of the exited process before it reaps that process, so while the group
// ends the leader is a process of the host that no one reaped and its pid names its group and no other process
// (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.group-ends-before-leader-reap
#[test]
fn a_group_ends_before_its_leader_is_reaped() {
    let platform = crate::platform::current().unwrap();
    let mut command = Command::new("true");
    platform.new_process_group(&mut command).unwrap();
    let mut leader = command.spawn().unwrap();
    let pid = leader.id();
    // The signal 0 reaches a process that exists, and a zombie that no one reaped exists; after the reap the pid names no
    // process.
    let exists = || {
        let id = i32::try_from(pid).unwrap();
        if unsafe { libc::kill(id, 0) } == 0 {
            return true;
        }
        let error = std::io::Error::last_os_error();
        assert_eq!(error.raw_os_error(), Some(libc::ESRCH), "signal 0 to {pid}");
        false
    };
    let exit = ProcessExit::new();
    let status = thread::scope(|scope| {
        // The reap waits for the end of the group.
        let reap = scope.spawn(|| exit.reap(&mut leader));
        platform.wait_process_exit(pid).unwrap();
        let mut ended = false;
        exit.end_group(|| {
            ended = true;
            assert!(
                exists(),
                "the leader {pid} was reaped before the end of its group"
            );
            platform.end_process_group(pid)
        })
        .unwrap();
        assert!(ended, "the exit wait did not end the group");
        reap.join().unwrap().unwrap()
    });
    assert!(status.success(), "the leader {pid} ended with {status}");
    assert!(
        !exists(),
        "the leader {pid} is not reaped after the exit wait"
    );
    exit.signal_group(|| panic!("a signal reached the group after its end"))
        .unwrap();
}
