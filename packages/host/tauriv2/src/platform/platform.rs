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

/// 활성 platform이 제공하는 인증된 persistent sidecar stream이다.
pub trait PersistentStream: Read + Write + Send {
    fn try_clone(&self) -> Result<Box<dyn PersistentStream>, String>;
    fn shutdown(&self) -> Result<(), String>;
    /// 다음 읽기를 기한 안에 끝나게 한다. None 은 무한 대기다. 인사(hello) 왕복이
    /// 상태 잠금을 쥔 채 무한히 멈추지 않게 한다(V5-106). 이어지는 읽기 스레드는 다시
    /// 무한 대기로 돌려놓는다.
    fn set_read_deadline(&self, timeout: Option<std::time::Duration>) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
#[path = "darwin/darwin.rs"]
mod darwin;

#[cfg(windows)]
#[path = "windows/windows.rs"]
mod windows;

/// 공용 라이브러리가 창과 웹뷰에 붙인 객체 가운데 그 수명이 창과 웹뷰의 해제를 나타내는 객체의 살아 있는 수.
/// 닫은 창과 그 웹뷰가 해제되면 그 창의 객체 수가 빠진다.
#[cfg(feature = "diagnostics")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowObjects {
    /// 창의 콘텐츠 뷰 안에서 메인 웹뷰를 보유하는 합성 뷰의 수.
    pub window_compositions: i64,
    /// 논리 표면과 표면에 붙인 웹뷰의 컨테이너 수.
    pub surface_hosts: i64,
    /// 입력을 등록한 웹뷰(메인, 모달, 표면 웹뷰)의 등록 수.
    pub input_registrations: i64,
}

#[cfg(feature = "diagnostics")]
impl WindowObjects {
    /// diagnostics.native.objects 의 응답.
    pub fn payload(&self) -> Value {
        serde_json::json!({
            "windowCompositions": self.window_compositions,
            "surfaceHosts": self.surface_hosts,
            "inputRegistrations": self.input_registrations,
        })
    }

    /// diagnostics.native.objects 의 equal 을 읽는다. 세 이름 외의 이름, 빠진 이름, 정수가 아니거나 음수인 값은
    /// 거부한다.
    pub fn from_equal(value: &Value) -> Result<Self, String> {
        const INVALID: &str = "equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer";
        let fields = value
            .as_object()
            .filter(|fields| fields.len() == 3)
            .ok_or(INVALID)?;
        let read = |name: &str| {
            fields
                .get(name)
                .and_then(Value::as_i64)
                .filter(|n| *n >= 0)
                .ok_or_else(|| INVALID.to_string())
        };
        Ok(Self {
            window_compositions: read("windowCompositions")?,
            surface_hosts: read("surfaceHosts")?,
            input_registrations: read("inputRegistrations")?,
        })
    }
}

/// diagnostics.process.exit 의 pid 를 읽는다. 없거나, JSON 정수가 아니거나, 1 부터 2147483647 사이가 아니면
/// 거부한다.
#[cfg(feature = "diagnostics")]
pub fn parse_process_id(value: Option<&Value>) -> Result<i32, String> {
    value
        .and_then(Value::as_i64)
        .filter(|pid| (1..=i64::from(i32::MAX)).contains(pid))
        .map(|pid| pid as i32)
        .ok_or_else(|| "pid must be a positive integer".to_string())
}

/// 오류 메시지에 쓰는 수의 표기.
#[cfg(feature = "diagnostics")]
impl std::fmt::Display for WindowObjects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "windowCompositions {}, surfaceHosts {}, inputRegistrations {}",
            self.window_compositions, self.surface_hosts, self.input_registrations
        )
    }
}

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
    fn close(&self) -> Result<(), String>;
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
    /// AppKit이 눌린 마우스 버튼을 보고해 합성 누름이나 뗌을 전달하지 않았다.
    ButtonHeld,
    /// 그 창에서 그 버튼의 합성 누름이 아직 열려 있어 누름을 전달하지 않았다.
    PressOpen,
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

