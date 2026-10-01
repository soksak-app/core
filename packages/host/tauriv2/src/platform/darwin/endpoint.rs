//! 로컬 엔드포인트의 Unix 도메인 소켓.
//!
//! 소켓은 호출자가 정한 디렉터리에 둔다(애플리케이션은 사용자별 임시 디렉터리 아래 `soksak/`).
//! 설정 디렉터리 경로는 소켓 경로의 길이 제한(104 바이트)을 넘을 수 있다. 디렉터리는 현재 사용자만
//! 접근할 수 있고, 다른 권한이나 다른 소유자의 디렉터리이면 열지 않는다.

use std::fs;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::super::{Connection, Listener};

extern "C" {
    fn geteuid() -> u32;
    fn kill(pid: i32, signal: i32) -> i32;
}

/// `kill` 이 번호의 프로세스가 없을 때 알리는 오류 번호.
const ESRCH: i32 = 3;

/// persistent service endpoint의 프로세스가 아직 존재하는지 확인한다.
///
/// 시그널을 받을 수 있는 프로세스만 존재한다. 기다리지 않은 스폰은 좀비로 남아
/// kill(pid, 0) 을 통과하므로(V5-106), 통과한 프로세스는 상태를 읽어 좀비를 가려낸다 —
/// 좀비는 이미 끝났고, 그 endpoint 는 낡은 것이다.
pub fn service_process_exists(pid: u32) -> Result<bool, String> {
    if pid == 0 {
        return Ok(false);
    }
    let result = unsafe { kill(pid as i32, 0) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ESRCH) {
            return Ok(false);
        }
        return Err(format!("cannot inspect service process {pid}: {error}"));
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("cannot inspect service process {pid} state: {e}"))?;
    let state = String::from_utf8_lossy(&output.stdout);
    if !state.trim_start().starts_with('Z') {
        return Ok(true);
    }
    Ok(false)
}

/// 번호 pid 의 프로세스가 끝났는지 반환한다.
fn ended(pid: i32) -> bool {
    let result = unsafe { kill(pid, 0) };
    result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(ESRCH)
}

/// directory 에서 끝난 프로세스가 남긴 name 의 소켓을 제거한다. 강제 종료된 프로세스는 자기
/// 소켓을 지우지 못한다. 번호의 프로세스가 있으면 다른 프로그램이어도 남긴다.
fn remove_ended(directory: &Path, name: &str) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|e| format!("{}: {e}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", directory.display()))?;
        let file = entry.file_name();
        let Some(pid) = file.to_str().and_then(|file| {
            file.strip_prefix(name)?
                .strip_prefix('-')?
                .strip_suffix(".sock")?
                .parse::<i32>()
                .ok()
        }) else {
            continue;
        };
        if pid <= 0 || !ended(pid) {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", entry.path().display())),
        }
    }
    Ok(())
}

/// path 를 현재 사용자만 접근할 수 있는 디렉터리로 만든다. 이미 있으면 소유자와 권한을 확인한다.
pub fn private_directory(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    if metadata.uid() != unsafe { geteuid() } {
        return Err(format!("{} belongs to another user", path.display()));
    }
    if metadata.mode() & 0o777 != 0o700 {
        return Err(format!(
            "{} has mode {:o}, want 700",
            path.display(),
            metadata.mode() & 0o777
        ));
    }
    Ok(())
}

struct Socket {
    listener: UnixListener,
    path: PathBuf,
}

impl Listener for Socket {
    fn accept(&self) -> Result<Box<dyn Connection>, String> {
        let (stream, _) = self.listener.accept().map_err(|e| e.to_string())?;
        Ok(Box::new(Stream(stream)))
    }

    fn transport(&self) -> &'static str {
        "unix"
    }

    fn address(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    fn remove(&self) {
        if let Err(error) = fs::remove_file(&self.path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("{}: {error}", self.path.display());
            }
        }
    }
}

struct Stream(UnixStream);

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl Connection for Stream {
    fn try_clone(&self) -> Result<Box<dyn Connection>, String> {
        Ok(Box::new(Stream(
            self.0.try_clone().map_err(|e| e.to_string())?,
        )))
    }

    fn set_read_timeout(&self, timeout: Option<Duration>) -> Result<(), String> {
        self.0.set_read_timeout(timeout).map_err(|e| e.to_string())
    }

    fn close(&self) -> Result<(), String> {
        match self.0.shutdown(Shutdown::Both) {
            // 상대가 먼저 끊었거나 이미 닫은 연결은 닫힌 상태이므로 실패가 아니다.
            Err(error) if error.kind() == std::io::ErrorKind::NotConnected => Ok(()),
            result => result.map_err(|error| error.to_string()),
        }
    }
}

/// `<directory>/<name>-<pid>.sock` 소켓을 연다. 끝난 프로세스의 소켓과, 종료한 같은 번호의
/// 프로세스가 남긴 같은 경로의 소켓 파일을 먼저 제거한다.
pub fn listen(directory: &Path, name: &str) -> Result<Box<dyn Listener>, String> {
    private_directory(directory)?;
    remove_ended(directory, name)?;
    let path = directory.join(format!("{name}-{}.sock", std::process::id()));
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let listener = UnixListener::bind(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Box::new(Socket { listener, path }))
}

/// 소켓 경로 address 에 연결한다.
pub fn connect(address: &str) -> Result<Box<dyn Connection>, String> {
    let stream = UnixStream::connect(address).map_err(|e| format!("{address}: {e}"))?;
    Ok(Box::new(Stream(stream)))
}
