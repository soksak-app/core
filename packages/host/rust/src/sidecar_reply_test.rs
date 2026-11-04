use super::*;
use crate::event_record::buffered_fields;

fn cids(prefix: &str, from: usize, to: usize) -> Vec<String> {
    (from..to).map(|n| format!("{prefix}.{n}")).collect()
}

/// A request that was answered leaves the ledger and its place in the order of the requests: the order holds at most
/// twice the bound of the pending requests however many requests were answered.
// contract: buffers.sidecar-replies.order-is-bounded
#[test]
fn answered_requests_do_not_grow_the_order_of_the_ledger() {
    let mut ledger = RequestLedger::default();
    for n in 0..5 * PENDING_REQUEST_LIMIT {
        let cid = vec![format!("p.{n}")];
        ledger.add("sidecar-a", "tab-1", &cid, n as u64 + 1);
        assert!(ledger.take(&cid, n as u64 + 2).is_some());
    }
    assert!(
        ledger.order_len() <= 2 * PENDING_REQUEST_LIMIT,
        "the order of the ledger holds {} identifiers after all requests were answered",
        ledger.order_len()
    );
}

/// A request that is forgotten at the bound is counted, so the loss of its microseconds is not silent.
// contract: buffers.sidecar-replies.forgotten-request-is-counted
#[test]
fn forgetting_a_request_at_the_bound_is_counted() {
    let mut ledger = RequestLedger::default();
    assert_eq!(
        ledger.add(
            "sidecar-a",
            "tab-1",
            &cids("p", 0, PENDING_REQUEST_LIMIT),
            1
        ),
        0
    );
    assert_eq!(ledger.add("sidecar-a", "tab-1", &cids("q", 0, 5), 2), 5);
    assert!(ledger.take(&["p.0".to_string()], 3).is_none());
}

// contract: sidecars.stop.records-open-requests
// A request that waits for a reply when the host stops its sidecar gets a host.sidecar.reply error that names its surface, its sidecar
// and its identifiers.
#[test]
fn an_open_request_at_a_host_stop_gets_an_error_record() {
    let mut ledger = RequestLedger::default();
    ledger.add("probe-sidecar", "probe-surface", &["req-1".to_string()], 1);
    record_stopped_requests("probe-sidecar", ledger.failed("probe-sidecar"));
    let written: Vec<_> = buffered_fields("host.sidecar.reply")
        .into_iter()
        .filter(|fields| fields["name"] == "probe-sidecar")
        .collect();
    assert_eq!(
        written.len(),
        1,
        "one error record is written for the open request"
    );
    assert_eq!(written[0]["surface"], "probe-surface");
    assert_eq!(written[0]["ok"], false);
}

// The error text of a failed request that is longer than the bound of the event is cut, and the record says so with truncated: true.
// contract: sidecars.reply.error-text-cut-is-marked
#[test]
fn a_sidecar_error_text_cut_at_the_bound_is_marked() {
    let long = "x".repeat(2 * crate::bounds::CALL_TEXT_BYTES);
    crate::sidecars::record_request_failures(
        "cut-probe-sidecar",
        &long,
        vec![("probe-surface".to_string(), vec!["req-1".to_string()])],
    );
    let written: Vec<_> = buffered_fields("host.sidecar.reply")
        .into_iter()
        .filter(|fields| fields["name"] == "cut-probe-sidecar")
        .collect();
    assert_eq!(
        written.len(),
        1,
        "one record is written for the cut failure"
    );
    assert_eq!(written[0]["truncated"], true);
}
