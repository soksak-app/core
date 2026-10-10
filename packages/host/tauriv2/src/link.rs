//! Opens a link in the default application of the user. It opens only absolute http, https and mailto URLs.

use serde::Deserialize;
use tauri::Window;

use crate::exposure;
use crate::platform;

/// The maximum number of characters of a URL that can be opened.
const MAX_LENGTH: usize = 8192;

#[derive(Debug, Deserialize)]
pub(crate) struct OpenRequest {
    pub url: String,
}

/// Allows only absolute http, https and mailto URLs.
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
