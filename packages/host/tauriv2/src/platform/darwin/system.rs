//! The system facts of macOS.

use std::ffi::CStr;

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
