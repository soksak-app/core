//! 프로세스의 표준 오류를 연 파일로 바꾼다(docs/spec/hosts.md#application-log).

use std::os::fd::AsRawFd;

pub fn replace(file: &std::fs::File) -> Result<(), String> {
    // SAFETY: file 은 열린 descriptor 이고, dup2 는 표준 오류 descriptor 를 그 복제로 바꾼다.
    if unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) } < 0 {
        return Err(format!(
            "replace standard error: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}