/// 창 좌표의 한 점에 있는 뷰. chain 은 leaf 뷰부터 콘텐츠 뷰까지의 주소이며 identifier 는 leaf 뷰의
/// 식별자다. view_class 와 view_frame 은 그 leaf 의 실제 클래스와 콘텐츠 좌표 프레임이다.
pub struct Hit {
    pub chain: Vec<Handle>,
    pub identifier: String,
    pub view_class: Option<String>,
    pub view_frame: Option<Frame>,
}

/// 운영체제가 제공하는 창, 웹뷰, 표면 배치, 도형, 입력, 캡처, Dock, 디렉터리 식별, 엔드포인트 기능.
///
/// 구현하지 않은 기능은 "not implemented" 오류를 반환한다.
/// 표면 뷰포트의 CSS 픽셀 여백(왼쪽, 위, 오른쪽, 아래).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Insets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// 선언된 DOM 오버레이의 표면 뷰포트 기준 CSS 픽셀 여백과 표시 여부.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DOMOverlay {
    pub insets: Insets,
    pub visible: bool,
}

/// 메인 DOM 평면의 전역 overlay와 그 CSS 좌표.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowOverlay {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub visible: bool,
}

/// 사용자의 system clipboard에서 읽은 값이다. `Absent`는 error가 아니다.
#[derive(Debug, Clone, PartialEq)]
pub enum ClipboardValue {
    Absent,
    Text(String),
    Png(Vec<u8>),
    FileUrls(Vec<String>),
}

pub fn visible_window_overlay_rects(overlays: &[WindowOverlay]) -> Vec<f64> {
    overlays
        .iter()
        .filter(|overlay| overlay.visible)
        .flat_map(|overlay| [overlay.x, overlay.y, overlay.w, overlay.h])
        .collect()
}

/// 적용된 그림 영역의 장치 픽셀 크기와 CSS 픽셀당 장치 픽셀 배율.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

pub trait Platform: Send + Sync {
    /// 현재 프레임워크 이벤트 콜백이 끝난 뒤 메인 큐에서 work 를 한 번 실행한다.
    fn enqueue_ui(&self, work: Box<dyn FnOnce() + Send>) -> Result<(), String>;

    // 창

