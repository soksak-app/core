//! 네이티브 모달의 표시, 배치, 내용 갱신, 준비 확인, 선택 전달, 닫기.
//!
//! 페이지의 [data-native-modal] 요소는 메인 창 안의 자식 웹뷰가 그린다.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::Color;
use tauri::{LogicalPosition, LogicalSize, Webview, WebviewBuilder, WebviewUrl, Window};

use crate::log_error;
use crate::platform;
use crate::surfaces::{aligned, isolate_webview, Rect};
use crate::windows::{emit_window, root_view, window_data};

/// [data-native-modal] 요소를 다른 웹뷰에 그리는 데 필요한 값.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayRequest {
    mode: String,
    card: Rect,
    /// 요소의 id. 요소를 그리는 뷰의 이름으로 사용한다.
    id: String,
    /// 모달 문서의 접근성 이름.
    title: String,
    rect: Rect,
    class_name: String,
    html: String,
    css: String,
    /// 배경 위에 합성한 요소의 테두리 색. 아래 표면의 밝기와 관계없이 같은 색으로 보인다.
    border: String,
    /// 요소의 모서리 반경. 요소를 그리는 뷰에 적용한다.
    radius: f64,
}

/// 모달 웹뷰가 로드 후 요청하는 내용.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayContent {
    mode: String,
    card: Rect,
    title: String,
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// 모달 웹뷰가 현재 그리는 모달.
///
/// 페이지는 한 번에 [data-native-modal] 요소 하나를 표시하고 다음 요소를 표시하기 전에 닫으므로
/// 기록 하나에 모달 id 를 함께 저장한다.
#[derive(Debug, Clone, Default)]
struct Modal {
    instance: u64,
    /// 요소의 id. 모달 페이지는 모든 호출에 이 값을 보내고, 다른 id 의 호출은 닫힌 모달이
    /// 마지막으로 보낸 호출이다.
    id: String,
    content: OverlayContent,
    radius: f64,
    /// 페이지 좌표의 사각형. 모서리 설정에도 사용한다.
    at: Rect,
    /// 이번 표시에서 창을 표시했는지 나타낸다. 모달 문서는 렌더링할 때마다 준비를 보고하고,
    /// 다시 표시하면 키보드 포커스를 다시 가져간다.
    shown: bool,
}

/// 메인 창 안의 모달 웹뷰와 그 웹뷰가 표시하는 모달.
#[derive(Default)]
pub(crate) struct Overlay {
    pub view: Mutex<Option<Webview>>,
    open: Mutex<Option<Modal>>,
    next: AtomicU64,
}

impl Overlay {
    /// 열린 모달이 dialog 모드인지 반환한다.
    pub fn dialog(&self) -> bool {
        self.open.lock().is_ok_and(|open| open.as_ref().is_some_and(|m| m.content.mode == "dialog"))
    }

