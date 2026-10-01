//! 페이지가 호출하는 Tauri 명령과 명령 등록.
//!
//! 각 명령은 역할별 모듈의 함수를 호출한다. 명령 이름과 인자 이름은 페이지 런타임
//! (`apps/tauriv2/runtime/index.js`)의 호출과 일치해야 한다.

use serde_json::value::RawValue;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, Webview, Window};

use crate::clipboard;
use crate::composition;
use crate::documents;
use crate::exposure::{self, Changed, Forward, Register};
use crate::images;
use crate::link;
use crate::menu;
use crate::modals::{self, OverlayRequest, PlaceRequest, RevisedContent, UpdateRequest};
use crate::projects::{self, CreateProject, Folder};
use crate::shapes::{self, ShapeRequest};
use crate::sidecars::WindowSidecars;
use crate::surfaces::{self, Placement, PreparedSurfaces, PresentRequest, Rect, SyncRequest};
use crate::theme::{self, Theme};
use crate::windows::{self, Geometry, OpenProject};
use crate::workspace;

/// 모든 명령을 등록하는 핸들러를 반환한다.
pub(crate) fn handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        project_folder,
        project_open,
        project_release,
        window_state,
        performance,
        page_started,
        window_ready,
        window_close,
        window_new,
        workspace,
        folder_choose,
        project_create,
        sync_surfaces,
        present_surfaces,
        wait_presented,
        overlay_show,
        overlay_place,
        set_shape,
        clear_shape,
        overlay_content,
        overlay_update,
        overlay_ready,
        overlay_hide,
        overlay_pick,
        window_controls,
        sidecar_send,
        sidecars_retain,
        theme,
        set_theme,
        set_menu_language,
        report,
        exposure_reply,
        exposure_changed,
        exposure_forward,
        exposure_register,
        document_attach,
        composition_declare,
        document_load,
        document_zoom,
        document_go,
        document_detach,
        image_attach,
        composition_place,
        image_focus,
        image_caret,
        image_text,
        image_detach,
        clipboard_read,
        clipboard_write_text,
        clipboard_persist_png,
        link_open,
        notify,
        notification_remove,
        notification_state
    ]
}

/// 경로를 프로젝트 디렉터리로 확인하고 정규 경로와 식별값을 반환한다.
#[tauri::command(async)]
fn project_folder(app: AppHandle, root: String) -> Result<Folder, String> {
    projects::project_folder(&app, root)
}

/// 프로젝트를 창에 연다.
#[tauri::command(async)]
fn project_open(window: Window, request: OpenProject) -> Result<serde_json::Value, String> {
    windows::project_open(&window, request)
}

/// 프로젝트와 창의 연결을 해제한다.
#[tauri::command]
fn project_release(window: Window, id: String) -> Result<(), String> {
    windows::project_release(&window, id)
}

/// 성능 트레이스를 켜고 끄고 페이지 줄을 중계한다(V5-104).
#[tauri::command(async)]
fn performance(window: Window, request: serde_json::Value) -> Result<serde_json::Value, String> {
    crate::performance::command(
        window.state::<crate::workspace::Workspace>().directory(),
        request,
    )
}

/// 창의 위치와 크기를 반환한다.
#[tauri::command]
fn window_state(window: Window) -> Result<Option<Geometry>, String> {
    windows::window_state(&window)
}

/// 메인 페이지가 등록하거나 표면을 올리기 전에 부른다. 답하기 전에 이전 페이지의 상태를 정리한다.
#[tauri::command]
fn page_started(window: Window) -> Result<(), String> {
    windows::page_started(&window)
}

/// 페이지가 창 닫기 요청을 처리할 준비가 되었음을 기록한다.
#[tauri::command]
fn window_ready(window: Window) -> Result<(), String> {
    windows::window_ready(&window)
}

/// 창을 닫는다.
#[tauri::command]
fn window_close(window: Window) -> Result<(), String> {
    windows::window_close(&window)
}

