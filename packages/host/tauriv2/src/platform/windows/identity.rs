//! Directory identification.

use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use ::windows::Win32::Foundation::HANDLE;
use ::windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle,
};

/// Identifies a directory by the volume serial number and the file index.
pub fn identity(path: &Path) -> Result<String, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info)
            .map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "{}:{}",
        info.dwVolumeSerialNumber,
        (info.nFileIndexHigh as u64) << 32 | info.nFileIndexLow as u64
    ))
}
