use super::*;

fn cids(prefix: &str, from: usize, to: usize) -> Vec<String> {
    (from..to).map(|n| format!("{prefix}.{n}")).collect()
}

/// A request that was answered leaves the ledger and its place in the order of the requests: the order holds at most
/// twice the bound of the pending requests however many requests were answered.
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
