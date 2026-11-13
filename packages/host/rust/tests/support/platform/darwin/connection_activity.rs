//! The connection activity of the host through the native library.

unsafe extern "C" {
    fn sp_connection_activity_held() -> bool;
}

/// Tells whether the host holds the connection activity of its endpoint.
pub fn held() -> bool {
    unsafe { sp_connection_activity_held() }
}
