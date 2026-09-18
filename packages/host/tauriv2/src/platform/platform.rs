//! 호스트가 사용하는 플랫폼 기능의 인터페이스와 현재 운영체제 구현의 선택.
//!
//! 운영체제별 코드는 이 디렉터리 아래 `<os>/` 에만 둔다. 다른 파일은 [`current`] 가 반환하는
//! [`Platform`] 으로만 네이티브 기능을 호출한다.

use std::fs::Metadata;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

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

/// 로컬 엔드포인트의 연결 하나.
pub trait Connection: Read + Write + Send {
    /// 같은 연결을 가리키는 다른 값을 반환한다. 읽기와 쓰기를 다른 스레드에서 실행할 때 사용한다.
    fn try_clone(&self) -> Result<Box<dyn Connection>, String>;
    /// 읽기 대기 시간을 설정한다. None 은 제한하지 않는다.
    fn set_read_timeout(&self, timeout: Option<Duration>) -> Result<(), String>;
    /// 연결의 읽기와 쓰기를 모두 닫는다.
    fn close(&self);
}

/// 로컬 엔드포인트의 수신 주소.
pub trait Listener: Send + Sync {
    /// 다음 연결을 기다린다.
    fn accept(&self) -> Result<Box<dyn Connection>, String>;
    /// endpoint.json 의 transport 값.
    fn transport(&self) -> &'static str;
    /// endpoint.json 의 address 값.
    fn address(&self) -> String;
    /// 주소가 만든 파일을 제거한다.
    fn remove(&self);
}

/// 네이티브 입력으로 전달하는 포인터 동작. 좌표는 콘텐츠 영역 왼쪽 위 기준 포인트 값이다.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pointer {
    pub x: f64,
    pub y: f64,
    /// 0 이동, 1 누름, 2 끌기, 3 뗌, 4 스크롤.
    pub phase: i32,
    /// 0 왼쪽, 1 오른쪽.
    pub button: i32,
    pub delta_x: f64,
    pub delta_y: f64,
    /// 이동 전에 애플리케이션을 활성화하고 창을 키 창으로 만든다. phase 가 0 일 때만 참이다.
    pub activate: bool,
}

/// 포인터 입력 전달 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// 창에 전달했다.
    Delivered,
    /// 창, 좌표, 단계가 올바르지 않다.
    Rejected,
    /// 버튼 없는 이동이며 창이 키 창이 아니다.
    Inactive,
    /// 누름이나 뗌을 전달했지만 문서가 제한 시간 안에 받지 않았다.
    Unreceived,
}

/// 네이티브 입력으로 전달하는 키 동작.
#[derive(Debug, Clone, PartialEq)]
pub struct Key {
    /// 키 이름 또는 문자 하나.
    pub key: String,
    /// 입력할 문자열. None 이면 key 를 사용한다.
    pub text: Option<String>,
    /// 비트 합: 1 Shift, 2 Control, 4 Option, 8 Command.
    pub modifiers: u32,
    pub down: bool,
}

/// 창 좌표의 한 점에 있는 뷰. chain 은 그 뷰부터 콘텐츠 뷰까지의 주소이고 identifier 는 그 뷰의
/// 식별자이다.
pub struct Hit {
    pub chain: Vec<Handle>,
    pub identifier: String,
}

/// 운영체제가 제공하는 창, 웹뷰, 표면 배치, 도형, 입력, 캡처, Dock, 디렉터리 식별, 엔드포인트 기능.
///
/// 구현하지 않은 기능은 "not implemented" 오류를 반환한다.
/// 표면 뷰포트의 CSS 픽셀 여백(왼쪽, 위, 오른쪽, 아래).
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(default)]
pub struct Insets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

pub trait Platform: Send + Sync {
    // 창

