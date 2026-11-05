use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

type Log = Arc<Mutex<Vec<String>>>;
type Timers = Arc<Mutex<Vec<(Duration, Task)>>>;

/// A queue whose timers wait in the returned list and whose reports go to the returned log.
fn queue() -> (Arc<UiQueue>, Timers, Log) {
    let timers: Timers = Arc::default();
    let reports: Log = Arc::default();
    let held = timers.clone();
    let reported = reports.clone();
    (
        Arc::new(UiQueue::new(
            Box::new(move |wait, fire| held.lock().unwrap().push((wait, fire))),
            Box::new(move |failure| reported.lock().unwrap().push(failure)),
        )),
        timers,
        reports,
    )
}

fn started() -> (Arc<UiQueue>, Timers, Log) {
    let parts = queue();
    parts.0.start(Box::new(|| Ok(())));
    parts
}

/// A wake that refuses while the returned flag is set.
fn refusing(queue: &UiQueue) -> Arc<AtomicBool> {
    let refusing = Arc::new(AtomicBool::new(true));
    let answer = refusing.clone();
    queue.start(Box::new(move || {
        if answer.load(Ordering::SeqCst) {
            Err("the message queue is full".to_string())
        } else {
            Ok(())
        }
    }));
    refusing
}

fn note(log: &Log, name: &str) -> Task {
    let log = log.clone();
    let name = name.to_string();
    Box::new(move || log.lock().unwrap().push(name))
}

fn noted(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

#[test]
fn ui_tasks_run_in_their_order_once() {
    let (queue, _, _) = started();
    let log = Log::default();
    queue.add(note(&log, "first")).unwrap();
    queue.add(note(&log, "second")).unwrap();
    assert!(noted(&log).is_empty());
    queue.run();
    queue.run();
    assert_eq!(noted(&log), ["first", "second"]);
}

#[test]
fn a_ui_task_that_a_task_queues_waits_for_a_later_step() {
    let (queue, _, _) = started();
    let log = Log::default();
    let again = queue.clone();
    let second = note(&log, "second");
    let first = note(&log, "first");
    queue
        .add(Box::new(move || {
            first();
            again.add(second).unwrap();
        }))
        .unwrap();
    queue.run();
    assert_eq!(noted(&log), ["first"]);
    queue.run();
    assert_eq!(noted(&log), ["first", "second"]);
}

#[test]
fn a_ui_task_that_the_queue_refuses_never_runs() {
    let (queue, _, _) = queue();
    let refusing = refusing(&queue);
    let log = Log::default();
    assert!(queue.add(note(&log, "refused")).is_err());
    refusing.store(false, Ordering::SeqCst);
    queue.add(note(&log, "accepted")).unwrap();
    queue.run();
    assert_eq!(noted(&log), ["accepted"]);
}

#[test]
fn a_ui_queue_before_its_thread_refuses_a_task() {
    let (queue, timers, _) = queue();
    let log = Log::default();
    let refused = queue.add(note(&log, "early")).unwrap_err();
    assert_eq!(refused, "the UI thread has not started");
    assert!(UiQueue::add_after(&queue, Duration::ZERO, note(&log, "late")).is_err());
    assert!(timers.lock().unwrap().is_empty());
}

#[test]
fn a_delayed_ui_task_runs_as_a_step_after_its_wait() {
    let (queue, timers, _) = started();
    let log = Log::default();
    let wait = Duration::from_secs(1);
    UiQueue::add_after(&queue, wait, note(&log, "late")).unwrap();
    queue.run();
    assert!(noted(&log).is_empty());
    let (asked, fire) = timers.lock().unwrap().pop().unwrap();
    assert_eq!(asked, wait);
    fire();
    assert!(noted(&log).is_empty(), "the task ran outside a step");
    queue.run();
    assert_eq!(noted(&log), ["late"]);
}

#[test]
fn a_delayed_ui_task_that_the_queue_refuses_enters_later() {
    let (queue, timers, reports) = queue();
    let refusing = refusing(&queue);
    let log = Log::default();
    UiQueue::add_after(&queue, Duration::from_secs(1), note(&log, "late")).unwrap();
    let (_, fire) = timers.lock().unwrap().pop().unwrap();
    fire();
    assert_eq!(noted(&reports).len(), 1);
    refusing.store(false, Ordering::SeqCst);
    let (wait, retry) = timers.lock().unwrap().pop().unwrap();
    assert_eq!(wait, UI_POST_RETRY);
    retry();
    queue.run();
    assert_eq!(noted(&log), ["late"]);
    assert!(timers.lock().unwrap().is_empty());
}
