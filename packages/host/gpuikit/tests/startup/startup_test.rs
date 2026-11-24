//! Tests of the setup results that the GPUI host receives after exit_on_failure returned them.

// contract: gpuikit.startup.setup-failure-is-a-startup-error
#[test]
fn a_setup_failure_returned_after_its_exit_is_recorded_as_a_startup_error() {
    let text = "startup test: the endpoint cannot start";
    super::report_setup(Err(Box::<dyn std::error::Error>::from(text)));
    let recorded = soksak_host::event_record::buffered_host_error_texts("startup");
    assert!(
        recorded.iter().any(|record| record == text),
        "the recorded startup errors are {recorded:?}"
    );
}
