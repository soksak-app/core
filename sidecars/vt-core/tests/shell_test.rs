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

/// 출력이 predicate 를 만족할 때까지 모은다. 시간 안에 만족하지 않으면 그때까지의 출력과 함께 false 를 돌려준다.
async fn collect_until(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<DaemonEvent>,
    output: &mut String,
    predicate: impl Fn(&str) -> bool,
) -> bool {
    if predicate(output) {
        return true;
    }
    timeout(Duration::from_secs(10), async {
        while let Some(event) = rx.recv().await {
            if let DaemonEvent::Output { data, .. } = event {
                output.push_str(&String::from_utf8_lossy(&data));
                if predicate(output) {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

/// needle 들이 output 에서 이 순서로 나타나는지 본다.
fn in_order(output: &str, needles: &[&str]) -> bool {
    let mut rest = output;
    for needle in needles {
        match rest.find(needle) {
            Some(index) => rest = &rest[index + needle.len()..],
            None => return false,
        }
    }
    true
}

fn startup_directory(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    for (file, content) in files {
        std::fs::write(directory.join(file), content).unwrap();
    }
    directory
}

#[tokio::test]
async fn a_zsh_session_reads_the_user_startup_files_and_reports_prompt_and_command_marks() {
    let _lock = native_pty_test_lock();
    let home = startup_directory(
        "soksak-zsh-integration-test",
        &[
            (".zshenv", "export ZSHENV_READ=1\n"),
            (".zprofile", "ZPROFILE_READ=1\n"),
            (".zshrc", "ZSHRC_READ=1\nPS1='T> '\n"),
            (".zlogin", "ZLOGIN_READ=1\n"),
        ],
    );
    // 세션 환경은 명령을 만들 때의 프로세스 환경에서 온다.
    std::env::set_var("ZDOTDIR", &home);
    let service = PtyService::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let opened = service.open_shell("", "/bin/zsh", None, 80, 24, tx);
    std::env::remove_var("ZDOTDIR");
    let (session, _) = opened.expect("open a zsh session");
    let mut output = String::new();
    let prompted =
        collect_until(&mut rx, &mut output, |text| text.contains("\x1b]133;A\x07")).await;
    assert!(prompted, "zsh did not report a prompt start: {output:?}");
    output.clear();
    service
        .write(
            &session,
            b"print -r -- \"STATE=$ZDOTDIR|$ZSHENV_READ$ZPROFILE_READ$ZSHRC_READ$ZLOGIN_READ|${SOKSAK_ZSH_ZDOTDIR-unset}\"\n",
        )
        .unwrap();
    let state = format!("STATE={}|1111|unset\r\n", home.display());
    let expected = [
        "\x1b]133;C\x07",
        state.as_str(),
        "\x1b]133;D;0\x07",
        "\x1b]133;A\x07",
    ];
    let reported = collect_until(&mut rx, &mut output, |text| in_order(text, &expected)).await;
    assert!(
        reported,
        "zsh did not report {expected:?} in order: {output:?}"
    );
    output.clear();
    service.write(&session, b"false\n").unwrap();
    let failed = collect_until(&mut rx, &mut output, |text| {
        in_order(
            text,
            &["\x1b]133;C\x07", "\x1b]133;D;1\x07", "\x1b]133;A\x07"],
        )
    })
    .await;
    let _ = service.close(&session);
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        failed,
        "zsh did not report the failed command status: {output:?}"
    );
}

#[tokio::test]
async fn a_bash_session_stays_a_login_shell_keeps_the_user_prompt_command_and_reports_marks() {
    let _lock = native_pty_test_lock();
    // macOS 가 권하는 방식처럼 사용자의 PROMPT_COMMAND 를 뒤에 붙인다.
    let home = startup_directory(
        "soksak-bash-integration-test",
        &[(
            ".bash_profile",
            "export PROFILE_READ=1\nuser_hook() { USER_HOOK_RAN=1; }\nPROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND; }user_hook\"\nPS1='T> '\n",
        )],
    );
    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let service = PtyService::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let opened = service.open_shell("", "/bin/bash", None, 80, 24, tx);
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let (session, _) = opened.expect("open a bash session");
    let mut output = String::new();
    let prompted =
        collect_until(&mut rx, &mut output, |text| text.contains("\x1b]133;A\x07")).await;
    assert!(prompted, "bash did not report a prompt start: {output:?}");
    // 첫 프롬프트의 사용자 PROMPT_COMMAND 항목은 명령이 아니다.
    assert!(
        !output.contains("\x1b]133;C\x07"),
        "the first prompt reported a command start: {output:?}"
    );
    output.clear();
    service
        .write(
            &session,
            b"printf 'STATE=%s|%s|%s|%s\\n' \"$0\" \"$PROFILE_READ$USER_HOOK_RAN\" \"${SOKSAK_BASH_INTEGRATION-unset}\" \"$(env | grep -c '^PROMPT_COMMAND=')\"\n",
        )
        .unwrap();
    let expected = [
        "\x1b]133;C\x07",
        "STATE=-bash|11|unset|0\r\n",
        "\x1b]133;D;0\x07",
        "\x1b]133;A\x07",
    ];
    let reported = collect_until(&mut rx, &mut output, |text| in_order(text, &expected)).await;
    assert!(
        reported,
        "bash did not report {expected:?} in order: {output:?}"
    );
    output.clear();
    service.write(&session, b"false\n").unwrap();
    let failed = collect_until(&mut rx, &mut output, |text| {
        in_order(
            text,
            &["\x1b]133;C\x07", "\x1b]133;D;1\x07", "\x1b]133;A\x07"],
        )
    })
    .await;
    assert!(
        failed,
        "bash did not report the failed command status: {output:?}"
    );
    output.clear();
    // 트랩은 앞 명령의 마지막 인수($_)를 바꾸지 않는다.
    service.write(&session, b"true last-argument\n").unwrap();
    service
        .write(&session, b"printf 'LAST=%s\\n' \"$_\"\n")
        .unwrap();
    let kept = collect_until(&mut rx, &mut output, |text| {
        in_order(text, &["LAST=last-argument\r\n", "\x1b]133;A\x07"])
    })
    .await;
    assert!(kept, "the trap changed $_: {output:?}");
    output.clear();
    // 빈 입력 행은 명령이 아니다.
    service.write(&session, b"\n").unwrap();
    let empty = collect_until(&mut rx, &mut output, |text| text.contains("\x1b]133;A\x07")).await;
    let _ = service.close(&session);
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        empty,
        "bash did not show a prompt after an empty line: {output:?}"
    );
    assert!(
        !output.contains("\x1b]133;C\x07") && !output.contains("\x1b]133;D"),
        "an empty line reported a command: {output:?}"
    );
}

#[tokio::test]
async fn a_bash_debug_trap_from_the_startup_files_is_kept_and_no_marks_are_reported() {
    let _lock = native_pty_test_lock();
    let home = startup_directory(
        "soksak-bash-debug-trap-test",
        &[(".bash_profile", "trap 'USER_TRAP=1' DEBUG\nPS1='T> '\n")],
    );
    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let service = PtyService::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let opened = service.open_shell("", "/bin/bash", None, 80, 24, tx);
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let (session, _) = opened.expect("open a bash session");
    service
        .write(&session, b"printf 'TRAP=%s\\n' \"$(trap -p DEBUG)\"\n")
        .unwrap();
    let mut output = String::new();
    let shown = collect_until(&mut rx, &mut output, |text| {
        in_order(text, &["TRAP=trap -- 'USER_TRAP=1' DEBUG\r\n", "T> "])
    })
    .await;
    let _ = service.close(&session);
    let _ = std::fs::remove_dir_all(&home);
    assert!(shown, "the user DEBUG trap was not kept: {output:?}");
    assert!(
        !output.contains("\x1b]133;"),
        "bash reported marks without a command start: {output:?}"
    );
}

#[tokio::test]
async fn a_resize_during_bash_startup_does_not_report_a_command_at_the_first_prompt() {
    let _lock = native_pty_test_lock();
    let home = startup_directory(
        "soksak-bash-startup-resize-test",
        &[(".bash_profile", "PS1='T> '\n")],
    );
    let original_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    let service = PtyService::new();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let opened = service.open_shell("", "/bin/bash", None, 80, 24, tx);
    match original_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let (session, _) = opened.expect("open a bash session");
    // 앱은 세션을 연 직후 표면 크기를 보낸다. 셸이 시작 파일을 읽는 동안 SIGWINCH 가 온다.
    service.resize(&session, 79, 24).unwrap();
    service.resize(&session, 80, 24).unwrap();
    let mut output = String::new();
    let prompted = collect_until(&mut rx, &mut output, |text| {
        in_order(text, &["\x1b]133;A\x07", "T> "])
    })
    .await;
    let _ = service.close(&session);
    let _ = std::fs::remove_dir_all(&home);
    assert!(prompted, "bash did not show its first prompt: {output:?}");
    assert!(
        !output.contains("\x1b]133;C\x07"),
        "the first prompt reported a command start: {output:?}"
    );
}