/// 새 프로젝트 창을 연다.
#[tauri::command(async)]
fn window_new(app: AppHandle) -> Result<(), String> {
    windows::window_new(app)
}

/// 설정과 프로젝트 목록 저장소 요청을 실행한다.
#[tauri::command(async)]
fn workspace(app: AppHandle, request: workspace::Request) -> Result<serde_json::Value, String> {
    workspace::handle(&app, request)
}

/// 프로젝트 폴더 선택 대화상자를 연다.
#[tauri::command(async)]
fn folder_choose(window: Window) -> Result<Option<String>, String> {
    projects::folder_choose(&window)
}

/// 프로젝트 폴더를 만든다.
#[tauri::command(async)]
fn project_create(app: AppHandle, request: CreateProject) -> Result<Folder, String> {
    projects::project_create(&app, request)
}

/// 페이지가 선언한 표면에 창의 자식 웹뷰를 맞춘다.
#[tauri::command(async)]
fn sync_surfaces(window: Window, request: SyncRequest) -> Result<PreparedSurfaces, String> {
    surfaces::sync(&window, request)
}

/// DOM 이 그린 표면 준비의 표시를 확인한다.
#[tauri::command]
async fn present_surfaces(
    window: Window,
    request: PresentRequest,
) -> Result<Vec<Placement>, String> {
    surfaces::present(window, request).await
}

/// 마지막 안정 프레임의 DOM과 네이티브 래스터 표시를 기다린다.
#[tauri::command]
async fn wait_presented(window: Window) -> Result<f64, String> {
    exposure::presented(&window, exposure::TIMEOUT).map_err(|error| error.message)
}

/// 모달 요소를 메인 창 안의 웹뷰에 그린다.
#[tauri::command]
fn overlay_show(window: Window, request: OverlayRequest) -> Result<Rect, String> {
    modals::show(&window, request)
}

/// 열린 모달의 웹뷰를 옮긴다.
#[tauri::command]
fn overlay_place(window: Window, request: PlaceRequest) -> Result<Rect, String> {
    modals::place(&window, request)
}

/// 도형을 그리거나 갱신한다.
#[tauri::command]
fn set_shape(window: Window, request: ShapeRequest) -> Result<(), String> {
    shapes::set(&window, request)
}

/// 도형을 제거한다.
#[tauri::command]
fn clear_shape(window: Window, id: String) -> Result<(), String> {
    shapes::clear(&window, id)
}

/// 모달 문서가 그릴 내용을 반환한다. 메인 스레드가 필요 없다.
#[tauri::command(async)]
fn overlay_content(window: Window, id: String, instance: u64) -> Result<RevisedContent, String> {
    modals::content(&window, id, instance)
}

/// 열린 모달의 내용을 바꾼다.
#[tauri::command]
fn overlay_update(window: Window, request: UpdateRequest) -> Result<(), String> {
    modals::update(&window, request)
}

/// 모달 문서의 렌더링 완료를 받아 모달 웹뷰를 표시한다.
#[tauri::command]
fn overlay_ready(window: Window, id: String, instance: u64) -> Result<(), String> {
    modals::ready(&window, id, instance)
}

/// 모달을 닫는다.
#[tauri::command]
fn overlay_hide(window: Window, id: String) -> Result<(), String> {
    modals::hide(&window, id)
}

/// 모달 문서의 선택을 페이지에 전달한다.
#[tauri::command]
fn overlay_pick(
    window: Window,
    id: String,
    instance: u64,
    key: String,
    value: String,
) -> Result<(), String> {
    modals::pick(&window, id, instance, key, value)
}

/// 창 버튼이 차지하는 영역을 반환한다.
#[tauri::command]
fn window_controls(window: Window) -> Result<windows::Chrome, String> {
    windows::window_chrome(&window)
}

