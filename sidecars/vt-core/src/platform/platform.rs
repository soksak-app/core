use crate::daemon::DaemonFinder;

#[cfg(target_os = "macos")]
pub fn get_daemon_finder() -> Box<dyn DaemonFinder> {
    use crate::platform::darwin::DarwinDaemonFinder;
    Box::new(DarwinDaemonFinder::new())
}

#[cfg(not(target_os = "macos"))]
pub fn get_daemon_finder() -> Box<dyn DaemonFinder> {
    panic!("Unsupported platform");
}
