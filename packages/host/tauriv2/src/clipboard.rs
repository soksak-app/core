use std::fs;
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

pub fn validate_png_payload(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("clipboard PNG size is invalid".into());
    }
    Ok(())
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
    validate_png_payload(&bytes)?;
    let directory = root.join("clipboard");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
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
        let root = tempfile::tempdir().unwrap();
        let first = persist_png_at(root.path(), b"png").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"png");
        let permissions = std::fs::metadata(&first).unwrap().permissions();
        let mode = std::os::unix::fs::PermissionsExt::mode(&permissions);
        assert_eq!(mode & 0o777, 0o600, "clipboard image mode {mode:o}");
        // 두 번째 저장은 새 파일을 만들고 첫 파일을 덮어쓰지 않는다.
        let second = persist_png_at(root.path(), b"other").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"png");
        assert_eq!(std::fs::read(&second).unwrap(), b"other");
    }
}