    /// 프로젝트 창 생성기에 운영체제별 창 설정을 적용한다.
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String>;
    /// 창의 네이티브 주소를 반환한다.
    fn window_handle(&self, window: &Window) -> Result<Handle, String>;
    /// 창을 전체 화면으로 바꾸거나 되돌리고, 전환이 끝나면 done 을 호출한다. 전환 중에 온 요청은
    /// 그 전환이 끝난 뒤에 처리한다.
    fn fullscreen(&self, window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String>;

    /// 창의 제목줄을 도구막대 높이로 만들고 그 높이(pt)를 반환한다. AppKit 이 그 높이의 세로 가운데에
    /// 창 단추를 두므로 호스트는 단추를 옮기지 않는다. 창에 단추가 없으면 오류를 반환한다.
    fn unified_titlebar(&self, window: Handle) -> Result<f64, String>;
    /// 창 버튼이 차지하는 영역을 페이지 좌표로 반환한다.
    fn window_controls(&self, window: Handle) -> Result<Frame, String>;
    #[cfg(feature = "diagnostics")]
    /// 창 서버가 창과 창에 붙은 창에 부여한 번호를 반환한다.
    fn window_numbers(&self, window: &Window) -> Result<Vec<isize>, String>;
    /// 창 좌표의 점에 있는 뷰를 반환한다. 메인 스레드에서 호출한다.
    fn hit(&self, window: Handle, x: f64, y: f64) -> Result<Hit, String>;
    /// 창의 프레임, 활성 상태, 창 버튼과 웹뷰를 JSON 으로 반환한다. 형식은
    /// native/darwin/src/window_facts.h 의 sp_window_facts 와 같다. 메인 스레드에서 호출한다.
    fn window_facts(&self, window: Handle) -> Result<Value, String>;
    /// 창 프레임의 왼쪽 위를 화면 좌표 (x, y) 로 옮긴다. 메인 스레드에서 호출한다.
    fn move_window(&self, window: Handle, x: f64, y: f64) -> Result<(), String>;
    /// 디스플레이 [{x, y, width, height, scale}] 를 화면 좌표로 반환한다. 메인 스레드에서 호출한다.
    fn screens(&self) -> Result<Value, String>;
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
    /// 웹뷰를 창의 첫 응답자로 만들어 키보드 입력을 받게 한다. 창이 거절하면 오류를 반환한다.
    fn focus_webview(&self, view: &PlatformWebview) -> Result<(), String>;

    // 문서 영역

    /// 표면 웹뷰 surface 안에 외부 문서 웹뷰를 숨긴 상태로 만든다. store 는 영구 데이터 저장소의
    /// 이름이다. changed 는 상태 JSON({url, title, loading, progress, canGoBack, canGoForward,
    /// error, scroll}) 을 메인 스레드에서 받는다. 메인 스레드에서 호출한다.
    fn create_document(&self, surface: Handle, store: &str, changed: Box<dyn Fn(String)>) -> Result<Handle, String>;
    /// http 또는 https 주소를 연다. 그 밖의 주소이면 false 를 반환한다. 메인 스레드에서 호출한다.
    fn load_document(&self, document: Handle, url: &str) -> Result<bool, String>;
    /// 뒤로 0, 앞으로 1, 다시 읽기 2, 멈춤 3 을 실행하고 실행했는지 반환한다. 메인 스레드에서 호출한다.
    fn go_document(&self, document: Handle, action: i32) -> Result<bool, String>;
    /// 표면 뷰포트의 CSS 픽셀 여백으로 문서 영역을 정한다. 메인 스레드에서 호출한다.
    fn place_document(&self, document: Handle, insets: Insets, visible: bool) -> Result<(), String>;
    /// 대화 상자가 열린 동안 문서를 흐리게 표시한다. 메인 스레드에서 호출한다.
    fn set_document_background(&self, document: Handle, enabled: bool) -> Result<(), String>;
    /// 문서 웹뷰를 제거한다. 이후 changed 는 호출되지 않는다. 메인 스레드에서 호출한다.
    fn close_document(&self, document: Handle) -> Result<(), String>;
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
    /// 창에 열린 표면 배치 트랜잭션이 없는 상태에서 메인 문서와 표시 중인 문서의 렌더링이 끝난 뒤 done 을
    /// 호출한다. 인자는 그 화면이 표시되는 시각(ms, mach 절대 시각)이다.
    fn after_settled(&self, view: &PlatformWebview, done: Box<dyn Fn(f64)>) -> Result<(), String>;

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
    /// 웹뷰의 페이지가 창의 키보드 초점을 옮기지 못하게 하고 적용 여부를 반환한다.
    fn ignore_page_focus(&self, view: &PlatformWebview) -> Result<bool, String>;
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
    /// 창에 포인터 입력을 전달하고 결과를 반환한다. activate 는 사용하지 않는다. 메인 스레드에서 호출한다.
    /// 누름과 뗌은 좌표의 문서가 그 이벤트를 받거나 receive 가 지난 뒤 done 을 메인 스레드에서
    /// 호출한다. 다른 단계는 전달한 즉시 호출한다.
    fn input_pointer(
        &self,
        window: Handle,
        pointer: Pointer,
        receive: Duration,
        done: Box<dyn FnOnce(Delivery) + Send>,
    ) -> Result<(), String>;
    /// 애플리케이션을 활성화하고 창을 키 창으로 만든다. 창의 웹뷰가 활성 상태를 반영하면
    /// done(Ok), timeout 안에 끝나지 않으면 멈춘 단계를 적은 done(Err) 를 메인 스레드에서 호출한다.
    /// 메인 스레드에서 호출한다.
    fn input_activate(
        &self,
        window: Handle,
        timeout: Duration,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String>;
    /// 창에 키 입력을 전달하고 전달 여부를 반환한다. 메인 스레드에서 호출한다.
    fn input_key(&self, window: Handle, key: &Key) -> Result<bool, String>;

    // 캡처

    #[cfg(feature = "diagnostics")]
    /// 창 번호의 창을 캡처 대상으로 준비한다. display 이면 창이 있는 디스플레이에서 이 앱의 창을 캡처한다.
    fn capture_open(&self, window_number: isize, display: bool) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// directory 에 프레임 기록을 시작한다.
    fn capture_start(&self, directory: &str) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// 첫 프레임을 기다리고 기록 여부를 반환한다.
    fn capture_wait(&self) -> Result<bool, String>;
    #[cfg(feature = "diagnostics")]
    /// after 의 표시 시각(ms, 0 이면 호출 시각)까지 기록한 뒤 기록을 끝내고 기록한 프레임 수를 반환한다.
    fn capture_stop(&self, after: f64) -> Result<i32, String>;
    #[cfg(feature = "diagnostics")]
    /// 마지막으로 멈춘 기록에서 연속한 프레임 사이의 가장 긴 표시 간격(ms).
    fn capture_longest_gap(&self) -> Result<f64, String>;

    // 종료 요청

    /// 종료 신호(SIGTERM, SIGINT, SIGHUP)를 처음 받으면 quit 를 호출하게 한다. 그 뒤의 종료
    /// 신호는 기본 동작으로 프로세스를 끝낸다.
    fn on_termination(&self, quit: Box<dyn Fn() + Send>) -> Result<(), String>;

    // 창 동작

    /// 창 확대와 애니메이션 크기 변경을 한 화면 갱신 안에 끝나게 한다. 창을 만들기 전에 호출한다.
    fn instant_window_resize(&self) -> Result<(), String>;

    // Dock

    /// Dock 메뉴에 새 창 항목을 설치한다. 항목을 선택하면 new_window 를 호출한다.
    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String>;
    /// Dock 메뉴 항목의 제목 목록을 반환한다. 메인 스레드에서 호출한다.
    fn dock_items(&self) -> Result<Value, String>;
    /// 제목이 title 인 Dock 메뉴 항목을 실행한다. 메인 스레드에서 호출한다.
    fn dock_select(&self, title: &str) -> Result<(), String>;

    // 디렉터리 식별

    /// 같은 디렉터리를 가리키는 경로에 같은 값을 반환한다.
    fn directory_identity(&self, path: &Path, metadata: &Metadata) -> Result<String, String>;
    #[cfg(feature = "diagnostics")]
    /// 현재 사용자만 접근할 수 있는 디렉터리를 상위 디렉터리와 함께 만든다.
    fn private_directory(&self, path: &Path) -> Result<(), String>;

    // 엔드포인트

    /// directory 안에 이름 name 의 로컬 엔드포인트 주소를 연다. directory 는 현재 사용자 전용이어야 한다.
    fn endpoint_listen(&self, directory: &Path, name: &str) -> Result<Box<dyn Listener>, String>;
    /// 로컬 엔드포인트 주소에 연결한다.
    fn endpoint_connect(&self, address: &str) -> Result<Box<dyn Connection>, String>;
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
