//! Command line behavior on Linux. The endpoint is a Unix domain socket as on macOS, and the configuration folder is $XDG_CONFIG_HOME or ~/.config like
//! os.UserConfigDir of Go (docs/spec/cli.md).

use std::os::unix::io::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use super::Connection;

#[path = "process.rs"]
mod process;

/// The Linux implementation.
pub struct Linux;

impl Connection for UnixStream {
    fn closer(&self) -> Result<Box<dyn Fn() -> Result<(), String> + Send>, String> {
        let stream = self
            .try_clone()
            .map_err(|error| format!("endpoint connection: {}", crate::files::os_reason(&error)))?;
        Ok(Box::new(move || {
            stream.shutdown(std::net::Shutdown::Both).map_err(|error| {
                format!("endpoint connection: {}", crate::files::os_reason(&error))
            })
        }))
    }

    fn close(self: Box<Self>) -> Result<(), String> {
        // The drop of the standard library discards the result of close, so the code closes the file descriptor directly.
        let fd = (*self).into_raw_fd();
        if unsafe { libc::close(fd) } == 0 {
            Ok(())
        } else {
            let error = std::io::Error::last_os_error();
            Err(format!(
                "endpoint connection: {}",
                crate::files::os_reason(&error)
            ))
        }
    }
}

impl Linux {
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
        crate::routine::spawn_named("interrupt", move || {
            if signals.forever().next().is_some() {
                interrupted();
            }
        });
        Ok(())
    }

    pub(super) fn config_dir() -> Result<PathBuf, String> {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty())
        {
            let config = PathBuf::from(config);
            if !config.is_absolute() {
                return Err("path in $XDG_CONFIG_HOME is relative".into());
            }
            return Ok(config);
        }
        std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(|home| PathBuf::from(home).join(".config"))
            .ok_or_else(|| "neither $XDG_CONFIG_HOME nor $HOME are defined".into())
    }
}
