// 터미널 세션이 여는 셸: 설정 값 login 은 계정의 로그인 셸이고, 셸은 로그인 셸로 시작한다.
use std::ffi::CStr;
use std::fs::OpenOptions;
use std::os::fd::AsRawFd;
use std::sync::{Mutex, OnceLock};

use soksak_sidecar_vt_core::pty::{resolve_shell, PtyService};
use soksak_sidecar_vt_core::DaemonEvent;
use tokio::time::{timeout, Duration};

// 같은 워크스페이스의 PTY 검사들과 한 번에 하나씩 실행한다.
fn native_pty_test_lock() -> std::fs::File {
    static LOCAL: OnceLock<Mutex<()>> = OnceLock::new();
    let _local = LOCAL.get_or_init(|| Mutex::new(())).lock().unwrap();
    let path = std::env::temp_dir().join("soksak-vt-core-pty-tests.lock");
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .expect("open native PTY test lock");
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    assert_eq!(result, 0, "lock native PTY tests");
    file
}

#[test]
fn login_resolves_to_the_account_login_shell() {
    let entry = unsafe { libc::getpwuid(libc::getuid()) };
    assert!(
        !entry.is_null(),
        "the test account has no user database entry"
    );
    let expected = unsafe { CStr::from_ptr((*entry).pw_shell) }
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(resolve_shell("login").unwrap(), expected);
}

#[test]
fn an_explicit_shell_must_be_an_executable_absolute_path() {
    assert_eq!(resolve_shell("/bin/sh").unwrap(), "/bin/sh");
    for invalid in ["", "sh", "bin/sh", "/nonexistent/shell", "/etc/hosts"] {
        let error = resolve_shell(invalid).unwrap_err();
        assert!(
            error.contains("terminal shell"),
            "{invalid:?} was not rejected with a terminal shell error: {error}"
        );
    }
}

#[tokio::test]
async fn a_session_shell_starts_as_a_login_shell() {
    let _lock = native_pty_test_lock();
    let service = PtyService::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (session, _) = service
        .open_shell("", "/bin/sh", None, 80, 24, tx)
        .expect("open a login shell session");
    service
        .write(&session, b"printf 'ARGV0=%s\\n' \"$0\"\n")
        .expect("write to the shell");
    let mut output = String::new();
    let found = timeout(Duration::from_secs(10), async {
        while let Some(event) = rx.recv().await {
            if let DaemonEvent::Output { data, .. } = event {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("ARGV0=-sh\r\n") {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    let _ = service.close(&session);
    assert!(found, "the shell did not report argv0 -sh: {output:?}");
}
