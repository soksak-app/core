// 데몬 클라이언트 통합 테스트
// 테스트가 ptyd 데몬을 빌드하고, 실제 통신을 검증한다.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Child};
use std::time::{Duration, Instant};
use std::thread;
use soksak_sidecar_vt_core::daemon::{DaemonClient, DaemonIdentity, DaemonRequest};
use soksak_sidecar_vt_core::platform::DarwinDaemonFinder;
use soksak_sidecar_vt_core::daemon::DaemonFinder;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// 테스트용 데몬을 시작하고 정리하는 헬퍼
struct TestDaemonHandle {
    #[allow(dead_code)]
    temp_dir: tempfile::TempDir,
    _daemon_process: Option<Child>,
    socket_path: String,
}

/// 데몬은 소켓 디렉터리에 0700 을 요구한다. umask 를 거치지 않도록 mode 를 지정해 만든다.
fn create_socket_dir(dir: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

impl TestDaemonHandle {
    fn start() -> Result<Self, Box<dyn std::error::Error>> {
        // 임시 디렉터리 생성
        let temp_dir = tempfile::TempDir::new()?;
        let socket_dir = temp_dir.path().join("sockets");

        create_socket_dir(&socket_dir)?;

        // ptyd 빌드 (저장소 루트에서)
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .ok_or("Cannot find repo root")?
            .parent()
            .ok_or("Cannot find repo root")?
            .to_path_buf();

        let ptyd_main = repo_root.join("sidecars/ptyd/src/main.go");
        if !ptyd_main.exists() {
            return Err("ptyd source not found".into());
        }

        let exe_dir = temp_dir.path().join("exes");
        fs::create_dir(&exe_dir)?;

        let daemon_exe = exe_dir.join("soksak-ptyd");
        let build_output = Command::new("go")
            .args(&["build", "-o", daemon_exe.to_str().unwrap()])
            .arg("./sidecars/ptyd/src")
            .current_dir(&repo_root)
            .output()?;

        if !build_output.status.success() {
            let stderr = String::from_utf8_lossy(&build_output.stderr);
            let stdout = String::from_utf8_lossy(&build_output.stdout);
            return Err(format!(
                "Failed to build ptyd: stdout={}, stderr={}",
                stdout, stderr
            ).into());
        }

        // DarwinDaemonFinder를 사용해 데몬 시작
        let finder = DarwinDaemonFinder::with_dirs(exe_dir, socket_dir);
        let identity = DaemonIdentity {
            protocol: "ptyd".to_string(),
            build_kind: "debug".to_string(),
        };

        let socket_path = finder.find_or_start(&identity)
            .map_err(|e| format!("Failed to start daemon: {}", e))?;

        Ok(TestDaemonHandle {
            temp_dir,
            _daemon_process: None,
            socket_path,
        })
    }

    fn socket_path(&self) -> &str {
        &self.socket_path
    }
}

impl Drop for TestDaemonHandle {
    fn drop(&mut self) {
        if let Some(mut daemon) = self._daemon_process.take() {
            let _ = daemon.kill();
            let _ = daemon.wait();
        }
    }
}

/// 데몬 리더에서 출력 메시지를 읽는 헬퍼 (다른 메시지는 건너뜀)
async fn read_output_message(
    reader: &mut soksak_sidecar_vt_core::daemon::DaemonReader,
) -> Result<Option<String>, String> {
    loop {
        match reader.read_message().await {
            Ok(Some(msg)) => {
                match msg {
                    soksak_sidecar_vt_core::daemon::DaemonMessage::Output { output, .. } => {
                        return Ok(Some(output));
                    }
                    soksak_sidecar_vt_core::daemon::DaemonMessage::Resized { .. }
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Open(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Attach(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Detach(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Write(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Resize(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Signal(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Close(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::List(_)
                    | soksak_sidecar_vt_core::daemon::DaemonMessage::Purge(_) => {
                        // Skip these messages and read next
                        continue;
                    }
                    soksak_sidecar_vt_core::daemon::DaemonMessage::Exit { .. } => {
                        // End of stream
                        return Ok(None);
                    }
                }
            }
            Ok(None) => {
                // EOF
                return Ok(None);
            }
            Err(e) => {
                return Err(format!("Failed to read message: {}", e));
            }
        }
    }
}

/// 테스트 1: echo hi 출력 검증
#[tokio::test]
async fn test_daemon_open_echo_output() {
    let daemon = TestDaemonHandle::start()
        .expect("Failed to start test daemon");

    let mut client = DaemonClient::connect(daemon.socket_path())
        .await
        .expect("Failed to connect to daemon");

    // open 요청
    let req = DaemonRequest {
        command: "open".to_string(),
        program: Some("/bin/sh".to_string()),
        args: Some(vec!["-c".to_string(), "echo hi".to_string()]),
        cols: Some(80),
        rows: Some(24),
        hint: None,
        env: None,
        cwd: None,
        session_id: None,
        data: None,
        from: None,
    };

    client.send_request(&req)
        .await
        .expect("Failed to send open request");

    // open 응답에서 sessionId 추출
    let msg = tokio::time::timeout(
        Duration::from_secs(5),
        client.read_message()
    )
        .await
        .expect("Read timeout")
        .expect("Failed to read open response")
        .expect("Expected response");

    let _session_id = match msg {
        soksak_sidecar_vt_core::daemon::DaemonMessage::Open(reply) => {
            reply.session_id.expect("No sessionId in response")
        }
        _ => panic!("Expected open response"),
    };

    // Split for reading messages with different types
    let (_writer, mut reader) = client.into_split();

    // 출력 읽기 (최대 5초, 반복)
    let start = Instant::now();
    let mut found_hi = false;

    while start.elapsed() < Duration::from_secs(5) {
        match tokio::time::timeout(
            Duration::from_millis(500),
            read_output_message(&mut reader)
        )
            .await
        {
            Ok(Ok(Some(output))) => {
                // base64 디코딩 시도
                if let Ok(decoded) = STANDARD.decode(&output) {
                    let text = String::from_utf8_lossy(&decoded);
                    if text.contains("hi") {
                        found_hi = true;
                        break;
                    }
                }
                // 평문 체크
                if output.contains("hi") {
                    found_hi = true;
                    break;
                }
            }
            Ok(Ok(None)) => {
                // EOF or no more output
                break;
            }
            Ok(Err(e)) => {
                panic!("Failed to read message: {}", e);
            }
            Err(_) => {
                continue;
            }
        }
    }
    assert!(found_hi, "Did not find 'hi' output from daemon");
}

/// 테스트 2: input 왕복 검증 (cat)
#[tokio::test]
async fn test_daemon_input_roundtrip() {
    let daemon = TestDaemonHandle::start()
        .expect("Failed to start test daemon");

    let mut client = DaemonClient::connect(daemon.socket_path())
        .await
        .expect("Failed to connect to daemon");

    // cat 시작
    let req = DaemonRequest {
        command: "open".to_string(),
        program: Some("cat".to_string()),
        cols: Some(80),
        rows: Some(24),
        hint: None,
        args: None,
        env: None,
        cwd: None,
        session_id: None,
        data: None,
        from: None,
    };

    client.send_request(&req)
        .await
        .expect("Failed to send open request");

    // open 응답 읽기 (sessionId 얻기)
    let msg = tokio::time::timeout(
        Duration::from_secs(5),
        client.read_message()
    )
        .await
        .expect("Read timeout")
        .expect("Failed to read open response")
        .expect("Expected response");

    let session_id = match msg {
        soksak_sidecar_vt_core::daemon::DaemonMessage::Open(reply) => {
            reply.session_id.expect("No sessionId in response")
        }
        _ => panic!("Expected open response"),
    };

    // input 보내기 (test in base64)
    let input_req = DaemonRequest {
        command: "write".to_string(),
        data: Some("dGVzdA==".to_string()), // "test" base64
        hint: None,
        program: None,
        args: None,
        env: None,
        cwd: None,
        cols: None,
        rows: None,
        session_id: Some(session_id),
        from: None,
    };

    client.send_request(&input_req)
        .await
        .expect("Failed to send write request");

    // Split for reading messages with different types
    let (_writer, mut reader) = client.into_split();

    // 에코 응답 기다림 (최대 5초, 누적 바이트로 확인)
    let start = Instant::now();
    let mut found_echo = false;
    let mut accumulated = Vec::new();

    while start.elapsed() < Duration::from_secs(5) {
        let remaining = Duration::from_secs(5).saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }

        match tokio::time::timeout(
            remaining,
            read_output_message(&mut reader)
        )
            .await
        {
            Ok(Ok(Some(output))) => {
                // base64 디코딩 시도
                if let Ok(decoded) = STANDARD.decode(&output) {
                    accumulated.extend_from_slice(&decoded);
                    let accumulated_str = String::from_utf8_lossy(&accumulated);
                    if accumulated_str.contains("test") {
                        found_echo = true;
                        break;
                    }
                }
            }
            Ok(Ok(None)) => {
                // 연결 종료 또는 no output message
                continue;
            }
            Ok(Err(e)) => {
                panic!("Failed to read message: {}", e);
            }
            Err(_) => {
                // 타임아웃
                break;
            }
        }
    }

    assert!(found_echo, "input roundtrip failed - did not get echo containing 'test'");
}

/// 테스트 3: 재접속 후 상태 복원
#[tokio::test]
async fn test_daemon_reconnect_restore_state() {
    let daemon = TestDaemonHandle::start()
        .expect("Failed to start test daemon");

    // 첫 번째 연결: echo hi 실행
    let (session_id, _first_accumulated) = {
        let mut client = DaemonClient::connect(daemon.socket_path())
            .await
            .expect("Failed to connect to daemon (first connection)");

        let req = DaemonRequest {
            command: "open".to_string(),
            program: Some("/bin/sh".to_string()),
            args: Some(vec!["-c".to_string(), "echo hi; exec cat".to_string()]),
            cols: Some(80),
            rows: Some(24),
            hint: None,
            env: None,
            cwd: None,
            session_id: None,
            data: None,
            from: None,
        };

        client.send_request(&req)
            .await
            .expect("Failed to send open request");

        // open 응답에서 sessionId 확인
        let msg = tokio::time::timeout(
            Duration::from_secs(5),
            client.read_message()
        )
            .await
            .expect("Read timeout (open response)")
            .expect("Failed to read open response")
            .expect("Expected open response");

        let session_id = match msg {
            soksak_sidecar_vt_core::daemon::DaemonMessage::Open(reply) => {
                reply.session_id.expect("No sessionId in open response")
            }
            _ => panic!("Expected open response"),
        };

        // Split for reading messages with different types
        let (_writer, mut reader) = client.into_split();

        // 출력 읽기 및 저장 (누적 바이트)
        let start = Instant::now();
        let mut accumulated = Vec::new();
        let mut found_hi = false;

        while start.elapsed() < Duration::from_secs(5) {
            let remaining = Duration::from_secs(5).saturating_sub(start.elapsed());
            if remaining.is_zero() {
                break;
            }

            match tokio::time::timeout(
                remaining,
                read_output_message(&mut reader)
            )
                .await
            {
                Ok(Ok(Some(output))) => {
                    // base64 디코딩
                    if let Ok(decoded) = STANDARD.decode(&output) {
                        accumulated.extend_from_slice(&decoded);
                        let accumulated_str = String::from_utf8_lossy(&accumulated);
                        if accumulated_str.contains("hi") {
                            found_hi = true;
                            break;
                        }
                    }
                }
                Ok(Ok(None)) => {
                    // No output message this time
                    continue;
                }
                Ok(Err(e)) => {
                    panic!("Failed to read message: {}", e);
                }
                Err(_) => {
                    continue;
                }
            }
        }

        assert!(found_hi, "Failed to get 'hi' from first output");

        (session_id, accumulated)
    };

    // 두 번째 연결: attach로 상태 복원
    {
        let mut client = DaemonClient::connect(daemon.socket_path())
            .await
            .expect("Failed to connect to daemon (second connection)");

        let req = DaemonRequest {
            command: "attach".to_string(),
            session_id: Some(session_id),
            from: Some(0),
            hint: None,
            program: None,
            args: None,
            env: None,
            cwd: None,
            cols: None,
            rows: None,
            data: None,
        };

        client.send_request(&req)
            .await
            .expect("Failed to send attach request");

        // attach 응답 읽기
        let attach_msg = tokio::time::timeout(
            Duration::from_secs(5),
            client.read_message()
        )
            .await
            .expect("Read timeout (attach response)")
            .expect("Failed to read attach response")
            .expect("Expected attach response");

        // attach response should not have an error
        match attach_msg {
            soksak_sidecar_vt_core::daemon::DaemonMessage::Attach(reply) => {
                assert!(reply.error.is_none(), "attach response has error: {:?}", reply.error);
            }
            _ => panic!("Expected attach response"),
        }

        // Split for reading messages with different types
        let (_writer, mut reader) = client.into_split();

        // 이전 출력과 같은 내용이 나오는지 확인 (누적 바이트로 확인)
        let start = Instant::now();
        let mut restored_accumulated = Vec::new();
        let mut found_restored = false;

        while start.elapsed() < Duration::from_secs(5) {
            let remaining = Duration::from_secs(5).saturating_sub(start.elapsed());
            if remaining.is_zero() {
                break;
            }

            match tokio::time::timeout(
                remaining,
                read_output_message(&mut reader)
            )
                .await
            {
                Ok(Ok(Some(output))) => {
                    // base64 디코딩
                    if let Ok(decoded) = STANDARD.decode(&output) {
                        restored_accumulated.extend_from_slice(&decoded);
                        let restored_str = String::from_utf8_lossy(&restored_accumulated);
                        if restored_str.contains("hi") {
                            found_restored = true;
                            break;
                        }
                    }
                }
                Ok(Ok(None)) => {
                    // No output message this time
                    continue;
                }
                Ok(Err(e)) => {
                    panic!("Failed to read message: {}", e);
                }
                Err(_) => {
                    continue;
                }
            }
        }

        assert!(found_restored, "State not restored after reconnection - 'hi' not found");
    }
}

/// 테스트 4: DarwinDaemonFinder로 데몬 찾기/띄우기
#[tokio::test]
async fn test_daemon_finder_start_and_connect() {
    // 임시 디렉터리 생성
    let temp_dir = tempfile::TempDir::new()
        .expect("Failed to create temp directory");
    let socket_dir = temp_dir.path().join("sockets");

    create_socket_dir(&socket_dir).expect("Failed to create socket directory with 0700 permissions");

    let exe_dir = temp_dir.path().join("exes");
    fs::create_dir(&exe_dir)
        .expect("Failed to create exe directory");

    // ptyd 빌드
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .expect("Cannot find parent")
        .parent()
        .expect("Cannot find grandparent")
        .to_path_buf();

    let daemon_exe = exe_dir.join("soksak-ptyd");
    let build_output = Command::new("go")
        .args(&["build", "-o", daemon_exe.to_str().unwrap()])
        .arg("./sidecars/ptyd/src")
        .current_dir(&repo_root)
        .output()
        .expect("Failed to execute go build");

    assert!(build_output.status.success(),
        "Failed to build ptyd: {}",
        String::from_utf8_lossy(&build_output.stderr));

    // DarwinDaemonFinder 생성 (with_dirs로 exe_dir과 socket_dir 지정)
    let socket_dir_check = socket_dir.clone();
    let finder = DarwinDaemonFinder::with_dirs(exe_dir, socket_dir);

    // find_or_start 호출
    let identity = DaemonIdentity {
        protocol: "ptyd".to_string(),
        build_kind: "debug".to_string(),
    };

    let socket_path = finder.find_or_start(&identity)
        .expect("Failed to find or start daemon");

    // 주입한 소켓 디렉터리 안에, 이 신원의 이름 규칙을 따르는 소켓이어야 한다.
    // ("soksak" 은 기본 경로($TMPDIR/soksak)에만 나타나므로 주입한 경우에는 판정 기준이 아니다.)
    assert!(socket_path.starts_with(socket_dir_check.to_str().unwrap()),
        "Socket {socket_path} is not inside the injected directory");
    let name = std::path::Path::new(&socket_path).file_name().unwrap().to_string_lossy().to_string();
    assert!(name.starts_with("ptyd-ptyd-debug-") && name.ends_with(".sock"),
        "Socket name {name} does not follow the identity naming rule");

    // DaemonClient로 연결 확인
    let mut client = DaemonClient::connect(&socket_path)
        .await
        .expect("Failed to connect to daemon via finder");

    // 간단한 요청/응답으로 데몬 동작 확인
    let req = DaemonRequest {
        command: "open".to_string(),
        program: Some("/bin/echo".to_string()), // macOS 에 /bin/true 는 없다
        cols: Some(80),
        rows: Some(24),
        hint: None,
        args: None,
        env: None,
        cwd: None,
        session_id: None,
        data: None,
        from: None,
    };

    client.send_request(&req)
        .await
        .expect("Failed to send request to daemon");

    let msg = tokio::time::timeout(
        Duration::from_secs(5),
        client.read_message()
    )
        .await
        .expect("Read timeout")
        .expect("Failed to read response from daemon")
        .expect("Expected response from daemon");

    let session_id = match msg {
        soksak_sidecar_vt_core::daemon::DaemonMessage::Open(reply) => {
            reply.session_id
        }
        _ => panic!("Expected open response"),
    };

    assert!(session_id.is_some(),
        "No sessionId in response from finder-started daemon");
}
