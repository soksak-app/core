//! The WebContent processes without a page of `host.window`: the native rows pass through unchanged, a platform that does not
//! report them gives null, and rows of another shape are refused. The same cases run in the Go host.
use super::*;

// contract: window.facts.pageless-processes
#[test]
fn host_window_reports_the_processes_without_a_page() {
    let rows = json!([{"pid": 4101, "ending": true}, {"pid": 4102, "ending": false}]);
    let facts = json!({"pagelessProcesses": rows});
    assert_eq!(window_pageless_processes(&facts).unwrap(), rows);
    assert_eq!(
        window_pageless_processes(&json!({"pagelessProcesses": []})).unwrap(),
        json!([])
    );
    assert_eq!(window_pageless_processes(&json!({})).unwrap(), Value::Null);
    for invalid in [
        json!({"pagelessProcesses": {}}),
        json!({"pagelessProcesses": [{"pid": 0, "ending": true}]}),
        json!({"pagelessProcesses": [{"pid": 4101}]}),
        json!({"pagelessProcesses": [{"pid": "4101", "ending": true}]}),
    ] {
        assert!(
            window_pageless_processes(&invalid).is_err(),
            "{invalid} was accepted"
        );
    }
}
