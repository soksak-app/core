//! The login shell of the user is the pw_shell member of the user database entry of the user id (getpwuid_r of pwd.h).

use std::ffi::CStr;

/// Returns pw_shell of the user database entry of the user of this process.
pub fn login_shell() -> Result<String, String> {
    let uid = unsafe { libc::getuid() };
    let mut size = 1024usize;
    loop {
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let mut buffer = vec![0 as libc::c_char; size];
        let code =
            unsafe { libc::getpwuid_r(uid, &mut entry, buffer.as_mut_ptr(), size, &mut result) };
        if code == libc::ERANGE && size < 1 << 20 {
            size *= 2;
            continue;
        }
        if code != 0 {
            return Err(format!("getpwuid_r for uid {uid}: errno {code}"));
        }
        if result.is_null() {
            return Err(format!("the user database has no entry for uid {uid}"));
        }
        let shell = if entry.pw_shell.is_null() {
            ""
        } else {
            unsafe { CStr::from_ptr(entry.pw_shell) }
                .to_str()
                .map_err(|_| format!("the login shell of uid {uid} is not valid UTF-8"))?
        };
        if shell.is_empty() {
            return Err(format!(
                "the user database names no login shell for uid {uid}"
            ));
        }
        return Ok(shell.to_string());
    }
}
