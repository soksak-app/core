use crate::daemon::DaemonFinder;

#[cfg(target_os = "macos")]
pub use crate::platform::darwin::frame::{Frame, Metrics, metrics};

#[cfg(target_os = "macos")]
pub struct ImageState {
    pub name: String,
    pub frame: Frame,
    pub metrics: Metrics,
    pub sequence: u32,
    pub pending_draw: bool,
    pub dirty: bool,
    pub width_px: u32,
    pub height_px: u32,
    pub scale: f32,
}

#[cfg(target_os = "macos")]
impl ImageState {
    pub fn new(name: String, width_px: u32, height_px: u32, scale: f32) -> Option<ImageState> {
        let frame = Frame::new(width_px, height_px)?;
        let device_metrics = metrics(13.0, scale);
        Some(ImageState {
            name,
            frame,
            metrics: device_metrics,
            sequence: 0,
            pending_draw: false,
            dirty: false,
            width_px,
            height_px,
            scale,
        })
    }
}

#[cfg(not(target_os = "macos"))]
pub struct ImageState;

#[cfg(not(target_os = "macos"))]
impl ImageState {
    pub fn new(_name: String, _width_px: u32, _height_px: u32, _scale: f32) -> Option<ImageState> {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn get_daemon_finder() -> Box<dyn DaemonFinder> {
    use crate::platform::darwin::DarwinDaemonFinder;
    Box::new(DarwinDaemonFinder::new())
}

#[cfg(not(target_os = "macos"))]
pub fn get_daemon_finder() -> Box<dyn DaemonFinder> {
    panic!("Unsupported platform");
}
