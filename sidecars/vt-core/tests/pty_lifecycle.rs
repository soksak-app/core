use std::fs::OpenOptions;
use std::os::fd::AsRawFd;
use std::sync::{Mutex, OnceLock};

use soksak_sidecar_vt_core::pty::PtyService;
use soksak_sidecar_vt_core::DaemonEvent;
use tokio::time::{timeout, Duration};

fn lifecycle_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn native_pty_test_lock() -> std::fs::File {
    let path = std::env::temp_dir().join("soksak-vt-core-pty-tests.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
        .expect("PTY test lock file must open");
    nix::fcntl::flock(file.as_raw_fd(), nix::fcntl::FlockArg::LockExclusive)
        .expect("PTY test lock must acquire");
    file
}

#[tokio::test]
async fn real_sessions_are_independent_and_close_removes_session() {
    let _test_lock = lifecycle_test_lock();
    let _native_test_lock = native_pty_test_lock();
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
async fn repeated_short_lived_sessions_close_without_process_group_races() {
    let _test_lock = lifecycle_test_lock();
    let _native_test_lock = native_pty_test_lock();
    let started = std::time::Instant::now();
    let service = PtyService::new();
    for index in 0..20 {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (session, _) = service
            .open(
                "/bin/sh",
                &["-c".into(), format!("printf short-{index}")],
                None,
                80,
                24,
                tx,
            )
            .expect("short-lived PTY setup failed");
        service
            .close(&session)
            .expect("short-lived PTY close failed");
    }
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "short-lived PTY setup loop exceeded its three-second bound: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn three_real_sessions_reconnect_with_same_pid_and_retained_output() {
    let _test_lock = lifecycle_test_lock();
    let _native_test_lock = native_pty_test_lock();
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

/// macOS answers EPERM to a signal for a process group whose members are all zombies.
/// Such a group has nothing left to terminate, so closing it succeeds.
#[test]
fn a_process_group_of_only_zombies_is_already_terminated() {
    use std::os::unix::process::CommandExt;
    let _test_lock = lifecycle_test_lock();
    let _native_test_lock = native_pty_test_lock();
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .process_group(0)
        .spawn()
        .expect("the shell must start");
    let group = child.id() as i32;
    // 종료를 기다리되 회수하지 않아 그룹에 좀비 하나만 남긴다.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let waited = unsafe {
        libc::waitid(
            libc::P_PID,
            group as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT,
        )
    };
    assert_eq!(
        waited,
        0,
        "waitid failed: {}",
        std::io::Error::last_os_error()
    );
    assert_eq!(
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(-group),
            nix::sys::signal::Signal::SIGKILL
        ),
        Err(nix::errno::Errno::EPERM),
        "the operating system answers a zombie-only group with EPERM"
    );
    let result = soksak_sidecar_vt_core::platform::pty::kill_process_group(Some(group));
    child.wait().expect("the shell must be reaped");
    assert_eq!(result, Ok(()));
}

#[test]
fn process_group_members_report_running_and_ended_processes() {
    use soksak_sidecar_vt_core::platform::darwin::process_group::{members, Member};
    use std::os::unix::process::CommandExt;
    let _test_lock = lifecycle_test_lock();
    let _native_test_lock = native_pty_test_lock();
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .expect("sleep must start");
    let group = child.id() as i32;
    assert_eq!(
        members(group),
        Ok(vec![Member {
            pid: group,
            zombie: false
        }])
    );
    child.kill().expect("sleep must end");
    // 종료를 기다리되 회수하지 않는다. 끝난 프로세스는 좀비로 보고된다.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let waited = unsafe {
        libc::waitid(
            libc::P_PID,
            group as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT,
        )
    };
    assert_eq!(
        waited,
        0,
        "waitid failed: {}",
        std::io::Error::last_os_error()
    );
    assert_eq!(
        members(group),
        Ok(vec![Member {
            pid: group,
            zombie: true
        }])
    );
    child.wait().expect("sleep must be reaped");
    assert_eq!(members(group), Ok(vec![]));
}
