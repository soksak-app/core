//! main page 의 시작 문서(docs/spec/native-host.md#page-start). page 는 첫 화면을 첫 await 전에 그리도록 이 문서를
//! module graph 로 가져오고, host 는 이 요청에 답하기 전에 page 를 시작한다.

use serde_json::Value;
use tauri::http::Response;
use tauri::{AppHandle, Manager};

use crate::application_log::log_error;

/// The scheme of application documents inside webviews (docs/spec/native-host.md#application-addresses). A custom
/// scheme handler, which knows the requesting webview, answers the start document at sok://core/start.json.
pub const SCHEME: &str = "sok";

/// The owner of core documents in sok addresses.
pub const CORE: &str = "core";

/// main page 가 시작 문서를 가져오는 경로.
pub const START_DOCUMENT_PATH: &str = "/start.json";

/// main page 의 origin. page 는 다른 scheme 의 문서를 CORS 로 가져온다.
pub const PAGE_ORIGIN: &str = "tauri://localhost";

/// 요청한 webview 가 어떤 창의 main webview 도 아닐 때의 오류.
pub const NO_WINDOW: &str = "the start document request names no window";

/// 작업 공간 스냅샷과 창 단추 응답을 담은 시작 문서.
pub fn start_document(workspace: &Value, controls: &Value) -> Result<Vec<u8>, String> {
    #[derive(serde::Serialize)]
    struct Document<'a> {
        workspace: &'a Value,
        controls: &'a Value,
    }
    serde_json::to_vec(&Document {
        workspace,
        controls,
    })
    .map_err(|error| error.to_string())
}

/// Passes a start document request to start with the label of the requesting webview. Another owner or path is not
/// found. When no window is found, it starts no page and answers 400; another failure answers 500.
pub fn serve(
    owner: &str,
    path: &str,
    webview: &str,
    start: &mut dyn FnMut(&str) -> Result<Vec<u8>, String>,
) -> Response<Vec<u8>> {
    let failure = |status: u16, text: String| {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Access-Control-Allow-Origin", PAGE_ORIGIN)
            .body(format!("{text}\n").into_bytes())
            // 기본값: 고정된 상태와 헤더로 만든 응답은 실패하지 않으며, 실패하면 빈 500 응답을 쓴다.
            .unwrap_or_else(|_| Response::new(vec![]))
    };
    if owner != CORE || path != START_DOCUMENT_PATH {
        return failure(404, format!("{SCHEME}://{owner}{path} not found"));
    }
    match start(webview) {
        Ok(data) => Response::builder()
            .status(200)
            .header("Content-Type", "application/json")
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", PAGE_ORIGIN)
            .body(data)
            // 기본값: 응답을 만들지 못한 시작 문서는 그 오류를 기록하고 500 으로 답한다.
            .unwrap_or_else(|error| {
                log_error(START_DOCUMENT_PATH, &error);
                failure(500, error.to_string())
            }),
        Err(error) => {
            log_error(START_DOCUMENT_PATH, &error);
            failure(if error == NO_WINDOW { 400 } else { 500 }, error)
        }
    }
}

/// webview 가 main webview 인 창의 main page 를 시작하고 그 창의 시작 문서를 만든다. 답하기 전에 창을 준비되지 않은
/// 상태로 두고, 이전 페이지에 보낸 요청을 끝내고, 이전 페이지의 표면 문서와 그림 영역과 모달을 정리한다.
pub(crate) fn start_page(app: &AppHandle, webview: &str) -> Result<Vec<u8>, String> {
    let window = app
        .get_window(webview)
        .filter(|window| window.label() == webview)
        .ok_or_else(|| NO_WINDOW.to_string())?;
    crate::windows::page_started(&window)?;
    let snapshot = crate::workspace::handle(
        app,
        serde_json::from_value(serde_json::json!({ "kind": "snapshot" }))
            .map_err(|error| error.to_string())?,
    )?;
    // 페이지의 첫 그리기는 준비를 기다리지 않으므로 제목줄을 그 첫 행의 높이로 먼저 정하고 controls 를 읽는다
    // (docs/spec/native-surfaces.md#title-bar-height).
    let common = snapshot
        .get("common")
        .filter(|common| common.is_object())
        .ok_or("the workspace snapshot has no common settings")?;
    crate::windows::start_titlebar(&window, common)?;
    let controls = serde_json::to_value(crate::windows::window_chrome(&window)?)
        .map_err(|error| error.to_string())?;
    start_document(&snapshot, &controls)
}
