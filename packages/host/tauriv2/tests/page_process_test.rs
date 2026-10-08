//! The end of a WebContent process is an error line (docs/spec/diagnostics.md).

use soksak_host_tauriv2::application_log::error_line;
use soksak_host_tauriv2::page_process::page_process_ended;

// contract: page.process.termination-writes-an-error-line
#[test]
fn the_page_process_end_is_an_error_line() {
    let (place, text) = page_process_ended("main", false).unwrap();
    assert_eq!(
        error_line(&place, text),
        "error: page process: main: terminated"
    );
    // The host ends the process on purpose while it quits.
    assert_eq!(page_process_ended("main", true), None);
}
