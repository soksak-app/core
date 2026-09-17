//! 페이지가 호출하는 Tauri 명령과 명령 등록.
//!
//! 각 명령은 역할별 모듈의 함수를 호출한다. 명령 이름과 인자 이름은 페이지 런타임
//! (`apps/tauriv2/runtime/index.js`)의 호출과 일치해야 한다.

use serde_json::value::RawValue;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, Window};

use crate::modals::{self, OverlayContent, OverlayRequest, PlaceRequest, UpdateRequest};
use crate::projects::{self, CreateProject, Folder};
use crate::shapes::{self, ShapeRequest};
use crate::sidecars::WindowSidecars;
use crate::surfaces::{self, Placement, PresentRequest, PreparedSurfaces, Rect, SyncRequest};
use crate::theme::{self, Theme};
use crate::windows::{self, Geometry, OpenProject};
use crate::{diagnostics, workspace};

/// 모든 명령을 등록하는 핸들러를 반환한다.
pub(crate) fn handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        project_folder,
        project_open,
        project_release,
        window_state,
        window_ready,
        window_close,
        window_new,
        workspace,
        folder_choose,
        project_create,
        sync_surfaces,
        present_surfaces,
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
        theme,
        set_theme,
        report
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

/// 창의 위치와 크기를 반환한다.
#[tauri::command]
fn window_state(window: Window) -> Result<Option<Geometry>, String> {
    windows::window_state(&window)
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
async fn present_surfaces(window: Window, request: PresentRequest) -> Result<Vec<Placement>, String> {
    surfaces::present(window, request).await
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

/// 모달 문서가 그릴 내용을 반환한다.
#[tauri::command]
fn overlay_content(window: Window, id: String, instance: u64) -> Result<OverlayContent, String> {
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
fn overlay_pick(window: Window, id: String, instance: u64, key: String, value: String) -> Result<(), String> {
    modals::pick(&window, id, instance, key, value)
}

/// 창 버튼이 차지하는 영역을 반환한다.
#[tauri::command]
fn window_controls(window: Window) -> Result<Rect, String> {
    windows::window_controls(&window)
}

/// 표면 페이지가 보낸 메시지를 사이드카에 전달한다.
#[tauri::command]
fn sidecar_send(window: Window, sidecar: String, surface: String, body: Box<RawValue>) -> Result<(), String> {
    window.state::<WindowSidecars>().send(&window, &sidecar, &surface, &body)
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

/// 페이지 자체 검사가 보낸 한 줄을 애플리케이션 로그에 기록한다. 페이지에는 쓸 파일이 없고,
/// 디버거 밖에서 실행할 때 페이지 콘솔은 읽지 않는다.
#[tauri::command]
fn report(line: String) {
    diagnostics::say(&line);
}
