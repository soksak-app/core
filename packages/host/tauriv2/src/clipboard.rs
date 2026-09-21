use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Window};

use crate::exposure;
use crate::platform::{self, ClipboardValue};

const MAX_BYTES: usize = 16 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);

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

fn response(value: ClipboardValue) -> ReadResponse {
    match value {
        ClipboardValue::Absent => ReadResponse {
            present: false,
            kind: None,
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
    let value = exposure::on_main(window, move || platform::current()?.clipboard_read(&kind))?;
    Ok(response(value))
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
    for _ in 0..16 {
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let path = directory.join(format!("pasted-image-{stamp:x}-{serial:x}.png"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("cannot allocate a unique clipboard image path".into())
}

#[cfg(test)]
mod tests {
    use super::persist_png_at;
    #[test]
    fn persists_owned_png_without_overwriting() {
        let root =
            std::env::temp_dir().join(format!("soksak-clipboard-test-{}", std::process::id()));
        if let Err(error) = std::fs::remove_dir_all(&root) {
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::NotFound,
                "failed to clear clipboard test directory: {error}"
            );
        }
        let path = persist_png_at(&root, b"png").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"png");
        std::fs::remove_dir_all(root)
            .unwrap_or_else(|error| panic!("failed to clean clipboard test directory: {error}"));
    }
}