/// 표면 페이지가 보낸 메시지를 사이드카에 전달한다.
#[tauri::command]
fn sidecar_send(
    window: Window,
    sidecar: String,
    surface: String,
    body: Box<RawValue>,
) -> Result<(), String> {
    window
        .state::<WindowSidecars>()
        .send(&window, &sidecar, &surface, &body)
}

/// retain 요청의 표면 하나. 표면과 그 표면을 연 프로젝트 루트다.
#[derive(serde::Deserialize)]
struct RetainedSurface {
    surface: String,
    root: String,
}

/// 모든 프로젝트 레이아웃이 가진 표면 목록.
#[derive(serde::Deserialize)]
struct RetainRequest {
    surfaces: Vec<RetainedSurface>,
}

/// 영속 사이드카 서비스에서 어떤 레이아웃에도 없는 표면의 세션을 닫고 닫은 수를 반환한다
/// (docs/spec/terminal-runtime.md). 서비스를 기다리므로 async 명령이다.
#[tauri::command(async)]
fn sidecars_retain(window: Window, request: RetainRequest) -> Result<serde_json::Value, String> {
    let surfaces: Vec<(String, String)> = request
        .surfaces
        .into_iter()
        .map(|item| {
            if item.surface.is_empty() || item.root.is_empty() {
                Err("retain surface entry is invalid".to_string())
            } else {
                Ok((item.surface, item.root))
            }
        })
        .collect::<Result<_, _>>()?;
    let closed = window
        .state::<WindowSidecars>()
        .retain_sessions(&surfaces)?;
    Ok(serde_json::json!({ "closed": closed }))
}

/// 현재 테마를 반환한다.
#[tauri::command]
fn theme(window: Window) -> Result<Theme, String> {
    theme::get(&window)
}

/// 페이지의 현재 테마를 기록하고 다른 페이지에 전달한다.
#[tauri::command]
fn set_theme(window: Window, theme: Theme) -> Result<(), String> {
    theme::set(&window, theme)
}

/// 페이지가 유효 메뉴 언어를 알린다. 표의 언어가 아니면 명시적인 오류이고 언어가 같으면
/// 메뉴를 다시 만들지 않는다(docs/spec/host-contract.md 의 Application menu).
#[tauri::command]
fn set_menu_language(app: AppHandle, language: String) -> Result<(), String> {
    menu::set_language(&app, &language)
}

/// 페이지 자체 검사가 보낸 한 줄을 표준 오류와 창의 기록을 요청한 연결에 보낸다. 페이지에는 쓸
/// 파일이 없고, 디버거 밖에서 실행할 때 페이지 콘솔은 읽지 않는다.
#[tauri::command]
fn report(window: Window, line: String) {
    eprintln!("{line}");
    exposure::log(&window, &line);
}

/// 호스트가 보낸 요청에 대한 문서의 응답을 받는다.
#[tauri::command]
fn exposure_reply(webview: Webview, request: String) -> Result<(), String> {
    exposure::reply(&webview, request)
}

/// 메인 페이지가 보낸 상태 변경을 감시하는 연결에 보낸다.
#[tauri::command]
fn exposure_changed(webview: Webview, request: Changed) -> Result<(), String> {
    exposure::changed(&webview, request)
}

/// 메인 페이지의 요청을 표면 페이지에 보내고 응답을 반환한다.
#[tauri::command(async)]
fn exposure_forward(
    webview: Webview,
    request: Forward,
) -> Result<Box<serde_json::value::RawValue>, String> {
    exposure::forward(&webview, request)
}

/// 표면 페이지의 항목 등록을 메인 페이지에 전달한다.
#[tauri::command]
fn exposure_register(webview: Webview, request: Register) -> Result<(), String> {
    exposure::register(&webview, request)
}

/// 호출한 표면 페이지의 요소에 문서 영역을 붙인다.
#[tauri::command(async)]
fn document_attach(webview: Webview, request: documents::Request) -> Result<(), String> {
    documents::attach(&webview, request)
}

