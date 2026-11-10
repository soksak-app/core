//! Checks that a SIGINT or SIGTERM that sok receives ends sok process wait. The test raises the signal in its own process,
//! so it holds the signal lock of the tests of the wait.

use crate::process_wait_tests::{hold_the_signals, run_wait};

// A SIGINT or SIGTERM that sok receives ends the wait. The wait sends a notice when it began, which is the point at which
// the wait has not ended; the test then raises the signal in its own process and receives the answer, and only after the
// answer lets the wait return. The command watches the signals before it starts the wait, so the signal cannot come
// before the watch.
// contract: cli.process-wait.signal-ends-the-wait
#[test]
fn process_wait_ends_by_a_signal() {
    let _signals = hold_the_signals();
    for (name, signal) in [
        ("SIGINT", signal_hook::consts::SIGINT),
        ("SIGTERM", signal_hook::consts::SIGTERM),
    ] {
        let (began_tx, began_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (answer_tx, answer_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let answer = run_wait(Box::new(move |_pid: i32| {
                began_tx.send(()).expect("notice that the wait began");
                // The test drops the sender after the answer, which lets the wait return.
                assert!(
                    release_rx.recv().is_err(),
                    "the test releases the wait by dropping the sender"
                );
                Ok(())
            }));
            answer_tx.send(answer).expect("send the answer");
        });
        began_rx.recv().expect("the wait began");
        assert!(
            answer_rx.try_recv().is_err(),
            "{name}: the wait answered before the process ended"
        );
        signal_hook::low_level::raise(signal).expect("raise the signal");
        let (status, stdout, stderr) = answer_rx.recv().expect("the answer of the wait");
        drop(release_tx);
        assert_eq!(status, 1, "{name}: stdout={stdout:?} stderr={stderr:?}");
        assert!(stdout.is_empty(), "{name}: stdout={stdout:?}");
        assert_eq!(
            stderr,
            format!("sok: process 1234 wait was interrupted by {name}\n")
        );
    }
}
