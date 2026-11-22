//! Directory identification.

use std::ffi::{CString, c_void};
use std::fs::Metadata;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// The form that identity returns: the uppercase hyphenated UUID, a colon and the decimal inode.
pub const FORM: &str = "<volume UUID>:<inode>";

/// Returns whether identity has the form FORM: a UUID of the 8-4-4-4-12 uppercase hexadecimal groups, a colon and a decimal inode.
pub fn is_valid(identity: &str) -> bool {
    let Some((uuid, inode)) = identity.split_once(':') else {
        return false;
    };
    let lengths = [8, 4, 4, 4, 12];
    let groups: Vec<&str> = uuid.split('-').collect();
    let uuid_ok = groups.len() == lengths.len()
        && groups.iter().zip(lengths).all(|(group, length)| {
            group.len() == length
                && group
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        });
    uuid_ok && !inode.is_empty() && inode.bytes().all(|b| b.is_ascii_digit())
}

/// Identifies a directory by the UUID of its volume and its inode number: `<volume UUID>:<inode>`. The device number st_dev does
/// not identify a volume across boots, because the system renumbers it at each boot, and statfs f_fsid is the same device number.
/// getattrlist with ATTR_VOL_UUID returns the UUID that the volume stores, which stays the same across boots and remounts.
pub fn identity(path: &Path, metadata: &Metadata) -> Result<String, String> {
    let error = |detail: String| {
        format!(
            "project directory volume UUID cannot be read: {} ({detail})",
            path.display()
        )
    };
    let name = CString::new(path.as_os_str().as_bytes()).map_err(|e| error(e.to_string()))?;
    let mut list: libc::attrlist = unsafe { std::mem::zeroed() };
    list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    list.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID;
    // The reply is the length of the reply as a u32 followed by the 16 bytes of the UUID.
    let mut reply = [0u8; 4 + 16];
    let status = unsafe {
        libc::getattrlist(
            name.as_ptr(),
            &mut list as *mut libc::attrlist as *mut c_void,
            reply.as_mut_ptr() as *mut c_void,
            reply.len(),
            0,
        )
    };
    if status != 0 {
        let cause = std::io::Error::last_os_error();
        return Err(error(match cause.raw_os_error() {
            Some(errno) => format!("errno {errno}"),
            None => cause.to_string(),
        }));
    }
    let id = &reply[4..];
    let uuid = format!(
        "{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
        id[0],
        id[1],
        id[2],
        id[3],
        id[4],
        id[5],
        id[6],
        id[7],
        id[8],
        id[9],
        id[10],
        id[11],
        id[12],
        id[13],
        id[14],
        id[15]
    );
    Ok(format!("{uuid}:{}", metadata.ino()))
}
