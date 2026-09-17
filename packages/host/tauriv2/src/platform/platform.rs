//! 호스트가 사용하는 플랫폼 기능의 인터페이스와 현재 운영체제 구현의 선택.
//!
//! 운영체제별 코드는 이 디렉터리 아래 `<os>/` 에만 둔다. 다른 파일은 [`current`] 가 반환하는
//! [`Platform`] 으로만 네이티브 기능을 호출한다.

use std::fs::Metadata;
use std::path::Path;

use tauri::webview::PlatformWebview;
use tauri::{AppHandle, WebviewWindowBuilder, Window, Wry};

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
mod darwin;

#[cfg(windows)]
#[path = "windows/windows.rs"]
mod windows;

/// 네이티브 창, 뷰, 입력 감시기를 가리키는 주소.
pub type Handle = usize;

/// x, y, 너비, 높이 순서의 사각형.
pub type Frame = (f64, f64, f64, f64);

/// 프로젝트 창 생성기.
pub type WindowBuilder<'a> = WebviewWindowBuilder<'a, Wry, AppHandle<Wry>>;

/// 운영체제가 제공하는 창, 웹뷰, 표면 배치, 도형, 입력, 캡처, Dock, 디렉터리 식별 기능.
///
/// 구현하지 않은 기능은 "not implemented" 오류를 반환한다.
pub trait Platform: Send + Sync {
    // 창

    /// 프로젝트 창 생성기에 운영체제별 창 설정을 적용한다.
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String>;
    /// 창의 네이티브 주소를 반환한다.
    fn window_handle(&self, window: &Window) -> Result<Handle, String>;
    /// 창 버튼을 창 왼쪽 위 기준 x, y 에 배치한다.
    fn place_window_controls(&self, window: Handle, x: f64, y: f64) -> Result<(), String>;
    /// 창 버튼이 차지하는 영역을 페이지 좌표로 반환한다.
    fn window_controls(&self, window: Handle) -> Result<Frame, String>;
    /// 창 서버가 창과 창에 붙은 창에 부여한 번호를 반환한다.
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String>;
    /// 네이티브 상태 조회 요청을 실행하고 응답 줄을 reply 에 전달한다.
    fn probe(&self, window: Handle, request: &str, reply: fn(String)) -> Result<(), String>;
    /// 창이 모두 닫혀도 애플리케이션을 유지하는지 반환한다.
    fn stays_open_without_windows(&self) -> bool;

    // 웹뷰

    /// 창 좌표의 사각형을 웹뷰의 부모 좌표로 변환해 배치한다.
    fn place_webview(&self, view: &PlatformWebview, x: f64, y: f64, w: f64, h: f64) -> Result<(), String>;
    /// 웹뷰의 현재 위치와 크기를 페이지 좌표로 반환한다.
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String>;
    /// 표면 웹뷰를 main 웹뷰의 표면 컨테이너에 등록한다.
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String>;
    /// 웹뷰의 불투명도를 설정한다.
    fn set_alpha(&self, view: &PlatformWebview, alpha: f64) -> Result<(), String>;
    /// 연속적인 크기 변경의 시작과 종료를 웹뷰에 전달한다.
    fn set_live_resize(&self, view: &PlatformWebview, live: bool) -> Result<(), String>;
    /// 웹뷰를 같은 부모의 다른 뷰 위로 올린다.
    fn raise_webview(&self, view: &PlatformWebview) -> Result<(), String>;
    /// 웹뷰의 모서리를 radius 논리 픽셀만큼 둥글게 자른다.
    fn round_corners(&self, view: &PlatformWebview, radius: f64) -> Result<(), String>;
    /// 입력 체인에서 웹뷰를 식별하는 뷰 주소를 반환한다.
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String>;

    // 표면 배치

    /// 창의 표면 배치 트랜잭션 ticket 을 시작하고 시작 허용 여부를 ready 에 전달한다.
    fn begin_layout(&self, window: Handle, ticket: u64, ready: Box<dyn Fn(bool)>) -> Result<(), String>;
    /// 표면 배치 트랜잭션 ticket 을 확정하고 확정 여부를 반환한다.
    fn commit_layout(&self, window: Handle, ticket: u64) -> Result<bool, String>;
    /// 창의 진행 중인 표면 배치 트랜잭션을 취소한다.
    fn cancel_layout(&self, window: Handle) -> Result<(), String>;
    /// 메인 문서와 표시 중인 문서의 렌더링이 끝난 뒤 done 을 호출한다.
    fn after_presentation(&self, view: &PlatformWebview, done: Box<dyn Fn()>) -> Result<(), String>;

    // 도형

    /// 창 콘텐츠 뷰에 도형 뷰를 만들고 주소를 반환한다. 만들지 못하면 0 을 반환한다.
    fn create_shape(&self, window: Handle, frame: Frame) -> Result<Handle, String>;
    /// 도형 뷰를 배치하고 형제 뷰 위로 올린다.
    fn place_shape(&self, shape: Handle, frame: Frame) -> Result<(), String>;
    /// 도형의 모서리 반경, 선 두께, 채움 색, 선 색을 설정한다. 색은 0-1 범위의 RGBA 이다.
    fn style_shape(&self, shape: Handle, radius: f64, line_width: f64, fill: [f64; 4], line: [f64; 4]) -> Result<(), String>;
    /// 도형 뷰를 제거한다.
    fn destroy_shape(&self, shape: Handle) -> Result<(), String>;

    // 입력

    /// 웹뷰를 공통 포인터 라우팅에 등록하고 등록 여부를 반환한다.
    fn register_input(&self, view: &PlatformWebview) -> Result<bool, String>;
    /// 창의 입력을 감시하고 감시기 주소를 반환한다.
    ///
    /// pressed 는 입력을 받은 뷰부터 콘텐츠 뷰까지의 주소 목록을 받고, 입력이 이 앱의 뷰에
    /// 있으면 true 를 반환한다. pointed 는 그 뷰에서 시작한 왼쪽 버튼 드래그의 단계
    /// (0 누름, 1 이동, 2 놓음)와 콘텐츠 뷰 위쪽 기준 좌표를 받는다.
    fn watch_input(
        &self,
        window: Handle,
        pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
        pointed: Box<dyn Fn(u8, f64, f64)>,
    ) -> Result<Handle, String>;
    /// 입력 감시기를 제거한다.
    fn unwatch_input(&self, monitor: Handle) -> Result<(), String>;

    // 캡처

    /// 창 번호의 창을 캡처 대상으로 준비한다.
    fn capture_open(&self, window_number: isize) -> Result<(), String>;
    /// directory 에 프레임 기록을 시작한다.
    fn capture_start(&self, directory: &str) -> Result<(), String>;
    /// 첫 프레임을 기다리고 기록 여부를 반환한다.
    fn capture_wait(&self) -> Result<bool, String>;
    /// 기록을 끝내고 기록한 프레임 수를 반환한다.
    fn capture_stop(&self) -> Result<i32, String>;

    // Dock

    /// Dock 메뉴에 새 창 항목을 설치한다. 항목을 선택하면 new_window 를 호출한다.
    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String>;

    // 디렉터리 식별

    /// 같은 디렉터리를 가리키는 경로에 같은 값을 반환한다.
    fn directory_identity(&self, path: &Path, metadata: &Metadata) -> Result<String, String>;
}

/// 현재 운영체제의 구현을 반환한다.
pub fn current() -> Result<&'static dyn Platform, String> {
    #[cfg(target_os = "macos")]
    return Ok(&darwin::Darwin);
    #[cfg(windows)]
    return Ok(&windows::Windows);
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("no platform implementation is registered".into())
}
