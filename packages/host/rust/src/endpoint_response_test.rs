use super::*;
use std::sync::mpsc;

// contract: endpoint.response.follows-the-socket-write
#[test]
fn reply_scope_completion_and_late_registration_run_once_outside_the_scope_lock() {
    let (scope, mut completion) = ReplyScope::pending();
    let (tx, rx) = mpsc::channel();
    let nested = scope.clone();
    scope.after_response(move |outcome| {
        tx.send(outcome).unwrap();
        nested.after_response(move |outcome| tx.send(outcome).unwrap());
    });
    assert!(completion.finish(ReplyOutcome::Written));
    assert!(!completion.finish(ReplyOutcome::Abandoned));
    drop(completion);
    assert_eq!(
        rx.try_iter().collect::<Vec<_>>(),
        vec![ReplyOutcome::Written, ReplyOutcome::Written]
    );
}

// contract: endpoint.response.reports-its-outcome
#[test]
fn dropping_a_scope_clone_does_not_complete_but_abandoning_its_answer_does() {
    let (scope, completion) = ReplyScope::pending();
    let (tx, rx) = mpsc::channel();
    scope.after_response(move |outcome| tx.send(outcome).unwrap());
    drop(scope.clone());
    assert!(rx.try_recv().is_err());
    drop(completion);
    assert_eq!(rx.try_recv().unwrap(), ReplyOutcome::Abandoned);
    let (tx, rx) = mpsc::channel();
    scope.after_response(move |outcome| tx.send(outcome).unwrap());
    assert_eq!(rx.try_recv().unwrap(), ReplyOutcome::Abandoned);
}

#[derive(Clone)]
struct FailedFlush;
impl Read for FailedFlush {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}
impl Write for FailedFlush {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Err(std::io::Error::other("fixture response flush failed"))
    }
}
impl Connection for FailedFlush {
    fn try_clone(&self) -> Result<Box<dyn Connection>, String> {
        Ok(Box::new(self.clone()))
    }
    fn close(&self) -> Result<(), String> {
        Ok(())
    }
}

// contract: endpoint.response.reports-its-outcome
#[test]
fn a_failed_response_flush_releases_intent_with_failure_after_unlocking_writer() {
    let writer: Arc<Mutex<Box<dyn Connection>>> = Arc::new(Mutex::new(Box::new(FailedFlush)));
    let (scope, completion) = ReplyScope::pending();
    let (tx, rx) = mpsc::channel();
    let observed = writer.clone();
    scope.after_response(move |outcome| {
        tx.send((outcome, observed.try_lock().is_ok())).unwrap();
    });
    let answer = Answer {
        writer,
        id: Some(json!(5)),
        call: Call::begin("command.run", b"{}"),
        completion,
    };
    answer.send(raw(&Value::Null));
    assert_eq!(
        rx.try_recv().unwrap(),
        (
            ReplyOutcome::WriteFailed("fixture response flush failed".into()),
            true
        )
    );
}

// contract: endpoint.response.reports-its-outcome
#[test]
fn a_notification_releases_intent_without_claiming_a_response_was_written() {
    let writer: Arc<Mutex<Box<dyn Connection>>> = Arc::new(Mutex::new(Box::new(FailedFlush)));
    let (scope, completion) = ReplyScope::pending();
    let (tx, rx) = mpsc::channel();
    scope.after_response(move |outcome| tx.send(outcome).unwrap());
    Answer {
        writer,
        id: None,
        call: Call::begin("command.run", b"{}"),
        completion,
    }
    .send(raw(&Value::Null));
    assert_eq!(rx.try_recv().unwrap(), ReplyOutcome::NoResponse);
}
