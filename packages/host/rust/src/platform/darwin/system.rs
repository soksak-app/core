//! The system facts of macOS.

use std::ffi::CStr;

use objc2::msg_send;
use objc2::runtime::AnyObject;

/// The product version of macOS, such as "26.6.2", from the kern.osproductversion sysctl.
pub fn os_version() -> Result<String, String> {
    let name = c"kern.osproductversion";
    let mut buffer = [0u8; 64];
    let mut length = buffer.len();
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return Err(format!(
            "kern.osproductversion: {}",
            std::io::Error::last_os_error()
        ));
    }
    CStr::from_bytes_until_nul(&buffer[..length])
        .map_err(|error| format!("kern.osproductversion: {error}"))?
        .to_str()
        .map(str::to_string)
        .map_err(|error| format!("kern.osproductversion: {error}"))
}

/// Whether the application is the active application (NSApplication isActive). Call it on the main thread.
pub fn application_active() -> Result<bool, String> {
    let application: *mut AnyObject =
        unsafe { msg_send![objc2::class!(NSApplication), sharedApplication] };
    Ok(unsafe { msg_send![application, isActive] })
}
