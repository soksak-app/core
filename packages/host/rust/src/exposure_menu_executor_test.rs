use super::*;
use std::sync::{Arc, Mutex, mpsc};

enum Step {
    Native(Box<dyn FnOnce() + Send>),
    Finished(Result<(), String>),
}

// contract: menu.select.runs-after-the-framework-callback-unwinds
#[test]
fn native_menu_action_runs_after_the_framework_callback_unwinds() {
    let (_app, framework) = crate::test_framework::application_with_queue();
    let callback = Arc::new(Mutex::new(()));
    framework.hold_callback(callback.clone());
    let (tx, rx) = mpsc::channel();
    let (action_tx, action_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let queue = tx.clone();
        let result = menu_select_from_worker(
            "Edit".into(),
            "Copy".into(),
            move |task| {
                queue
                    .send(Step::Native(task))
                    .map_err(|error| error.to_string())
            },
            move |menu, title| {
                let _guard = callback.try_lock().map_err(|_| {
                    "native menu action reentered the held framework callback".to_string()
                })?;
                action_tx.send((menu, title)).unwrap();
                Ok(())
            },
        );
        tx.send(Step::Finished(result)).unwrap();
    });
    match rx.recv().unwrap() {
        Step::Native(task) => task(),
        Step::Finished(result) => panic!("menu bypassed the native UI queue: {result:?}"),
    }
    match rx.recv().unwrap() {
        Step::Finished(result) => assert_eq!(result, Ok(())),
        Step::Native(_) => panic!("menu scheduled more than one native task"),
    }
    worker.join().unwrap();
    assert_eq!(action_rx.recv().unwrap(), ("Edit".into(), "Copy".into()));
}

// contract: menu.select.answers-the-failure-of-the-item
#[test]
fn native_menu_action_preserves_its_actual_failure() {
    assert_eq!(
        menu_select_from_worker(
            "File".into(),
            "Refused".into(),
            |task| {
                task();
                Ok(())
            },
            |_, _| Err("native selected item refused".into())
        ),
        Err("native selected item refused".into())
    );
}

// contract: menu.select.queue-refusal-performs-nothing
#[test]
fn native_menu_queue_failure_does_not_perform_the_action() {
    let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let action = called.clone();
    assert_eq!(
        menu_select_from_worker(
            "Edit".into(),
            "Copy".into(),
            |_| Err("native UI queue unavailable".into()),
            move |_, _| {
                action.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
        ),
        Err("native UI queue unavailable".into())
    );
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
}
