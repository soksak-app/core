//! macOS 의 command line 동작. 엔드포인트는 Unix domain socket 이다.

use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use super::Connection;

#[path = "process.rs"]
mod process;

/// macOS 구현.
pub struct Darwin;

impl Connection for UnixStream {
    fn closer(&self) -> Result<Box<dyn Fn() + Send>, String> {
        let stream = self
            .try_clone()
            .map_err(|error| format!("endpoint connection: {error}"))?;
        Ok(Box::new(move || {
            // 기본값: 이미 닫힌 연결을 다시 닫으면 오류지만, 닫는 목적은 이미 이루어졌으므로 결과를 쓰지 않는다.
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }))
    }
}

impl Darwin {
    pub(super) fn connect(address: &str) -> Result<Box<dyn Connection>, String> {
        let stream = UnixStream::connect(address)
            .map_err(|error| format!("cannot connect to {address}: {error}"))?;
        Ok(Box::new(stream))
    }

    pub(super) fn on_interrupt(interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        let mut signals = signal_hook::iterator::Signals::new([
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGTERM,
        ])
        .map_err(|error| format!("cannot watch signals: {error}"))?;
        std::thread::spawn(move || {
            if signals.forever().next().is_some() {
                interrupted();
            }
        });
        Ok(())
    }

    pub(super) fn config_dir() -> Result<PathBuf, String> {
        std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(|home| PathBuf::from(home).join("Library/Application Support"))
            .ok_or_else(|| "$HOME is not defined".into())
    }
}
