//! WebKit 자식 수확 판정의 계약(V5-113).

use soksak_host_tauriv2::webkit_children::{reap_decision, refresh, snapshot_baseline};

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

// 기록이 없으면 갱신은 이 실행의 WebKit 자식 기록을 새로 쓰고, 그 파일은 현재 사용자만 읽고 쓴다.
// contract: webkit-children.record.owner-only
#[test]
fn the_webkit_child_record_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let config = tempfile::tempdir().unwrap();
    snapshot_baseline();
    refresh(config.path());
    let record = config.path().join("webkit-children.json");
    let mode = std::fs::metadata(&record).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "record has mode {mode:o}");
}
