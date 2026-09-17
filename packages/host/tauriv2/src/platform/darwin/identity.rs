//! 디렉터리 식별.

use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;

/// 장치 번호와 inode 번호로 디렉터리를 식별한다.
pub fn identity(metadata: &Metadata) -> String {
    format!("{}:{}", metadata.dev(), metadata.ino())
}
