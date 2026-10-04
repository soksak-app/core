//! Windows 의 command line 동작. 아직 구현하지 않은 동작은 "<operation> is not implemented on windows" 오류를 돌려준다.

#[path = "unsupported.rs"]
mod unsupported;

/// Windows 구현.
pub struct Windows;
