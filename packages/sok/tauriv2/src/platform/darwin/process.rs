use std::path::PathBuf;

use super::super::{Connection, Platform};
use super::Darwin;

impl Platform for Darwin {
    /// signal 0 으로 프로세스가 있는지 본다. 다른 사용자의 프로세스(EPERM)도 실행 중이다.
    fn process_running(&self, pid: i32) -> Result<(), String> {
        // SAFETY: kill 은 signal 0 을 보내 프로세스 존재만 확인하며 메모리를 다루지 않는다.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EPERM) {
            return Ok(());
        }
        Err(format!("process {pid} is not running: {error}"))
    }

    fn connect(&self, address: &str) -> Result<Box<dyn Connection>, String> {
        Darwin::connect(address)
    }

    fn on_interrupt(&self, interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        Darwin::on_interrupt(interrupted)
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        Darwin::config_dir()
    }

    fn executable(&self, metadata: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    fn set_executable(&self, path: &std::path::Path, executable: bool) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|error| format!("{}: {error}", path.display()))
    }

    fn key(&self) -> Result<String, String> {
        match std::env::consts::ARCH {
            "aarch64" => Ok("darwin-arm64".into()),
            "x86_64" => Ok("darwin-x64".into()),
            other => Err(format!("darwin/{other} has no platform key")),
        }
    }
}
