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
