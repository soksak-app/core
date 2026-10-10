//! WebKit 자식 수확 판정의 계약(V5-113).

#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::webkit_children::{
    reap_decision, reap_recorded, refresh, snapshot_baseline, write_record,
};

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

// contract: webkit-children.record.concurrent-refreshes
/// 여러 창의 페이지 적재가 동시에 기록을 갱신해도 모든 갱신이 성공하고 .new 파일이 남지 않는다(F68).
#[test]
fn concurrent_webkit_record_writes_all_succeed() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let target = directory.path().join("webkit-children.json");
    let failures: Vec<String> = std::thread::scope(|scope| {
        let writers: Vec<_> = (0..32)
            .map(|index| {
                let target = &target;
                scope.spawn(move || {
                    write_record(target, format!("{{\"writer\":{index}}}").as_bytes())
                })
            })
            .collect();
        writers
            .into_iter()
            .filter_map(|writer| writer.join().expect("writer thread").err())
            .collect()
    });
    assert!(
        failures.is_empty(),
        "concurrent record writes failed: {failures:?}"
    );
    assert!(
        !directory.path().join("webkit-children.json.new").exists(),
        "a temporary record file was left behind"
    );
}

/// The texts of the error records of the place `webkit children` that a child process stores when it reaps the record of an
/// earlier run whose host and child no longer exist, with `path` as the search path of the programs.
fn ps_errors(path: &std::ffi::OsStr) -> Vec<String> {
    let config = tempfile::tempdir().unwrap();
    std::fs::write(
        config.path().join("webkit-children.json"),
        r#"{"host_pid": 2147483000, "children": [{"pid": 2147483001, "kind": "WebContent", "lstart": "x"}]}"#,
    )
    .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "a_failed_ps_query_is_reported_and_a_missing_process_is_not",
            "--nocapture",
        ])
        .env("SOKSAK_PS_CHILD", config.path())
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    records::read_events(&records::event_log_path(config.path()))
        .into_iter()
        .filter(|event| {
            event["event"] == "host.record.error" && event["fields"]["where"] == "webkit children"
        })
        .map(|event| event["fields"]["text"].as_str().unwrap().to_string())
        .collect()
}

// contract: webkit-children.ps.reports-a-failed-query
#[test]
fn a_failed_ps_query_is_reported_and_a_missing_process_is_not() {
    // The writer of the records belongs to the process, so the reap runs in a child process.
    if let Some(config) = std::env::var_os("SOKSAK_PS_CHILD") {
        let config = std::path::PathBuf::from(config);
        let writer = records::start_writer(&config);
        reap_recorded(&config);
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let real = std::env::var_os("PATH").unwrap();
    let texts = ps_errors(&real);
    assert!(
        texts.is_empty(),
        "ps answered that no process exists, and the host reported {texts:?}"
    );
    let bin = tempfile::tempdir().unwrap();
    let fake = bin.path().join("ps");
    std::fs::write(&fake, "#!/bin/sh\necho 'ps: boom' >&2\nexit 2\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    // The fake ps needs the shell, which the search path keeps through the system folders.
    let path = std::env::join_paths([
        bin.path(),
        std::path::Path::new("/bin"),
        std::path::Path::new("/usr/bin"),
    ])
    .unwrap();
    let texts = ps_errors(&path);
    assert_eq!(
        texts.len(),
        4,
        "a failing ps gave the error records {texts:?}, want one for each of the four queries of the reap"
    );
    for text in &texts {
        assert!(
            text.contains("boom") && text.contains("ps "),
            "the error record {text:?} names neither the query nor the message of ps"
        );
    }
}