/// native 배치 전에 surface의 불변 composition 선언을 등록한다.
#[tauri::command(async)]
fn composition_declare(
    webview: Webview,
    request: surfaces::CompositionDeclareRequest,
) -> Result<(), String> {
    surfaces::declare(&webview, request)
}

/// 호출한 표면 페이지의 완전한 합성 리비전을 배치한다.
#[tauri::command(async)]
fn composition_place(
    webview: Webview,
    request: composition::CompositionPlaceRequest,
) -> Result<(), String> {
    composition::place(&webview, request)
}

/// 문서 영역에 http 또는 https 주소를 연다.
#[tauri::command(async)]
fn document_load(webview: Webview, request: documents::Request) -> Result<(), String> {
    documents::load(&webview, request)
}

/// 문서 영역의 페이지 확대를 글자 배율로 정한다.
#[tauri::command(async)]
fn document_zoom(webview: Webview, request: documents::Request) -> Result<(), String> {
    documents::zoom(&webview, request)
}

/// 문서 영역의 기록 이동, 다시 읽기, 멈춤을 실행한다.
#[tauri::command(async)]
fn document_go(webview: Webview, request: documents::Request) -> Result<bool, String> {
    documents::go(&webview, request)
}

/// 문서 영역을 닫는다.
#[tauri::command(async)]
fn document_detach(webview: Webview, request: documents::Request) -> Result<(), String> {
    documents::detach(&webview, request)
}

/// 호출한 표면 페이지의 요소에 그림 영역을 붙인다.
#[tauri::command(async)]
fn image_attach(webview: Webview, request: images::Request) -> Result<(), String> {
    images::attach(&webview, request)
}

/// 그림 영역을 첫 응답자로 만들고 포커스 이벤트를 보낸다.
#[tauri::command(async)]
fn image_focus(webview: Webview, request: images::Request) -> Result<(), String> {
    images::focus(&webview, request)
}

/// 캐럿(입력 커서) 위치를 받아 둔다.
#[tauri::command(async)]
fn image_caret(
    webview: Webview,
    request: images::Request,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    images::caret(&webview, request, x, y, w, h)
}

/// 접근성 값으로 보일 문자열을 받아 둔다.
#[tauri::command(async)]
fn image_text(webview: Webview, request: images::Request, text: String) -> Result<(), String> {
    images::text(&webview, request, text)
}

/// 그림 영역을 닫는다.
#[tauri::command(async)]
fn image_detach(webview: Webview, request: images::Request) -> Result<(), String> {
    images::detach(&webview, request)
}

#[tauri::command(async)]
fn clipboard_read(
    window: Window,
    request: clipboard::ReadRequest,
) -> Result<clipboard::ReadResponse, String> {
    clipboard::read(&window, request)
}

#[tauri::command(async)]
fn link_open(window: Window, request: link::OpenRequest) -> Result<(), String> {
    link::open(&window, request)
}

/// 호출한 창의 탭 알림을 시스템 알림으로 게시한다.
#[tauri::command(async)]
fn notify(
    window: Window,
    request: crate::notifications::NotificationRequest,
) -> Result<(), String> {
    crate::notifications::notify(&window, request)
}

/// 호출한 창의 탭 알림을 지운다.
#[tauri::command(async)]
fn notification_remove(
    window: Window,
    request: crate::notifications::NotificationRequest,
) -> Result<(), String> {
    crate::notifications::remove(&window, request)
}

/// 알림 센터가 마지막으로 알린 권한 상태를 반환한다.
#[tauri::command(async)]
fn notification_state() -> Result<crate::notifications::NotificationState, String> {
    crate::notifications::state()
}

#[tauri::command(async)]
fn clipboard_write_text(window: Window, text: String) -> Result<(), String> {
    clipboard::write_text(&window, text)
}

#[tauri::command(async)]
fn clipboard_persist_png(
    app: AppHandle,
    request: clipboard::PersistRequest,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "path": clipboard::persist_png(&app, request.data)? }))
}
