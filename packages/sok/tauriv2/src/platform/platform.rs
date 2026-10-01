//! Command line 의 운영체제별 동작과 현재 운영체제 구현의 선택. 운영체제별 코드는 이 디렉터리 아래 `<os>/` 에만
//! 둔다.

use std::io::{Read, Write};
use std::path::PathBuf;

/// 엔드포인트 연결 하나.
pub trait Connection: Read + Write + Send {
    /// 다른 thread 에서 이 연결을 닫는 함수. 읽기를 기다리는 thread 는 연결이 닫혔다는 오류를 받는다.
    fn closer(&self) -> Result<Box<dyn Fn() + Send>, String>;
}

/// 운영체제별 동작.
pub trait Platform {
    /// pid 프로세스가 실행 중이면 Ok 다.
    fn process_running(&self, pid: i32) -> Result<(), String>;
    /// endpoint.json 의 address 에 연결한다.
    fn connect(&self, address: &str) -> Result<Box<dyn Connection>, String>;
    /// 중단 신호(SIGINT, SIGTERM)가 처음 오면 interrupted 를 부른다.
    fn on_interrupt(&self, interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String>;
    /// 사용자 설정 폴더. Go 의 os.UserConfigDir 와 같은 자리다.
    fn config_dir(&self) -> Result<PathBuf, String>;
}

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
mod darwin;

#[cfg(windows)]
#[path = "windows/windows.rs"]
mod windows;

/// 현재 운영체제의 구현.
pub fn current() -> Result<Box<dyn Platform>, String> {
    #[cfg(target_os = "macos")]
    return Ok(Box::new(darwin::Darwin));
    #[cfg(windows)]
    return Ok(Box::new(windows::Windows));
    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("no platform implementation exists for this operating system".into());
}
