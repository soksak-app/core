use std::io::Write;
use std::path::Path;

use crate::framework::{AppHandle, Window};
use base64::Engine;
use serde::{Deserialize, Serialize};

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

// The first chunk after the signature is the 13-byte IHDR (PNG specification 11.2.2).
fn validate_png_header(bytes: &[u8]) -> Result<(), &'static str> {
    let chunk = bytes.get(8..33).ok_or("the IHDR chunk is truncated")?;
    if chunk[0..4] != [0, 0, 0, 13] || &chunk[4..8] != b"IHDR" {
        return Err("the first chunk is not a 13-byte IHDR");
    }
    let expected = u32::from_be_bytes([chunk[21], chunk[22], chunk[23], chunk[24]]);
    if crc32fast::hash(&chunk[4..21]) != expected {
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

#[derive(Debug, Deserialize)]
pub struct ReadRequest {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "userInitiated")]
    pub user_initiated: bool,
}

#[derive(Debug, Deserialize)]
pub struct PersistRequest {
    pub data: String,
}

#[derive(Debug, Serialize)]
pub struct ReadResponse {
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

/// A PNG read for the view of a surface, which the main page makes for a view call.
#[derive(Debug, Deserialize)]
pub struct ViewReadRequest {
    pub surface: String,
    #[serde(rename = "userInitiated")]
    pub user_initiated: bool,
}

/// A persist of the PNG that the binary store of the view of a surface keeps under the id `binary`.
#[derive(Debug, Deserialize)]
pub struct ViewPersistRequest {
    pub surface: String,
    pub binary: String,
}

/// The answer of a PNG read for a view: `binary` is the id of the PNG in the binary store of the view, and an absent PNG has no id.
#[derive(Debug, PartialEq, Serialize)]
pub struct ViewReadResponse {
    pub present: bool,
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
}

/// Answers a PNG read for a view from the value that the clipboard holds: a clipboard without a PNG answers an absent PNG and puts
/// nothing, a PNG over the limit is refused, and a PNG within the limit is put as image/png into the binary store of the view of surface
/// through put, which mints its id, and answered as a present PNG that names the id (docs/spec/plugin-processes.md#binary-path). The caller
/// must satisfy the thread precondition of the supplied native put.
pub fn put_view_png(
    documents: &crate::documents::Documents,
    surface: &str,
    value: ClipboardValue,
    put: impl FnOnce(usize, &[u8], &str) -> Result<String, String>,
) -> Result<ViewReadResponse, String> {
    match value {
        ClipboardValue::Absent => Ok(ViewReadResponse {
            present: false,
            kind: "png",
            binary: None,
        }),
        ClipboardValue::Png(bytes) => {
            if bytes.len() > MAX_BYTES {
                return Err("clipboard PNG exceeds 16 MiB".into());
            }
            Ok(ViewReadResponse {
                present: true,
                kind: "png",
                binary: Some(crate::documents::put_view_binary_of(
                    documents,
                    surface,
                    &bytes,
                    "image/png",
                    put,
                )?),
            })
        }
        other => Err(format!("the clipboard PNG read returned {other:?}")),
    }
}

/// Takes the bytes of the PNG of a view through take and persists them under root, and returns the path of the file.
pub fn persist_view_png_at(
    root: &Path,
    take: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    persist_png_at(root, &take()?)
}

/// Answers the PNG read of a view call: the host puts the PNG of the clipboard into the binary store of the view of the request and
/// answers its id (docs/spec/native-surfaces.md#view-surfaces, view calls).
pub fn read_view_png(
    window: &Window,
    request: ViewReadRequest,
) -> Result<ViewReadResponse, String> {
    validate_read_request("png", request.user_initiated)?;
    let data = crate::windows::window_data(window)?;
    let surface = request.surface;
    exposure::on_main(window, move || {
        let platform = platform::current()?;
        put_view_png(
            &data.documents,
            &surface,
            platform.clipboard_read("png")?,
            |handle, bytes, kind| platform.put_document_binary(handle, bytes, kind),
        )
    })
}

/// Answers the persistPNG of a view call: the host takes the PNG from the binary store of the view of the request on the main thread and
/// persists it (docs/spec/native-surfaces.md#view-surfaces, view calls).
pub fn persist_view_png(
    app: &AppHandle,
    window: &Window,
    request: ViewPersistRequest,
) -> Result<String, String> {
    let root = crate::config_directory(app).map_err(|e| e.to_string())?;
    let data = crate::windows::window_data(window)?;
    let ViewPersistRequest { surface, binary } = request;
    persist_view_png_at(&root, || {
        exposure::on_main(window, move || {
            let platform = platform::current()?;
            crate::documents::take_view_binary_of(
                &data.documents,
                &surface,
                &binary,
                |handle, id| platform.take_document_binary(handle, id),
            )
        })
    })
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

pub fn read(window: &Window, request: ReadRequest) -> Result<ReadResponse, String> {
    validate_read_request(&request.kind, request.user_initiated)?;
    let kind = request.kind;
    let read_kind = kind.clone();
    let value = exposure::on_main(window, move || {
        platform::current()?.clipboard_read(&read_kind)
    })?;
    Ok(response(value, &kind))
}

pub fn write_text(window: &Window, text: String) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("clipboard text exceeds 16 MiB".into());
    }
    exposure::on_main(window, move || {
        platform::current()?.clipboard_write_text(&text)
    })
}

pub fn persist_png(app: &AppHandle, data: String) -> Result<String, String> {
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
    // tempfile creates a new file with a name that does not collide, with permission 0600 so that only the owner reads
    // and writes it.
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
        // The signature and IHDR of a 1x1 RGBA PNG. The following bytes are not checked, so they are used to tell the
        // two files apart.
        let png: Vec<u8> = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89,
        ]
        .to_vec();
        let other = [png.as_slice(), b"other"].concat();
        let root = crate::test_folder::Folder::new();
        let first = persist_png_at(root.path(), &png).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), png);
        let permissions = std::fs::metadata(&first).unwrap().permissions();
        let mode = std::os::unix::fs::PermissionsExt::mode(&permissions);
        assert_eq!(mode & 0o777, 0o600, "clipboard image mode {mode:o}");
        // The second save creates a new file and does not overwrite the first file.
        let second = persist_png_at(root.path(), &other).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), png);
        assert_eq!(std::fs::read(&second).unwrap(), other);
    }
}
