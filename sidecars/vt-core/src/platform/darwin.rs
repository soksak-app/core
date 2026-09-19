pub mod frame;

use crate::daemon::{DaemonFinder, DaemonIdentity};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::fs;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, DirBuilderExt};
use nix::fcntl::{flock, FlockArg};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use std::io::Read;

pub struct DarwinDaemonFinder {
    // 실행 파일의 디렉터리
    exe_dir: PathBuf,
    // 테스트용 socket 디렉터리
    socket_dir: Option<PathBuf>,
}

impl DarwinDaemonFinder {
    pub fn new() -> Self {
        let exe_path = std::env::current_exe()
            .unwrap_or_else(|_| PathBuf::from("./soksak"));
        let exe_dir = exe_path.parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();

        Self { exe_dir, socket_dir: None }
    }

    /// 테스트용: 실행 파일 디렉터리 지정
    pub fn with_exe_dir(exe_dir: PathBuf) -> Self {
        Self { exe_dir, socket_dir: None }
    }

    /// 테스트용: 실행 파일과 소켓 디렉터리 지정
    pub fn with_dirs(exe_dir: PathBuf, socket_dir: PathBuf) -> Self {
        Self { exe_dir, socket_dir: Some(socket_dir) }
    }
}

impl DaemonFinder for DarwinDaemonFinder {
    fn find_or_start(&self, identity: &DaemonIdentity) -> Result<String, String> {
        let socket_dir = if let Some(ref socket_dir) = self.socket_dir {
            socket_dir.clone()
        } else {
            get_socket_dir()?
        };

        // 현재 신원의 소켓을 찾아본다
        if let Ok(socket_path) = find_connected_socket(&socket_dir, identity) {
            return Ok(socket_path);
        }

        // 소켓이 없으면 데몬을 띄운다
        start_daemon(&self.exe_dir, identity, &socket_dir)
    }
}

/// `$TMPDIR/soksak/` 디렉터리 경로를 얻는다
fn get_socket_dir() -> Result<PathBuf, String> {
    let tmpdir = std::env::var("TMPDIR")
        .unwrap_or_else(|_| "/tmp".to_string());
    let socket_dir = PathBuf::from(tmpdir).join("soksak");

    // 디렉터리가 없으면 0700으로 생성
    if !socket_dir.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&socket_dir)
            .map_err(|e| format!("Failed to create socket directory with 0700: {}", e))?;
    }

    // 권한 확인 (0700) - 권한 부분만 추출해서 비교 (디렉터리 비트 무시)
    let metadata = fs::metadata(&socket_dir)
        .map_err(|e| format!("Failed to stat socket directory: {}", e))?;

    let perms = metadata.permissions().mode() & 0o777;
    if perms != 0o700 {
        return Err(format!("Socket directory has mode {:o}, want 700", perms));
    }

    Ok(socket_dir)
}

/// 같은 신원의 소켓 중 연결 가능한 것을 찾는다
fn find_connected_socket(socket_dir: &Path, identity: &DaemonIdentity) -> Result<String, String> {
    let prefix = format!("ptyd-{}-{}-", identity.protocol, identity.build_kind);

    let entries = fs::read_dir(socket_dir)
        .map_err(|e| format!("Failed to read socket directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        if !name.starts_with(&prefix) || !name.ends_with(".sock") {
            continue;
        }

        // 소켓 경로 문자열 길이 확인
        let socket_path_str = path.to_string_lossy().to_string();
        if socket_path_str.len() > 104 {
            continue; // Unix 소켓 경로는 104 바이트 제한
        }

        // 연결 시도
        match UnixStream::connect(&path) {
            Ok(_) => {
                return Ok(socket_path_str);
            }
            Err(_) => {
                // 죽은 소켓은 건드리지 않는다
                continue;
            }
        }
    }

    Err("No connected daemon socket found".to_string())
}

