//! Operating system specific behavior of the command line and the selection of the implementation for the current operating system. Operating system specific code lives only under `<os>/` of this
//! directory.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::PoisonError;

/// One endpoint connection.
pub trait Connection: Read + Write + Send {
    /// A second handle of this connection, so one thread reads while another writes (docs/spec/cli.md#mcp-server).
    fn try_clone(&self) -> Result<Box<dyn Connection>, String>;
    /// A function that closes this connection from another thread. A thread that waits for a read receives an error that the connection closed.
    fn closer(&self) -> Result<Box<dyn Fn() -> Result<(), String> + Send>, String>;
    /// Closes the connection and returns the result.
    fn close(self: Box<Self>) -> Result<(), String>;
}

/// Operating system specific behavior.
pub trait Platform {
    /// Ok when the process pid is running.
    fn process_running(&self, pid: i32) -> Result<(), String>;
    /// Checks whether `pid` is the live sidecar service process that published the endpoint whose modification time is
    /// `published`: a process that started later received the pid after the publisher ended
    /// (docs/spec/persistent-services.md#endpoint-publisher). The hosts read it before they reuse an endpoint, and the
    /// installer before it changes the version of a sidecar (docs/spec/persistent-services.md#updates).
    fn service_process_exists(
        &self,
        pid: u32,
        published: std::time::SystemTime,
    ) -> Result<bool, String>;
    /// Connects to the address of endpoint.json.
    fn connect(&self, address: &str) -> Result<Box<dyn Connection>, String>;
    /// Calls interrupted with the name of the first interrupt signal (`SIGINT`, `SIGTERM`) when it arrives.
    fn on_interrupt(&self, interrupted: Box<dyn FnOnce(&'static str) + Send>)
    -> Result<(), String>;
    /// The user configuration folder, at the same location as os.UserConfigDir of Go.
    fn config_dir(&self) -> Result<PathBuf, String>;
    /// Whether the file has an execute bit. It sets the mode of a release entry.
    fn executable(&self, metadata: &std::fs::Metadata) -> bool;
    /// The release key (`<os>-<arch>`) of this platform; an architecture without a key is an error.
    fn key(&self) -> Result<String, String>;
    /// Ok when this operating system has the user PATH registration, and otherwise the reason that it has none
    /// (docs/spec/cli.md#user-path-registration).
    fn user_path(&self) -> Result<(), String>;
    /// Reads the desired state of PATH registration and the first command that the login shell can resolve.
    fn user_path_state(
        &self,
        environment: &crate::setup::Environment,
    ) -> Result<crate::setup::Part, String>;
    /// Changes PATH registration in the user's login shell to match its desired state.
    fn configure_user_path(
        &self,
        environment: &crate::setup::Environment,
        shell: &str,
        executable: &std::path::Path,
        enabled: Option<bool>,
    ) -> Result<bool, String>;
    /// Sets the mode of an unpacked file to 0755 for an executable and to 0644 otherwise.
    fn set_executable(&self, path: &std::path::Path, executable: bool) -> Result<(), String>;
    /// Closes the file at path and returns the result. The drop of the standard library discards the result of closing.
    fn close_file(&self, file: std::fs::File, path: &std::path::Path) -> Result<(), String>;
    /// Extracts the zip of an application bundle into the folder.
    fn extract_bundle(&self, zip: &std::path::Path, folder: &std::path::Path)
    -> Result<(), String>;
    /// The version that the application bundle at the path declares.
    fn bundle_version(&self, bundle: &std::path::Path) -> Result<String, String>;
    /// Waits until the operating system reports that the process pid ended. It takes no time limit.
    fn wait_process_end(&self, pid: i32) -> Result<(), String>;
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
    /// Takes an exclusive advisory lock on the open file and waits until it holds it, so the processes that update one index exclude
    /// each other (docs/spec/logging.md#index). Closing the file releases the lock.
    fn lock_file(&self, file: &std::fs::File) -> Result<(), String>;
    /// Whether the open file is the file at the path (the same device and the same index).
    fn same_file(&self, file: &std::fs::File, path: &std::path::Path) -> Result<bool, String>;
    /// Creates and restricts the event-log directory to the current user (mode 0700 on Unix).
    fn prepare_log_directory(&self, path: &std::path::Path) -> Result<(), String>;
    /// Creates a new event-log file for appending with private access (mode 0600 on Unix).
    fn create_log_file(&self, path: &std::path::Path) -> Result<std::fs::File, String>;
    /// Opens an event-log file for appending, creating it with private access when absent.
    fn append_log_file(&self, path: &std::path::Path) -> Result<std::fs::File, String>;
    /// Opens or creates the configuration ownership lock with private access (mode 0600 on Unix).
    fn open_process_lock_file(&self, path: &std::path::Path) -> Result<std::fs::File, String>;
    /// Starts a new instance of the application bundle with the arguments. It activates the new instance only when
    /// activate is set.
    fn open_application(
        &self,
        bundle: &std::path::Path,
        arguments: &[String],
        activate: bool,
    ) -> Result<(), String>;
    /// Whether the file system that holds the path is mounted read-only (docs/spec/cli.md#mcp-registration).
    fn read_only_volume(&self, path: &std::path::Path) -> Result<bool, String>;
    /// Whether the sok at the path may be registered as the MCP server: on macOS only the sok of an application bundle,
    /// in `Contents/MacOS` of a folder whose name ends in `.app` (docs/spec/cli.md#mcp-registration).
    fn registrable_sok(&self, sok: &std::path::Path) -> Result<bool, String>;
    /// Replaces this process with the program and the arguments, with the same environment. It returns only on a failure, with its
    /// text.
    fn exec(&self, program: &std::path::Path, arguments: &[String]) -> String;
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

/// The implementation that `register` set in place of the one of the operating system; a test of an operation registers one
/// that records the calls of the operation, as the Go library does with platform.Register.
static REGISTERED: std::sync::Mutex<Option<std::sync::Arc<dyn Platform + Send + Sync>>> =
    std::sync::Mutex::new(None);

/// Sets the implementation that `current` returns, or with None the one of the operating system again.
pub fn register(platform: Option<std::sync::Arc<dyn Platform + Send + Sync>>) {
    let registered = REGISTERED.lock();
    // default: a poisoned lock holds a valid registration.
    *registered.unwrap_or_else(PoisonError::into_inner) = platform;
}

/// The registered implementation, or the implementation for the current operating system.
pub fn current() -> Result<std::sync::Arc<dyn Platform + Send + Sync>, String> {
    let registered = REGISTERED.lock();
    // default: a poisoned lock holds a valid registration.
    let registered = registered.unwrap_or_else(PoisonError::into_inner);
    if let Some(platform) = registered.clone() {
        return Ok(platform);
    }
    #[cfg(target_os = "macos")]
    return Ok(std::sync::Arc::new(darwin::Darwin));
    #[cfg(target_os = "linux")]
    return Ok(std::sync::Arc::new(linux::Linux));
    #[cfg(windows)]
    return Ok(std::sync::Arc::new(windows::Windows));
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Err("no platform implementation exists for this operating system".into());
}
