use std::sync::{Mutex, OnceLock};

use soksak_sidecar_vt_core::pty::PtyService;
use soksak_sidecar_vt_core::DaemonEvent;
use tokio::time::{timeout, Duration};

fn lifecycle_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tokio::test]
async fn real_sessions_are_independent_and_close_removes_session() {
    let _test_lock = lifecycle_test_lock();
    let service = PtyService::new();
    let (tx_a, mut rx_a) = tokio::sync::mpsc::unbounded_channel();
    let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel();
    let (a, _) = service
        .open(
            "/bin/sh",
            &["-c".into(), "printf A".into()],
            None,
            80,
            24,
            tx_a,
        )
        .expect("PTY setup failed; this is an environmental test failure");
    let (b, _) = service
        .open(
            "/bin/sh",
            &["-c".into(), "printf B".into()],
            None,
            80,
            24,
            tx_b,
        )
        .expect("PTY setup failed; this is an environmental test failure");
    assert_ne!(a, b);
    let output_a = timeout(Duration::from_secs(2), async {
        loop {
            if let Some(DaemonEvent::Output { data, .. }) = rx_a.recv().await {
                break data;
            }
        }
    })
    .await
    .expect("session A output timeout");
    let output_b = timeout(Duration::from_secs(2), async {
        loop {
            if let Some(DaemonEvent::Output { data, .. }) = rx_b.recv().await {
                break data;
            }
        }
    })
    .await
    .expect("session B output timeout");
    assert!(String::from_utf8_lossy(&output_a).contains('A'));
    assert!(String::from_utf8_lossy(&output_b).contains('B'));
    service.close(&a).expect("explicit close failed");
    assert!(
        service.write(&a, b"x").is_err(),
        "closed session remained addressable"
    );
}

#[tokio::test]
async fn three_real_sessions_reconnect_with_same_pid_and_retained_output() {
    let _test_lock = lifecycle_test_lock();
    let service = PtyService::new();
    let mut sessions = Vec::new();
    for label in ["A", "B", "C"] {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (session, attachment) = service
            .open(
                "/bin/sh",
                &["-c".into(), format!("printf {label}")],
                None,
                80,
                24,
                tx,
            )
            .expect("PTY setup failed; real PTY errors must fail this test");
        let pid = service.process_id(&session).expect("missing child pid");
        let output = timeout(Duration::from_secs(2), async {
            loop {
                if let Some(DaemonEvent::Output { data, .. }) = rx.recv().await {
                    break data;
                }
            }
        })
        .await
        .expect("session output timeout");
        service
            .detach(&session, &attachment)
            .expect("detach failed");
        sessions.push((session, pid, output));
    }
    for (session, pid, output) in sessions {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let _attachment = service
            .attach(&session, 0, tx)
            .expect("reconnect attach failed");
        assert_eq!(
            service
                .process_id(&session)
                .expect("reconnected pid missing"),
            pid
        );
        let replay = timeout(Duration::from_secs(2), async {
            loop {
                if let Some(DaemonEvent::Output { data, .. }) = rx.recv().await {
                    break data;
                }
            }
        })
        .await
        .expect("replay timeout");
        assert_eq!(replay, output);
        service.close(&session).expect("close failed");
    }
}
