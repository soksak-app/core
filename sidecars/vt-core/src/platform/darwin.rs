use crate::daemon::{DaemonFinder, DaemonIdentity};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::fs;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, DirBuilderExt};
use nix::fcntl::{flock, FlockArg};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, SystemTime};

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

    // 잠금 해제
    let _ = flock(fd, FlockArg::Unlock);

    result
}

/// 실제로 데몬 프로세스를 시작한다.
/// 분리(setsid + fd 0·1·2 를 /dev/null 로)는 데몬 자신이 한다. 여기서 먼저 setsid 를 부르면
/// 자식이 이미 세션 리더라 데몬의 setsid 가 EPERM 으로 실패해 곧바로 죽는다.
fn start_daemon_process(exe_dir: &Path, identity: &DaemonIdentity, socket_dir: &Path) -> Result<String, String> {
    let daemon_exe = exe_dir.join("soksak-ptyd");

    if !daemon_exe.exists() {
        return Err("Daemon executable not found".to_string());
    }

    let child = Command::new(&daemon_exe)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .env("PTYD_PROTOCOL", identity.protocol.clone())
        .env("SOKSAK_PROFILE", identity.build_kind.clone())
        .env("PTYD_SOCKET_DIR", socket_dir.to_string_lossy().to_string())
        .env("PTYD_NO_DAEMONIZE", "1")
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    // 프로세스를 detach
    drop(child);

    // 데몬 시작을 기다린다 (최대 5초)
    let start = SystemTime::now();
    loop {
        if let Ok(socket_path) = find_connected_socket(socket_dir, identity) {
            return Ok(socket_path);
        }

        if start.elapsed().unwrap_or(Duration::from_secs(10)) > Duration::from_secs(5) {
            return Err("Daemon startup timeout".to_string());
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}