    /// 모달 기록과 모달 웹뷰를 제거한다.
    pub fn discard(&self) -> Result<(), String> {
        *self.open.lock().map_err(|e| e.to_string())? = None;
        let view = self.view.lock().map_err(|e| e.to_string())?.take();
        if let Some(view) = view {
            set_background(&view.window(), false)?;
            view.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// 열린 모달 웹뷰의 새 위치. 카드가 위치를 정하고, 이 요청은 손잡이 드래그로 전달된다.
#[derive(Debug, Deserialize)]
pub(crate) struct PlaceRequest {
    id: String,
    rect: Rect,
    card: Rect,
}

#[derive(Clone, Serialize)]
struct ModalPosition {
    id: String,
    instance: u64,
    card: Rect,
}

/// 열린 모달의 새 내용. 페이지가 측정한 요소 내용만 담는다. 열린 모달은 위치와 크기를 유지한다.
#[derive(Debug, Deserialize)]
pub(crate) struct UpdateRequest {
    id: String,
    #[serde(flatten)]
    content: OverlayContent,
}

/// 모달 페이지가 받는 모달 하나의 새 내용.
#[derive(Clone, Serialize)]
struct ModalContentEvent {
    instance: u64,
    id: String,
    content: OverlayContent,
}

/// 모달 페이지가 보고하는 컨트롤과 그 값. 쌍 대신 이름 있는 필드를 사용한다. 쌍을 인덱스로
/// 읽으면 문자열의 첫 문자를 답 전체로 읽은 적이 있다.
#[derive(Debug, Clone, Serialize)]
struct Picked {
    id: String,
    key: String,
    value: String,
}

/// 창의 메인 웹뷰와 표면 웹뷰에 모달 배경 상태를 설정한다.
pub(crate) fn set_background(window: &Window, enabled: bool) -> Result<(), String> {
    for view in window.webviews() {
        if view.label() == window.label() || view.label().starts_with("surface-") {
            view.eval(format!("window.__soksakBackground = {enabled}"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 모달 웹뷰를 콘텐츠 좌표에 소수 픽셀을 반올림하지 않고 배치한다.
fn place_overlay(view: &Webview, at: Rect) -> Result<(), String> {
    let platform = platform::current()?;
    view.with_webview(move |webview| log_error(platform.place_webview(&webview, at.x, at.y, at.w, at.h)))
        .map_err(|e| e.to_string())
}

/// 모달 요소 하나를 메인 창 안의 웹뷰에 그린다. 뷰는 문서가 내용을 그렸다고 보고할 때까지 숨긴다.
pub(crate) fn show(window: &Window, request: OverlayRequest) -> Result<Rect, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    // 이전 네이티브 뷰를 제거한다. 표시마다 고유 번호를 부여해, 같은 id 의 이전 문서가 늦게
    // 보낸 메시지가 다음 표시에 영향을 주지 않게 한다.
    state.discard()?;
    let instance = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y, w, h) = aligned(request.rect.x, request.rect.y, request.rect.w.max(1.0), request.rect.h.max(1.0), scale);
    let at = Rect { x, y, w, h };
    let mut target = root_view(window).ok_or("the main webview is gone")?.url().map_err(|e| e.to_string())?;
    target.set_path("/overlay.html");
    target.set_query(None);
    target.query_pairs_mut().append_pair("id", &request.id).append_pair("instance", &instance.to_string());
    *state.open.lock().map_err(|e| e.to_string())? = Some(Modal {
        id: request.id.clone(),
        instance,
        content: OverlayContent {
            mode: request.mode.clone(),
            card: request.card,
            title: request.title,
            css: request.css,
            class_name: request.class_name,
            html: request.html,
            border: request.border,
        },
        radius: request.radius,
        at,
        shown: false,
    });
    // 그릴 영역이 없는 빈 문서로 만들고 숨긴 뒤, overlay_ready 를 호출하는 문서로 이동하기 전에
    // 뷰를 기록한다. 빈 프레임 표시와 생성/준비 경쟁을 막는다.
    let built = window.add_child(
        WebviewBuilder::new(format!("modal-{}-{instance}", window.label()), WebviewUrl::External("about:blank".parse().unwrap()))
            .background_color(Color(0, 0, 0, 0)),
        LogicalPosition::new(x, y),
        LogicalSize::new(0.0, 0.0),
    );
    let view = match built {
        Ok(view) => view,
        Err(error) => {
            *state.open.lock().map_err(|e| e.to_string())? = None;
            return Err(error.to_string());
        }
    };
    isolate_webview(&view)?;
    view.hide().map_err(|e| e.to_string())?;
    place_overlay(&view, at)?;
    view.set_auto_resize(request.mode == "dialog").map_err(|e| e.to_string())?;
    *state.view.lock().map_err(|e| e.to_string())? = Some(view.clone());
    if let Err(error) = view.navigate(target) {
        let _ = view.close();
        *state.view.lock().map_err(|e| e.to_string())? = None;
        *state.open.lock().map_err(|e| e.to_string())? = None;
        return Err(error.to_string());
    }
    Ok(at)
}

/// 열린 모달 웹뷰를 옮기고 크기를 바꾼 뒤 적용한 사각형을 반환한다.
///
/// 적용한 사각형은 페이지 사각형을 디스플레이 픽셀에 맞춘 값이다. 두 값이 다르므로 차이를
/// 페이지에 알린다.
pub(crate) fn place(window: &Window, request: PlaceRequest) -> Result<Rect, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let current = state.open.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|m| m.id == request.id);
    let Some(view) = state.view.lock().map_err(|e| e.to_string())?.clone().filter(|_| current) else {
        return Ok(Rect::default());
    };
    let (x, y, w, h) = aligned(request.rect.x, request.rect.y, request.rect.w.max(1.0), request.rect.h.max(1.0), scale);
    let at = Rect { x, y, w, h };
    place_overlay(&view, at)?;
    if let Some(modal) = state.open.lock().map_err(|e| e.to_string())?.as_mut().filter(|m| m.id == request.id) {
        modal.at = at;
        modal.content.card = request.card;
        emit_window(window, "modal-position", ModalPosition { id: modal.id.clone(), instance: modal.instance, card: request.card })
            .map_err(|e| e.to_string())?;
    }
    Ok(at)
}

/// id 와 instance 가 현재 모달과 같으면 모달 내용을 반환한다.
pub(crate) fn content(window: &Window, id: String, instance: u64) -> Result<OverlayContent, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let content = state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|modal| modal.id == id && modal.instance == instance)
        .map(|modal| modal.content.clone())
        .unwrap_or_default();
    Ok(content)
}

/// 이번 표시의 문서가 렌더링되면 모달 웹뷰를 표시한다.
pub(crate) fn ready(window: &Window, id: String, instance: u64) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let Some(view) = state.view.lock().map_err(|e| e.to_string())?.clone() else { return Ok(()) };
    let first = {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held.as_mut().filter(|m| m.id == id && m.instance == instance) else { return Ok(()) };
        if modal.shown {
            emit_window(window, "modal-rendered", &id).map_err(|e| e.to_string())?;
            return Ok(());
        }
        modal.shown = true;
        modal.clone()
    };
    let platform = platform::current()?;
    set_background(window, first.content.mode == "dialog")?;
    view.with_webview(move |webview| {
        log_error(platform.round_corners(&webview, first.radius));
        log_error(platform.raise_webview(&webview));
    })
    .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    view.set_focus().map_err(|e| e.to_string())?;
    emit_window(window, "modal-rendered", &id).map_err(|e| e.to_string())?;
    Ok(())
}

/// id 의 모달이 열려 있으면 닫고 메인 웹뷰에 포커스를 돌려준다.
pub(crate) fn hide(window: &Window, id: String) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        if !matches!(held.as_ref(), Some(modal) if modal.id == id) {
            return Ok(());
        }
        *held = None;
    }
    state.discard()?;
    if let Some(main) = root_view(window) {
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 현재 모달 문서의 선택을 페이지에 전달한다. 이전 문서는 뷰가 제거된 뒤에도 답을 보낼 수
/// 있으므로 id 와 instance 를 확인한다.
pub(crate) fn pick(window: &Window, id: String, instance: u64, key: String, value: String) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let current = state.open.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|m| m.id == id && m.instance == instance);
    if current && root_view(window).is_some() {
        emit_window(window, "overlay-pick", Picked { id, key, value }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 열린 모달의 내용을 뷰를 다시 만들지 않고 바꾼다. 페이지 상태를 바꾸는 컨트롤이 있는 모달은
/// 열린 동안 다시 그려지고, 뷰를 다시 만들면 깜박인다.
pub(crate) fn update(window: &Window, request: UpdateRequest) -> Result<(), String> {
    let context = window_data(window)?;
    let overlay = &context.overlay;

    let content = request.content;
    let instance = {
        let mut held = overlay.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held.as_mut().filter(|m| m.id == request.id) else { return Ok(()) };
        modal.content = content.clone();
        modal.instance
    };
    // 모든 페이지가 이벤트를 받으므로 id 를 포함하고, 각 모달 페이지는 자신의 이벤트만 사용한다.
    emit_window(window, "modal-content", ModalContentEvent { instance, id: request.id, content })
        .map_err(|e| e.to_string())
}
