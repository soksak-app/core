use super::*;

unsafe extern "C" {
    fn sp_document_fail_creation_for_test(cause: *const c_char);
}

// The injected failure is one process-wide value of the native layer, so the tests that inject it run one at a time.
static INJECTION: std::sync::Mutex<()> = std::sync::Mutex::new(());

// A creation of a document region that the native layer fails reports the native cause after the creation error.
// contract: host.document.creation-error-states-the-cause
#[test]
fn create_reports_the_native_cause() {
    let _guard = INJECTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cause = CString::new("cannot create the data store directory /probe: test fault").unwrap();
    unsafe { sp_document_fail_creation_for_test(cause.as_ptr()) };
    let error = match create(0, "/probe", "", "probe", None, Box::new(|_| {})) {
        Ok(_) => panic!("a creation that the native layer fails returned a handle"),
        Err(error) => error,
    };
    assert_eq!(
        error,
        "cannot create a document view in this surface: cannot create the data store directory /probe: test fault"
    );
}

// A creation of a plugin host web view that the native layer fails reports the native cause after the creation error.
// contract: host.document.creation-error-states-the-cause
#[test]
fn create_plugin_host_reports_the_native_cause() {
    let _guard = INJECTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cause = CString::new("the version of /Applications/Safari.app cannot be read").unwrap();
    unsafe { sp_document_fail_creation_for_test(cause.as_ptr()) };
    let error = match create_plugin_host(0, "/probe", "", "probe", "channel", Box::new(|_| {})) {
        Ok(_) => panic!("a creation that the native layer fails returned a handle"),
        Err(error) => error,
    };
    assert_eq!(
        error,
        "cannot create a plugin host webview in this window: the version of /Applications/Safari.app cannot be read"
    );
}

struct CallbackDrop(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for CallbackDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn callback_retirement(kind: &str) {
    use std::sync::{Arc, atomic::AtomicUsize};
    const DOCUMENT: Handle = 1;
    let dropped = Arc::new(AtomicUsize::new(0));
    let observed = Arc::new(AtomicUsize::new(usize::MAX));
    let witness = CallbackDrop(dropped.clone());
    let count = dropped.clone();
    let observed_during = observed.clone();
    let run = move || {
        std::hint::black_box(&witness);
        let count = count.clone();
        let observed_during = observed_during.clone();
        release_receivers(DOCUMENT);
        observed_during.store(count.load(Ordering::SeqCst), Ordering::SeqCst);
    };
    match kind {
        "ended" => {
            let callback: Box<dyn Fn() + Send> = Box::new(run);
            let receiver = Box::into_raw(Box::new(EndedReceiver(callback.into())));
            VIEW_ENDS.with(|all| all.borrow_mut().insert(DOCUMENT, receiver));
            ended(receiver.cast());
        }
        "changed" => {
            let callback: Box<dyn Fn(String)> = Box::new(move |_| run());
            let receiver = Box::into_raw(Box::new(Receiver(callback.into())));
            RECEIVERS.with(|all| all.borrow_mut().insert(DOCUMENT, receiver));
            changed(receiver.cast(), CString::new("state").unwrap().as_ptr());
        }
        "event" => {
            let callback: Box<dyn Fn(String) + Send> = Box::new(move |_| run());
            let receiver = Box::into_raw(Box::new(EventReceiver(callback.into())));
            EVENTS.with(|all| all.borrow_mut().insert(DOCUMENT, receiver));
            event(receiver.cast(), CString::new("event").unwrap().as_ptr());
        }
        "responsiveness" => {
            let callback: Box<dyn Fn(bool) + Send> = Box::new(move |_| run());
            let receiver = Box::into_raw(Box::new(ResponsivenessReceiver(callback.into())));
            VIEW_RESPONSIVENESS.with(|all| all.borrow_mut().insert(DOCUMENT, receiver));
            responsiveness(receiver.cast(), false);
        }
        _ => panic!("unknown callback kind {kind}"),
    }
    assert_eq!(
        observed.load(Ordering::SeqCst),
        0,
        "{kind} callback was dropped while it was executing"
    );
    assert_eq!(
        dropped.load(Ordering::SeqCst),
        1,
        "{kind} callback was not released after it returned"
    );
}

#[test]
fn callback_lifetime_ended_survives_document_retirement() {
    callback_retirement("ended");
}

#[test]
fn callback_lifetime_changed_survives_document_retirement() {
    callback_retirement("changed");
}

#[test]
fn callback_lifetime_event_survives_document_retirement() {
    callback_retirement("event");
}

#[test]
fn callback_lifetime_responsiveness_survives_document_retirement() {
    callback_retirement("responsiveness");
}
