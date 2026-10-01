//! Command line 의 운영체제별 동작과 현재 운영체제 구현의 선택. 운영체제별 코드는 이 디렉터리 아래 `<os>/` 에만
//! 둔다.

/// 운영체제별 동작.
pub trait Platform {
    /// pid 프로세스가 실행 중이면 Ok 다.
    fn process_running(&self, pid: i32) -> Result<(), String>;
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
