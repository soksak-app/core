//! WebKit 자식 수확 판정의 계약(V5-113).

use soksak_host_tauriv2::webkit_children::reap_decision;

// contract: webkit-children.reap.requires-alive-webkit-same-start
#[test]
fn a_reap_decision_kills_only_the_proven_orphan() {
    assert!(reap_decision(true, true, true).is_ok());
}

// contract: webkit-children.reap.requires-alive-webkit-same-start
#[test]
fn a_dead_child_has_nothing_to_reap() {
    assert_eq!(
        reap_decision(false, true, true),
        Err("already dead; nothing to reap")
    );
}

// contract: webkit-children.reap.requires-alive-webkit-same-start
#[test]
fn a_recycled_pid_is_never_killed() {
    assert_eq!(
        reap_decision(true, false, true),
        Err("no longer a WebKit process (recycled?); not killing")
    );
}

// contract: webkit-children.reap.requires-alive-webkit-same-start
#[test]
fn a_same_pid_different_instance_is_never_killed() {
    assert_eq!(
        reap_decision(true, true, false),
        Err("start time differs from the record; not killing")
    );
}
