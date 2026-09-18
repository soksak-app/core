// 공통 VT 계층: 프로토콜, 세션 수명, 화면 타입, Engine 트레이트
pub mod protocol;
pub mod daemon;
pub mod platform;

pub use protocol::{Engine, Screen, Modes, Cell, Cursor, serve, SessionManager};
pub use daemon::{DaemonIdentity, DaemonClient, DaemonRequest, DaemonResponse, DaemonFinder};
pub use platform::get_daemon_finder;
