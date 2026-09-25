//! 사용자의 기본 애플리케이션으로 링크를 연다. 절대 http, https, mailto URL 만 연다.

use serde::Deserialize;
use tauri::Window;

use crate::exposure;
use crate::platform;

/// 열 수 있는 URL 의 최대 글자 수.
const MAX_LENGTH: usize = 8192;

#[derive(Debug, Deserialize)]
pub(crate) struct OpenRequest {
    pub url: String,
}

/// 절대 http, https, mailto URL 만 허용한다.
pub fn validate_link(value: &str) -> Result<(), String> {
    if value.chars().count() > MAX_LENGTH {
        return Err(format!("link URL is longer than {MAX_LENGTH} characters"));
    }
    let parsed =
        url::Url::parse(value).map_err(|error| format!("link URL does not parse: {error}"))?;
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host_str().is_none_or(str::is_empty) {
                return Err(format!("link URL {value:?} has no host"));
            }
        }
        "mailto" => {
            if parsed.path().is_empty() {
                return Err(format!("link URL {value:?} has no address"));
            }
        }
        scheme => return Err(format!("link URL scheme {scheme:?} is not opened")),
    }
    Ok(())
}

pub(crate) fn open(window: &Window, request: OpenRequest) -> Result<(), String> {
    validate_link(&request.url)?;
    let url = request.url;
    exposure::on_main(window, move || platform::current()?.open_link(&url))
}