/// 데몬을 띄운다
fn start_daemon(exe_dir: &Path, identity: &DaemonIdentity, socket_dir: &Path) -> Result<String, String> {
    // 기동을 직렬화하는 잠금. 데몬이 listener 를 만들 때 쓰는 `ptyd-<신원>.lock` 과 **다른 파일**이어야 한다.
    // 같은 파일을 쓰면, 잠금을 쥔 채 소켓이 생기기를 기다리는 이쪽과 그 잠금을 기다리는 데몬이 서로를 막는다.
    let lock_path = socket_dir.join(format!("ptyd-{}-{}.start.lock", identity.protocol, identity.build_kind));

    // 잠금 파일 열기
    let lock_file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .mode(0o600)
        .open(&lock_path)
        .map_err(|e| format!("Failed to open lock file: {}", e))?;

    let fd = lock_file.as_raw_fd();

    // flock(LOCK_EX) 로 잠금
    flock(fd, FlockArg::LockExclusive)
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;

    let result = {
        // 잠금을 얻은 후 소켓을 다시 확인
        if let Ok(socket_path) = find_connected_socket(socket_dir, identity) {
            Ok(socket_path)
        } else {
            // 그래도 없으면 데몬 시작
            start_daemon_process(exe_dir, identity, socket_dir)
        }
    };

    // 잠금 해제 - 오류는 결과에 병합
    match flock(fd, FlockArg::Unlock) {
        Ok(_) => {},
        Err(unlock_err) => {
            // 잠금 해제 실패는 반환 결과에 병합 (삼키지 않음)
            match result {
                Ok(socket_path) => {
                    return Err(format!("Lock unlock failed (flock): {} (but daemon started at {})", unlock_err, socket_path));
                }
                Err(e) => {
                    return Err(format!("Daemon startup failed and lock unlock also failed: {} (flock: {})", e, unlock_err));
                }
            }
        }
    }

    result
}

/// 실제로 데몬 프로세스를 시작한다.
/// Daemon이 먼저 socket을 listen하고, stdout에 "ready <socket-path>"를 쓴 후,
/// setsid와 detach를 해서 데몬이 된다.
fn start_daemon_process(exe_dir: &Path, identity: &DaemonIdentity, socket_dir: &Path) -> Result<String, String> {
    let daemon_exe = exe_dir.join("soksak-ptyd");

    if !daemon_exe.exists() {
        return Err("Daemon executable not found".to_string());
    }

    let mut child = Command::new(&daemon_exe)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .env("PTYD_PROTOCOL", identity.protocol.clone())
        .env("SOKSAK_PROFILE", identity.build_kind.clone())
        .env("PTYD_SOCKET_DIR", socket_dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    // 채널을 통해 ready line을 받을 때까지 기다린다.
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    let stdout_thread = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        if let Some(Ok(line)) = lines.next() {
            let _ = tx.send(Ok(line));
        }
    });

    // 최대 5초 대기
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(line)) => {
            if line.starts_with("ready ") {
                let socket_path = line[6..].to_string();

                // 자식 프로세스는 daemon이 되었으므로 wait하지 않는다.
                // (daemon이 setsid를 호출했으므로 부모-자식 관계가 유지되지만,
                //  daemon 프로세스가 부모 프로세스와 무관하게 동작한다.
                //  PID 1이 아닌 경우 좀비가 될 수 있지만, 데몬은 직접 wait하지 않고
                //  부모 프로세스가 종료되거나 SIGCHLD를 처리할 때까지 대기한다.)
                drop(child);
                let _ = stdout_thread.join();

                return Ok(socket_path);
            } else {
                // 다른 줄이 반환됨 - stderr을 모두 읽어서 오류로 반환
                let mut stderr_content = String::new();
                if let Ok(_) = std::io::BufReader::new(stderr).read_to_string(&mut stderr_content) {
                    if !stderr_content.is_empty() {
                        return Err(format!("Daemon startup failed: {}", stderr_content));
                    }
                }
                return Err(format!("Daemon startup failed: expected 'ready' but got '{}'", line));
            }
        }
        Ok(Err(e)) => {
            let _ = stdout_thread.join();
            // EOF - stderr 읽기
            let mut stderr_content = String::new();
            if let Ok(_) = std::io::BufReader::new(stderr).read_to_string(&mut stderr_content) {
                if !stderr_content.is_empty() {
                    return Err(format!("Daemon startup failed: {}", stderr_content));
                }
            }
            return Err(format!("Daemon startup failed: EOF - {}", e));
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // 타임아웃 - 자식 프로세스 kill
            let _ = child.kill();
            let _ = stdout_thread.join();
            return Err("Daemon startup timeout (5s)".to_string());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = stdout_thread.join();
            return Err("Daemon startup failed: channel disconnected".to_string());
        }
    }
}