    /// 프로젝트 창 생성기에 운영체제별 창 설정을 적용한다.
    fn prepare_window<'a>(&self, builder: WindowBuilder<'a>) -> Result<WindowBuilder<'a>, String>;
    /// 창의 네이티브 주소를 반환한다.
    fn window_handle(&self, window: &Window) -> Result<Handle, String>;
    fn set_main_webview(&self, window: Handle, main: Handle) -> Result<(), String>;
    /// 창을 투명하게 두고, 메인 웹뷰의 첫 읽기가 끝난 뒤 다음 표시가 끝나면 불투명하게 한다. 창을 화면에 올리는
    /// 일은 호출자가 이 호출 뒤에 한다(native/darwin/src/window_reveal.h). UI 스레드에서 호출한다.
    fn reveal_after_load(&self, window: Handle) -> Result<(), String>;
    fn set_main_appearance(&self, view: &PlatformWebview, dark: bool) -> Result<(), String>;
    /// 창을 전체 화면으로 바꾸거나 되돌리고, 전환이 끝나면 done 을 호출한다. 전환 중에 온 요청은
    /// 그 전환이 끝난 뒤에 처리한다.
    fn fullscreen(&self, window: Handle, on: bool, done: Box<dyn Fn()>) -> Result<(), String>;
    /// 창의 가림 상태가 바뀔 때마다 changed 를 UI 스레드에서 호출한다. 관찰은 창과 함께 끝난다.
    fn observe_occlusion(&self, window: Handle, changed: Box<dyn Fn()>) -> Result<(), String>;

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
    fn place_webview(
        &self,
        view: &PlatformWebview,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String>;
    /// 웹뷰의 현재 위치와 크기를 페이지 좌표로 반환한다.
    fn webview_frame(&self, view: &PlatformWebview) -> Result<[f64; 4], String>;
    /// 메인 DOM 웹뷰 아래에 논리 SurfaceHost를 만든다. 이 호출은 DOM 웹뷰를 만들지 않는다.
    fn create_surface(&self, main: Handle) -> Result<Handle, String>;
    fn close_surface(&self, surface: Handle) -> Result<(), String>;
    fn place_surface(&self, surface: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String>;
    fn surface_frame(&self, surface: Handle) -> Result<[f64; 4], String>;
    fn set_surface_hidden_handle(&self, surface: Handle, hidden: bool) -> Result<(), String>;
    fn set_surface_alpha_handle(&self, surface: Handle, alpha: f64) -> Result<(), String>;
    fn set_window_overlays(&self, main: Handle, overlays: &[WindowOverlay]) -> Result<(), String>;
    /// main 웹뷰의 창에 놓인 파일을 받는다. receive 는 {"urls":[...],"x":..,"y":..}(페이지 좌표) 를 받는다.
    fn file_drop(&self, main: Handle, receive: Box<dyn Fn(String)>) -> Result<(), String>;
    /// 표면 웹뷰를 main 웹뷰의 표면 컨테이너에 등록한다.
    fn attach_surface(&self, view: &PlatformWebview, main: Handle) -> Result<(), String>;
    /// 표면 웹뷰와 그 SurfaceHost를 표면 컨테이너에서 제거한다.
    fn detach_surface(&self, view: &PlatformWebview) -> Result<(), String>;
    /// SurfaceHost와 그 두 평면의 표시 여부를 함께 설정한다.
    fn set_surface_hidden(&self, view: &PlatformWebview, hidden: bool) -> Result<(), String>;
    /// 네이티브 입력보다 먼저 처리할 선언된 DOM 오버레이를 설정한다.
    fn set_surface_overlays(&self, surface: Handle, overlays: &[DOMOverlay]) -> Result<(), String>;
    /// 웹뷰의 불투명도를 설정한다.
    fn set_alpha(&self, view: &PlatformWebview, alpha: f64) -> Result<(), String>;
    /// 현재 WebContent 프로세스를 종료한다. 애플리케이션 종료가 WebKit 자식 프로세스를 남기지 않으려고 부른다.
    fn kill_web_content_process(&self, view: &PlatformWebview) -> Result<(), String>;
    /// view 의 WebContent process 들이 JavaScript 객체를 수집하게 한다. 진단 build 의 메모리 측정이 쓴다.
    fn collect_garbage(&self, view: &PlatformWebview) -> Result<(), String>;
    /// 연속적인 크기 변경의 시작과 종료를 웹뷰에 전달한다.
    fn set_live_resize(&self, view: &PlatformWebview, live: bool) -> Result<(), String>;
    /// 웹뷰를 같은 부모의 다른 뷰 위로 올린다.
    fn raise_webview(&self, view: &PlatformWebview) -> Result<(), String>;
    /// 웹뷰의 모서리를 radius 논리 픽셀만큼 둥글게 자른다.
    fn round_corners(&self, view: &PlatformWebview, radius: f64) -> Result<(), String>;
    /// 웹뷰를 창의 첫 응답자로 만들어 키보드 입력을 받게 한다. 창이 거절하면 오류를 반환한다.
    fn focus_webview(&self, view: &PlatformWebview) -> Result<(), String>;

    // 문서 영역

    /// 표면 웹뷰 surface 안에 외부 문서 웹뷰를 숨긴 상태로 만든다. store 는 영구 데이터 저장소가
    /// 사이트 데이터를 두는 절대 경로다. changed 는 상태 JSON({url, title, loading, progress, canGoBack, canGoForward,
    /// error, scroll}) 을 메인 스레드에서 받는다. 메인 스레드에서 호출한다.
    fn create_document(
        &self,
        surface: Handle,
        store: &str,
        changed: Box<dyn Fn(String)>,
    ) -> Result<Handle, String>;
    fn set_document_event(
        &self,
        document: Handle,
        event: Box<dyn Fn(String) + Send>,
    ) -> Result<(), String>;
    /// http 또는 https 주소를 연다. 그 밖의 주소이면 false 를 반환한다. 메인 스레드에서 호출한다.
    fn load_document(&self, document: Handle, url: &str) -> Result<bool, String>;
    /// 문서의 페이지 확대를 정한다. 유한한 양수가 아니면 false 다.
    fn zoom_document(&self, document: Handle, zoom: f64) -> Result<bool, String>;
    /// 뒤로 0, 앞으로 1, 다시 읽기 2, 멈춤 3 을 실행하고 실행했는지 반환한다. 메인 스레드에서 호출한다.
    fn go_document(&self, document: Handle, action: i32, offset: i32) -> Result<bool, String>;
    /// 표면 뷰포트의 CSS 픽셀 여백으로 문서 영역을 정한다. 메인 스레드에서 호출한다.
    fn place_document(&self, document: Handle, insets: Insets, visible: bool)
        -> Result<(), String>;
    /// 대화 상자가 열린 동안 문서를 흐리게 표시한다. 메인 스레드에서 호출한다.
    fn set_document_background(&self, document: Handle, enabled: bool) -> Result<(), String>;
    /// native document webview appearance를 현재 host scheme으로 설정한다.
    fn set_document_appearance(&self, document: Handle, dark: bool) -> Result<(), String>;
    /// 문서 웹뷰를 제거한다. 이후 changed 는 호출되지 않는다. 메인 스레드에서 호출한다.
    fn close_document(&self, document: Handle) -> Result<(), String>;
    /// 입력 체인에서 웹뷰를 식별하는 뷰 주소를 반환한다.
    fn view_id(&self, view: &PlatformWebview) -> Result<Handle, String>;

    // 그림 영역

    /// 표면 웹뷰 surface 안에 외부 그림 표시 영역을 만든다. name 은 영역 이름이다.
    /// event 는 키보드·IME·입력 이벤트를 JSON 문자열({key, insert, compose, focus, size, error})으로
    /// 메인 스레드에서 받는다. 메인 스레드에서 호출한다.
    fn create_image(
        &self,
        surface: Handle,
        name: &str,
        event: Box<dyn Fn(String)>,
    ) -> Result<Handle, String>;
    /// 표면 뷰포트의 CSS 픽셀 여백으로 그림 영역을 정한다. 메인 스레드에서 호출한다.
    fn place_image(&self, image: Handle, insets: Insets, visible: bool) -> Result<(), String>;
    /// 적용된 그림 영역의 래스터 기하를 반환한다. 아직 유효한 크기가 없으면 None 이다.
    fn image_raster(&self, image: Handle) -> Result<Option<Raster>, String>;
    /// 영역의 표면이 네이티브 크기를 가졌는지. 아직 배치되지 않은 표면의 영역은 래스터 크기를 갖지 않는다.
    fn image_surface_placed(&self, image: Handle) -> Result<bool, String>;
    /// 그림 영역의 현재 프레임, 표시 래스터와 오류를 JSON 으로 반환한다. 메인 스레드에서 호출한다.
    fn image_facts(&self, image: Handle) -> Result<String, String>;
    /// 외부 IOSurface 를 표시한다. token_id 는 IOSurface 의 전역 ID, nonce 는 논스 대조용
    /// 16바이트 데이터, width·height 는 장치 픽셀 단위의 크기, scale 은 이미지가 만들어진
    /// 배율이다. 성공하면 true, 찾지 못했거나 크기가 맞지 않으면 false 를 반환한다.
    /// 메인 스레드에서 호출한다.
    fn present_image(
        &self,
        image: Handle,
        token_id: u32,
        nonce: [u8; 16],
        width: f64,
        height: f64,
        scale: f64,
    ) -> Result<bool, String>;
    /// 영역을 첫 응답자로 만들고 포커스 이벤트를 보낸다. 메인 스레드에서 호출한다.
    fn focus_image(&self, image: Handle) -> Result<(), String>;
    /// 캐럿(입력 커서) 위치를 받아 둔다. 메인 스레드에서 호출한다.
    fn caret_image(&self, image: Handle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String>;
    /// 접근성 값으로 보일 문자열을 받아 둔다. 메인 스레드에서 호출한다.
    fn text_image(&self, image: Handle, utf8: &str) -> Result<(), String>;
    /// 그림 영역을 제거한다. 이후 event 는 호출되지 않는다. 메인 스레드에서 호출한다.
    fn close_image(&self, image: Handle) -> Result<(), String>;

    // 표면 배치

    /// 창의 표면 배치 트랜잭션 ticket 을 시작하고 시작 허용 여부를 ready 에 전달한다.
    fn begin_layout(
        &self,
        window: Handle,
        ticket: u64,
        ready: Box<dyn Fn(bool)>,
    ) -> Result<(), String>;
    /// 표면 배치 트랜잭션 ticket 을 확정하고 확정 여부를 반환한다.
    fn commit_layout(&self, window: Handle, ticket: u64) -> Result<bool, String>;
    /// 창의 진행 중인 표면 배치 트랜잭션을 취소한다.
    fn cancel_layout(&self, window: Handle) -> Result<(), String>;
    /// 열린 배치를 커밋하기 전에 앱 문서의 표시 준비를 확인한다.
    fn after_presentation(&self, view: &PlatformWebview, done: Box<dyn Fn()>)
        -> Result<(), String>;
    /// 창에 열린 표면 배치 트랜잭션이 없는 상태에서 메인 문서와 표시 중인 문서의 렌더링이 끝난 뒤 done 을
    /// 호출한다. 인자는 그 화면이 표시되는 시각(ms, mach 절대 시각)이다.
    fn after_settled(
        &self,
        view: &PlatformWebview,
        done: Box<dyn Fn(Result<f64, String>)>,
    ) -> Result<(), String>;
    /// 다음 settled 표시 대기를 진단 목적으로 한 번 실패시킨다.
    fn inject_settled_failure(&self) -> Result<(), String>;

    // 도형

    /// 창 콘텐츠 뷰에 도형 뷰를 만들고 주소를 반환한다. 만들지 못하면 0 을 반환한다.
    fn create_shape(&self, window: Handle, frame: Frame) -> Result<Handle, String>;
    /// 도형 뷰를 배치하고 형제 뷰 위로 올린다.
    fn place_shape(&self, shape: Handle, frame: Frame) -> Result<(), String>;
    /// 도형의 모서리 반경, 선 두께, 채움 색, 선 색을 설정한다. 색은 0-1 범위의 RGBA 이다.
    fn style_shape(
        &self,
        shape: Handle,
        radius: f64,
        line_width: f64,
        fill: [f64; 4],
        line: [f64; 4],
    ) -> Result<(), String>;
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
        x: f64,
        y: f64,
        timeout: Duration,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String>;
    /// 창에 키 입력을 전달하고 전달 여부를 반환한다. 메인 스레드에서 호출한다.
    fn input_key(&self, window: Handle, key: &Key) -> Result<Delivery, String>;

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
    /// 마지막 녹화가 유한한 프레임 상한에 도달해 자동으로 멈췄는지 반환한다.
    fn capture_limited(&self) -> Result<bool, String>;
    #[cfg(feature = "diagnostics")]
    /// 마지막으로 멈춘 기록에서 연속한 프레임 사이의 가장 긴 표시 간격(ms).
    fn capture_longest_gap(&self) -> Result<f64, String>;
    #[cfg(feature = "diagnostics")]
    /// 현재 시각(ms). 기록 프레임의 표시 시각과 같은 시계다.
    fn capture_clock(&self) -> Result<f64, String>;
    #[cfg(feature = "diagnostics")]
    /// 창 번호의 창을 포커스를 주지 않고 한 장 찍어 path 에 PNG 로 쓴다. 관측 자료다.
    fn capture_still(&self, window_number: isize, path: &str) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// 알림 센터가 아직 보이는 이 애플리케이션의 알림을 [{identifier, title, body}] JSON 으로 done 에 준다.
    /// 메인 스레드에서 호출하고 done 도 메인 스레드에서 불린다.
    fn delivered_notifications(&self, done: Box<dyn FnOnce(String) + Send>) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// 애플리케이션이 이벤트 하나를 처리해 그 이벤트 반복의 자동 해제 풀을 비운 뒤, 창과 웹뷰에 붙인 라이브러리
    /// 객체의 수가 expected 와 같아질 때 그 수와 true 를 done 에 준다. seconds 안에 같아지지 않으면 그때의 수와
    /// false 를 준다. expected 가 None 이면 이벤트 뒤의 수와 true 를 준다. 메인 스레드에서 호출하고 done 도 메인
    /// 스레드에서 불린다.
    fn window_objects_when(
        &self,
        expected: Option<WindowObjects>,
        seconds: f64,
        done: Box<dyn FnOnce(WindowObjects, bool) + Send>,
    ) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// pid 의 프로세스가 끝나면 true 를, seconds 안에 끝나지 않으면 false 를 done 에 준다. 이미 없는 프로세스는 끝난
    /// 것이다. 메인 스레드에서 호출하고 done 도 메인 스레드에서 불린다.
    fn when_process_exited(
        &self,
        pid: i32,
        seconds: f64,
        done: Box<dyn FnOnce(bool) + Send>,
    ) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// 배치 트랜잭션마다 시작, 앱 DOM 표시 확인, 커밋 시각의 기록을 시작한다. 메인 스레드에서 호출한다.
    fn layout_trace_start(&self) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// 기록을 멈추고 트랜잭션마다 ticket, begun, presented, committed(ms, 표시 시각과 같은 시계)를
    /// 반환한다. 일어나지 않은 단계는 NaN 이다. 메인 스레드에서 호출한다.
    fn layout_trace_stop(&self) -> Result<Vec<[f64; 4]>, String>;

    // 입력 소스

    #[cfg(feature = "diagnostics")]
    /// 현재 선택된 키보드 입력 소스의 식별자를 반환한다. 메인 스레드에서 호출한다.
    fn input_source(&self) -> Result<String, String>;
    #[cfg(feature = "diagnostics")]
    /// 켜져 있는 입력 소스 가운데 identifier 를 선택한다. 메인 스레드에서 호출한다.
    fn select_input_source(&self, identifier: &str) -> Result<(), String>;

    // 종료 요청

    /// 종료 신호(SIGTERM, SIGINT, SIGHUP)를 처음 받으면 quit 를 호출하게 한다. 그 뒤의 종료
    /// 신호는 기본 동작으로 프로세스를 끝낸다.
    fn on_termination(&self, quit: Box<dyn Fn() + Send>) -> Result<(), String>;

    // 창 동작

    /// 창 확대와 애니메이션 크기 변경을 한 화면 갱신 안에 끝나게 한다. 창을 만들기 전에 호출한다.
    fn instant_window_resize(&self) -> Result<(), String>;

    // 표준 오류

    /// 프로세스의 표준 오류를 file 로 바꾼다. 이후 시작하는 자식 프로세스도 그 descriptor 를
    /// 물려받는다(docs/spec/hosts.md#application-log).
    fn replace_standard_error(&self, file: &std::fs::File) -> Result<(), String>;

    // Dock

    /// Dock 메뉴에 새 창 항목을 설치한다. 항목을 선택하면 new_window 를 호출한다.
    fn install_dock_menu(&self, new_window: Box<dyn Fn()>) -> Result<(), String>;

    // 클립보드. 구현은 호출자가 메인 스레드에서 호출한다는 계약을 따른다.
    fn clipboard_read(&self, kind: &str) -> Result<ClipboardValue, String>;
    fn clipboard_write_text(&self, text: &str) -> Result<(), String>;
    fn clipboard_write_png(&self, bytes: &[u8]) -> Result<(), String>;
    /// URL 을 그 스킴의 사용자 기본 애플리케이션으로 연다. 메인 스레드에서 호출한다.
    fn open_link(&self, url: &str) -> Result<(), String>;
    /// 운영체제의 알림 센터를 쓰기 시작하고 그 사건 JSON 을 receive 로 메인 스레드에서 넘긴다
    /// ({"type":"state",...} 와 {"type":"activated","identifier":...}). 메인 스레드에서 호출한다.
    fn start_notifications(&self, receive: Box<dyn Fn(String) + Send + Sync>)
        -> Result<(), String>;
    /// identifier 의 알림을 게시하거나 바꾼다. 메인 스레드에서 호출한다.
    fn post_notification(&self, identifier: &str, title: &str, body: &str) -> Result<(), String>;
    /// identifier 의 알림을 지운다. 메인 스레드에서 호출한다.
    fn remove_notification(&self, identifier: &str) -> Result<(), String>;
    /// Dock 메뉴 항목의 제목 목록을 반환한다. 메인 스레드에서 호출한다.
    fn dock_items(&self) -> Result<Value, String>;
    /// 애플리케이션 메뉴를 반환한다. 하위 메뉴마다 {title, items: [{title, key}]} 다. 메인 스레드에서 호출한다.
    fn menu_items(&self) -> Result<Value, String>;

    /// 시스템 선호 언어의 주 태그. 지원 여부는 호출자의 표가 정한다.
    fn preferred_language(&self) -> Result<String, String>;
    /// 제목이 menu 인 하위 메뉴에서 제목이 title 인 항목을 실행한다. 메인 스레드에서 호출한다.
    fn menu_select(&self, menu: &str, title: &str) -> Result<(), String>;
    /// 애플리케이션의 주 창 핸들. 없으면 0 이다. 메인 스레드에서 호출한다.
    fn main_window(&self) -> Result<Handle, String>;
    /// 제목이 title 인 Dock 메뉴 항목을 실행한다. 메인 스레드에서 호출한다.
    fn dock_select(&self, title: &str) -> Result<(), String>;

    // 디렉터리 식별

    /// 같은 디렉터리를 가리키는 경로에 같은 값을 반환한다.
    fn directory_identity(&self, path: &Path, metadata: &Metadata) -> Result<String, String>;
    /// path 에서 없는 디렉터리를 현재 사용자 전용 권한으로 만든다. 이미 있는 디렉터리의 권한은 바꾸지 않는다.
    fn create_private_directories(&self, path: &Path) -> Result<(), String>;
    #[cfg(feature = "diagnostics")]
    /// 현재 사용자만 접근할 수 있는 디렉터리를 상위 디렉터리와 함께 만든다.
    fn private_directory(&self, path: &Path) -> Result<(), String>;

    // 엔드포인트

    /// directory 안에 이름 name 의 로컬 엔드포인트 주소를 연다. directory 는 현재 사용자 전용이어야 한다.
    fn endpoint_listen(&self, directory: &Path, name: &str) -> Result<Box<dyn Listener>, String>;
    /// 로컬 엔드포인트 주소에 연결한다.
    fn endpoint_connect(&self, address: &str) -> Result<Box<dyn Connection>, String>;
    /// persistent sidecar service socket에 연결한다.
    fn connect_service(&self, address: &str) -> Result<Box<dyn PersistentStream>, String>;
    /// service directory를 현재 사용자 전용으로 만든다.
    fn secure_service_directory(&self, path: &Path) -> Result<(), String>;
    /// persistent service endpoint의 프로세스가 아직 존재하는지 확인한다.
    fn service_process_exists(&self, pid: u32) -> Result<bool, String>;
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
