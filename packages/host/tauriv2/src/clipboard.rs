use std::io::Write;
use std::path::Path;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Window};

use crate::exposure;
use crate::platform::{self, ClipboardValue};

const MAX_BYTES: usize = 16 * 1024 * 1024;

pub fn validate_read_request(kind: &str, user_initiated: bool) -> Result<(), String> {
    if !user_initiated {
        return Err("clipboard read requires an explicit user paste".into());
    }
    if !matches!(kind, "text" | "png" | "fileURLs") {
        return Err("unsupported clipboard type".into());
    }
    Ok(())
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn validate_png_payload(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("clipboard PNG size is invalid".into());
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("clipboard PNG signature is missing".into());
    }
    validate_png_header(bytes)
        .map_err(|reason| format!("clipboard PNG header is invalid: {reason}"))
}

// 서명 뒤의 첫 청크는 13바이트 IHDR 이다(PNG 명세 11.2.2).
fn validate_png_header(bytes: &[u8]) -> Result<(), &'static str> {
    let chunk = bytes.get(8..33).ok_or("the IHDR chunk is truncated")?;
    if chunk[0..4] != [0, 0, 0, 13] || &chunk[4..8] != b"IHDR" {
        return Err("the first chunk is not a 13-byte IHDR");
    }
    let expected = u32::from_be_bytes([chunk[21], chunk[22], chunk[23], chunk[24]]);
    if crc32(&chunk[4..21]) != expected {
        return Err("the IHDR CRC does not match");
    }
    let width = u32::from_be_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]);
    let height = u32::from_be_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]);
    if width == 0 || height == 0 {
        return Err("the width or height is zero");
    }
    let allowed: &[u8] = match chunk[17] {
        0 => &[1, 2, 4, 8, 16],
        3 => &[1, 2, 4, 8],
        2 | 4 | 6 => &[8, 16],
        _ => return Err("the color type is not a PNG color type"),
    };
    if !allowed.contains(&chunk[16]) {
        return Err("the bit depth is not allowed for the color type");
    }
    if chunk[18] != 0 || chunk[19] != 0 || chunk[20] > 1 {
        return Err("the compression, filter, or interlace method is not a PNG method");
    }
    Ok(())
}

// PNG 가 쓰는 CRC-32(다항식 0xEDB88320).
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[derive(Debug, Deserialize)]
pub(crate) struct ReadRequest {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "userInitiated")]
    pub user_initiated: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PersistRequest {
    pub data: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReadResponse {
    pub present: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
}

fn response(value: ClipboardValue, kind: &str) -> ReadResponse {
    match value {
        ClipboardValue::Absent => ReadResponse {
            present: false,
            kind: Some(match kind {
                "text" => "text",
                "png" => "png",
                "fileURLs" => "fileURLs",
                _ => unreachable!("clipboard read kind was validated before response"),
            }),
            text: None,
            data: None,
            urls: None,
        },
        ClipboardValue::Text(text) => ReadResponse {
            present: true,
            kind: Some("text"),
            text: Some(text),
            data: None,
            urls: None,
        },
        ClipboardValue::Png(bytes) => ReadResponse {
            present: true,
            kind: Some("png"),
            text: None,
            data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            urls: None,
        },
        ClipboardValue::FileUrls(urls) => ReadResponse {
            present: true,
            kind: Some("fileURLs"),
            text: None,
            data: None,
            urls: Some(urls),
        },
    }
}

pub(crate) fn read(window: &Window, request: ReadRequest) -> Result<ReadResponse, String> {
    validate_read_request(&request.kind, request.user_initiated)?;
    let kind = request.kind;
    let read_kind = kind.clone();
    let value = exposure::on_main(window, move || {
        platform::current()?.clipboard_read(&read_kind)
    })?;
    Ok(response(value, &kind))
}

pub(crate) fn write_text(window: &Window, text: String) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("clipboard text exceeds 16 MiB".into());
    }
    exposure::on_main(window, move || {
        platform::current()?.clipboard_write_text(&text)
    })
}

pub(crate) fn persist_png(app: &AppHandle, data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    persist_png_at(
        &crate::config_directory(app).map_err(|e| e.to_string())?,
        &bytes,
    )
}

fn persist_png_at(root: &Path, bytes: &[u8]) -> Result<String, String> {
    validate_png_payload(bytes)?;
    let directory = root.join("clipboard");
    platform::current()?.create_private_directories(&directory)?;
    // tempfile 은 이름이 겹치지 않는 새 파일을 소유자만 읽고 쓰는 권한(0600)으로 만든다.
    let mut file = tempfile::Builder::new()
        .prefix("pasted-image-")
        .suffix(".png")
        .tempfile_in(&directory)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    let (_, path) = file.keep().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::persist_png_at;
    // contract: clipboard.persist-png.writes-exact-bytes, clipboard.persist-png.owner-only-mode
    #[test]
    fn persists_each_png_to_a_new_owner_only_file() {
        // 1x1 RGBA PNG 의 서명과 IHDR. 뒤의 바이트는 검사하지 않으므로 두 파일을 구별하는 데 쓴다.
        let png: Vec<u8> = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89,
        ]
        .to_vec();
        let other = [png.as_slice(), b"other"].concat();
        let root = tempfile::tempdir().unwrap();
        let first = persist_png_at(root.path(), &png).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), png);
        let permissions = std::fs::metadata(&first).unwrap().permissions();
        let mode = std::os::unix::fs::PermissionsExt::mode(&permissions);
        assert_eq!(mode & 0o777, 0o600, "clipboard image mode {mode:o}");
        // 두 번째 저장은 새 파일을 만들고 첫 파일을 덮어쓰지 않는다.
        let second = persist_png_at(root.path(), &other).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), png);
        assert_eq!(std::fs::read(&second).unwrap(), other);
    }
}
