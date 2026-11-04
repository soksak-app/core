//! Directory identification.

use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;

/// Identifies a directory by the device number and the inode number.
pub fn identity(metadata: &Metadata) -> String {
    format!("{}:{}", metadata.dev(), metadata.ino())
}
