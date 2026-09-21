use std::ffi::{c_char, c_void, CStr, CString};

use base64::Engine;
use serde_json::Value;

use super::super::ClipboardValue;

extern "C" {
    fn sp_clipboard_open(name: *const c_char) -> *mut c_void;
    fn sp_clipboard_close(clipboard: *mut c_void);
    fn sp_clipboard_read_text(clipboard: *mut c_void) -> *mut c_char;
    fn sp_clipboard_write_text(clipboard: *mut c_void, text: *const c_char) -> *mut c_char;
    fn sp_clipboard_read_png(clipboard: *mut c_void) -> *mut c_char;
    fn sp_clipboard_write_png(
        clipboard: *mut c_void,
        bytes: *const u8,
        length: usize,
    ) -> *mut c_char;
    fn sp_clipboard_read_file_urls(clipboard: *mut c_void) -> *mut c_char;
    fn free(pointer: *mut c_void);
}

fn response(pointer: *mut c_char) -> Result<Value, String> {
    if pointer.is_null() {
        return Err("clipboard native call returned null".into());
    }
    let text = unsafe { CStr::from_ptr(pointer) }.to_str().map_err(|e| e.to_string())?.to_owned();
    unsafe { free(pointer.cast()) };
    serde_json::from_str(&text).map_err(|e| format!("invalid clipboard response: {e}"))
}

fn with_clipboard<T>(work: impl FnOnce(*mut c_void) -> Result<T, String>) -> Result<T, String> {
    let clipboard = unsafe { sp_clipboard_open(std::ptr::null()) };
    if clipboard.is_null() {
        return Err("cannot open system clipboard".into());
    }
    let result = work(clipboard);
    unsafe { sp_clipboard_close(clipboard) };
    result
}

fn parse_read(value: Value, kind: &str) -> Result<ClipboardValue, String> {
    match value.get("status").and_then(Value::as_str) {
        Some("absent") => Ok(ClipboardValue::Absent),
        Some("error") => Err(value.get("error").and_then(Value::as_str).unwrap_or("clipboard read failed").into()),
        Some("ok") => match kind {
            "text" => Ok(ClipboardValue::Text(value.get("text").and_then(Value::as_str).ok_or("clipboard text is missing")?.into())),
            "png" => {
                let encoded = value.get("base64").and_then(Value::as_str).ok_or("clipboard PNG is missing")?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|e| e.to_string())?;
                if bytes.len() > 16 * 1024 * 1024 { return Err("clipboard PNG exceeds 16 MiB".into()); }
                Ok(ClipboardValue::Png(bytes))
            }
            "fileURLs" => Ok(ClipboardValue::FileUrls(value.get("urls").and_then(Value::as_array).ok_or("clipboard file URLs are missing")?.iter().map(|url| url.as_str().map(str::to_owned).ok_or("clipboard file URL is invalid")).collect::<Result<_, _>>()?)),
            _ => Err(format!("unsupported clipboard type {kind}")),
        },
        _ => Err("invalid clipboard status".into()),
    }
}

pub fn read(kind: &str) -> Result<ClipboardValue, String> {
    let value = with_clipboard(|clipboard| {
        let pointer = match kind {
            "text" => unsafe { sp_clipboard_read_text(clipboard) },
            "png" => unsafe { sp_clipboard_read_png(clipboard) },
            "fileURLs" => unsafe { sp_clipboard_read_file_urls(clipboard) },
            _ => return Err(format!("unsupported clipboard type {kind}")),
        };
        response(pointer)
    })?;
    parse_read(value, kind)
}

fn write_response(pointer: *mut c_char) -> Result<(), String> {
    let value = response(pointer)?;
    match value.get("status").and_then(Value::as_str) {
        Some("ok") => Ok(()),
        Some("error") => Err(value.get("error").and_then(Value::as_str).unwrap_or("clipboard write failed").into()),
        _ => Err("clipboard write was not accepted".into()),
    }
}

pub fn write_text(text: &str) -> Result<(), String> {
    let text = CString::new(text).map_err(|_| "clipboard text contains NUL".to_string())?;
    with_clipboard(|clipboard| write_response(unsafe { sp_clipboard_write_text(clipboard, text.as_ptr()) }))
}

pub fn write_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 16 * 1024 * 1024 { return Err("clipboard PNG exceeds 16 MiB".into()); }
    with_clipboard(|clipboard| write_response(unsafe { sp_clipboard_write_png(clipboard, bytes.as_ptr(), bytes.len()) }))
}
