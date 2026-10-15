//! Operating system specific behavior of the command line and the selection of the implementation for the current operating system. Operating system specific code lives only under `<os>/` of this
//! directory.

use std::io::{Read, Write};
use std::path::PathBuf;

/// One endpoint connection.
pub trait Connection: Read + Write + Send {
    /// A function that closes this connection from another thread. A thread that waits for a read receives an error that the connection closed.
    fn closer(&self) -> Result<Box<dyn Fn() -> Result<(), String> + Send>, String>;
    /// Closes the connection and returns the result.
    fn close(self: Box<Self>) -> Result<(), String>;
}

/// Operating system specific behavior.
pub trait Platform {
    /// Ok when the process pid is running.
    fn process_running(&self, pid: i32) -> Result<(), String>;
    /// Connects to the address of endpoint.json.
    fn connect(&self, address: &str) -> Result<Box<dyn Connection>, String>;
    /// Calls interrupted when the first interrupt signal (SIGINT, SIGTERM) arrives.
    fn on_interrupt(&self, interrupted: Box<dyn FnOnce() + Send>) -> Result<(), String>;
    /// The user configuration folder, at the same location as os.UserConfigDir of Go.
    fn config_dir(&self) -> Result<PathBuf, String>;
    /// Whether the file has an execute bit. It sets the mode of a release entry.
    fn executable(&self, metadata: &std::fs::Metadata) -> bool;
    /// The release key (`<os>-<arch>`) of this platform; an architecture without a key is an error.
    fn key(&self) -> Result<String, String>;
    /// The folder that holds path entries. It is an error when this operating system has no such folder (docs/spec/cli.md).
    fn paths_dir(&self) -> Result<PathBuf, String>;
    /// Makes a symbolic link at `link` whose target is the text `target`, for the symbolic links of an application release.
    fn symlink(&self, target: &std::path::Path, link: &std::path::Path) -> Result<(), String>;
    /// Sets the mode of an unpacked file to 0755 for an executable and to 0644 otherwise.
    fn set_executable(&self, path: &std::path::Path, executable: bool) -> Result<(), String>;
    /// Closes the file at path and returns the result. The drop of the standard library discards the result of closing.
    fn close_file(&self, file: std::fs::File, path: &std::path::Path) -> Result<(), String>;
    /// Extracts the zip of an application bundle into the folder.
    fn extract_bundle(&self, zip: &std::path::Path, folder: &std::path::Path)
    -> Result<(), String>;
    /// The version that the application bundle at the path declares.
    fn bundle_version(&self, bundle: &std::path::Path) -> Result<String, String>;
    /// Waits until the process pid has ended and reports false when it still runs after the timeout.
    fn wait_process_end(&self, pid: i32, timeout: std::time::Duration) -> Result<bool, String>;
    /// Copies an application bundle, also across volumes, keeping its modes and signature.
    fn copy_bundle(
        &self,
        source: &std::path::Path,
        destination: &std::path::Path,
    ) -> Result<(), String>;
    /// The system-wide monotonic clock in nanoseconds that the events carry as `mono_ns` (docs/spec/logging.md#event). It is
    /// the clock of the native library, so events of different processes compare.
    fn monotonic_nanos(&self) -> Result<u64, String>;
    /// Opens the index file at the path for reading and writing, and creates it with the mode of a private file when it does not exist.
    fn open_index(&self, path: &std::path::Path) -> Result<std::fs::File, String>;
    /// The path of the application bundle with the identifier, or `None` when none is found (docs/spec/installation.md#applications).
    fn application_of_bundle(&self, identifier: &str)
    -> Result<Option<std::path::PathBuf>, String>;
    /// Takes an exclusive advisory lock on the open file and waits until it holds it, so the processes that update one index exclude
    /// each other (docs/spec/logging.md#index). Closing the file releases the lock.
    fn lock_file(&self, file: &std::fs::File) -> Result<(), String>;
    /// Whether the open file is the file at the path (the same device and the same index).
    fn same_file(&self, file: &std::fs::File, path: &std::path::Path) -> Result<bool, String>;
    /// Starts a new instance of the application bundle with the arguments.
    fn open_application(
        &self,
        bundle: &std::path::Path,
        arguments: &[String],
    ) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
mod darwin;

#[cfg(target_os = "linux")]
#[path = "linux/linux.rs"]
mod linux;

#[cfg(windows)]
#[path = "windows/windows.rs"]
mod windows;

/// The implementation for the current operating system.
pub fn current() -> Result<Box<dyn Platform>, String> {
    #[cfg(target_os = "macos")]
    return Ok(Box::new(darwin::Darwin));
    #[cfg(target_os = "linux")]
    return Ok(Box::new(linux::Linux));
    #[cfg(windows)]
    return Ok(Box::new(windows::Windows));
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Err("no platform implementation exists for this operating system".into());
}
