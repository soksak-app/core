use super::super::Platform;
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
}
