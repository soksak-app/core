use std::path::PathBuf;

use super::super::{Connection, Platform};
use super::Linux;

impl Platform for Linux {
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
        Linux::connect(address)
    }

    fn on_interrupt(&self, interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        Linux::on_interrupt(interrupted)
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        Linux::config_dir()
    }

    fn executable(&self, metadata: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    fn set_executable(&self, path: &std::path::Path, executable: bool) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let mode = if executable { 0o755 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|error| crate::files::file_error(path.display(), &error))
    }

    fn close_file(&self, file: std::fs::File, path: &std::path::Path) -> Result<(), String> {
        use std::os::unix::io::IntoRawFd;
        let fd = file.into_raw_fd();
        if unsafe { libc::close(fd) } == 0 {
            Ok(())
        } else {
            let error = std::io::Error::last_os_error();
            Err(crate::files::file_error(path.display(), &error))
        }
    }

    /// Linux 의 shell 에는 파일마다 PATH 항목을 더하는 폴더가 없다.
    fn paths_dir(&self) -> Result<PathBuf, String> {
        Err("path entries are not implemented on linux".into())
    }

    fn extract_bundle(
        &self,
        _zip: &std::path::Path,
        _folder: &std::path::Path,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn wait_process_end(&self, _pid: i32, _timeout: std::time::Duration) -> Result<bool, String> {
        Err("waiting for a process end is not implemented on linux".into())
    }

    fn copy_bundle(
        &self,
        _source: &std::path::Path,
        _destination: &std::path::Path,
    ) -> Result<(), String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn open_application(
        &self,
        _bundle: &std::path::Path,
        _arguments: &[String],
    ) -> Result<(), String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn bundle_version(&self, _bundle: &std::path::Path) -> Result<String, String> {
        Err("application bundles are not implemented on linux".into())
    }

    fn key(&self) -> Result<String, String> {
        match std::env::consts::ARCH {
            "aarch64" => Ok("linux-arm64".into()),
            "x86_64" => Ok("linux-x64".into()),
            other => Err(format!("linux/{other} has no platform key")),
        }
    }
}
