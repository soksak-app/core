//! The raise of the windows of the application is implemented by sp_windows_raise in native/darwin.

/// Sets the windows of the application at the normal window level, and each window that the application shows while the state
/// is on, to the check window level, or puts the windows that it raised back to the normal level (diagnostics.windows.raise,
/// docs/spec/endpoint.md#diagnostic-builds). Call it on the main thread.
pub fn raise(raise: bool) {
    unsafe extern "C" {
        fn sp_windows_raise(raise: bool);
    }
    unsafe { sp_windows_raise(raise) };
}
