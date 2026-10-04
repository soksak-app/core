//! 네이티브 모달의 표시, 배치, 내용 갱신, 준비 확인, 선택 전달, 닫기.
//!
//! 페이지의 [data-native-modal] 요소는 메인 창 안의 자식 웹뷰가 그린다.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::Color;
use tauri::{LogicalPosition, LogicalSize, Webview, WebviewBuilder, WebviewUrl, Window};

use crate::application_log::{log_error, log_failure};
use crate::documents;
use crate::exposure;
use crate::platform;
use crate::surfaces::{aligned, isolate_webview, PageFocus, Rect};
use crate::windows::{emit_window, root_view, window_data};

/// [data-native-modal] 요소를 main DOM에 표시하는 데 필요한 값.
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
    /// 요소를 그리는 네이티브 뷰의 모서리 반경.
    radius: f64,
}

/// 모달 웹뷰가 로드 후 요청하는 내용.
#[derive(Debug, Clone, Default, Serialize)]
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
    /// 요소의 id. main DOM callback은 모든 호출에 이 값을 보낸다.
    id: String,
    content: OverlayContent,
    /// 내용이나 위치를 바꿀 때마다 오른다. 모달 페이지는 이보다 오래된 값을 버린다.
    revision: u64,
    radius: f64,
    /// 페이지 좌표의 사각형. 모서리 설정에도 사용한다.
    at: Rect,
    /// 이번 표시에서 창 표시를 시작했는지 나타낸다. 모달 문서는 렌더링할 때마다 준비를 보고하고,
    /// 다시 표시하면 키보드 포커스를 다시 가져간다.
    shown: bool,
    /// 웹뷰를 표시하고 키보드 초점을 넘겼는지 나타낸다. host.window 가 이 값을 보고한다.
    visible: bool,
}

/// 메인 창 안의 모달 웹뷰와 그 웹뷰가 표시하는 모달.
#[derive(Default)]
pub(crate) struct Overlay {
    pub view: Mutex<Option<Webview>>,
    open: Mutex<Option<Modal>>,
    next: AtomicU64,
}

impl Overlay {
    /// 열린 모달의 요소 id, 모드, 표시 여부를 반환한다.
    pub fn open_state(&self) -> Option<(String, String, bool)> {
        self.open.lock().ok().and_then(|open| {
            open.as_ref()
                .map(|modal| (modal.id.clone(), modal.content.mode.clone(), modal.visible))
        })
    }

    /// 열린 모달이 dialog 모드인지 반환한다.
    pub fn dialog(&self) -> bool {
        self.open
            .lock()
            .is_ok_and(|open| open.as_ref().is_some_and(|m| m.content.mode == "dialog"))
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
    revision: u64,
    card: Rect,
}

/// 열린 모달의 새 내용. 페이지가 측정한 요소 내용만 담는다. 열린 모달은 위치와 크기를 유지한다.
/// 내용의 field 는 id 와 같은 객체에 있다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRequest {
    id: String,
    mode: String,
    card: Rect,
    title: String,
    css: String,
    class_name: String,
    html: String,
    border: String,
}

/// 모달 페이지가 받는 모달 하나의 새 내용.
#[derive(Clone, Serialize)]
struct ModalContentEvent {
    instance: u64,
    id: String,
    revision: u64,
    content: OverlayContent,
}

/// 모달의 내용과 그 내용의 변경 번호.
#[derive(Debug, Default, Serialize)]
pub(crate) struct RevisedContent {
    revision: u64,
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
    documents::set_background(window, enabled);
    for view in window.webviews() {
        if view.label() == window.label() || view.label().starts_with("surface-") {
            view.eval(format!("window.__soksakBackground = {enabled}"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 모달 웹뷰를 콘텐츠 좌표에 배치한다.
fn place_overlay(view: &Webview, at: Rect) -> Result<(), String> {
    let platform = platform::current()?;
    view.with_webview(move |webview| {
        log_failure(
            "modal place",
            platform.place_webview(&webview, at.x, at.y, at.w, at.h),
        )
    })
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
    let (x, y, w, h) = aligned(
        request.rect.x,
        request.rect.y,
        request.rect.w.max(1.0),
        request.rect.h.max(1.0),
        scale,
    );
    let at = Rect { x, y, w, h };
    let mut target = root_view(window)
        .ok_or("the main webview is gone")?
        .url()
        .map_err(|e| e.to_string())?;
    target.set_path("/overlay.html");
    target.set_query(None);
    target
        .query_pairs_mut()
        .append_pair("id", &request.id)
        .append_pair("instance", &instance.to_string());
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
        revision: 1,
        radius: request.radius,
        at,
        shown: false,
        visible: false,
    });
    let built = window.add_child(
        WebviewBuilder::new(
            format!("modal-{}-{instance}", window.label()),
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .background_color(Color(0, 0, 0, 0))
        .focused(false),
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
    isolate_webview(&view, PageFocus::Ignored)?;
    view.hide().map_err(|e| e.to_string())?;
    place_overlay(&view, at)?;
    view.set_auto_resize(request.mode == "dialog")
        .map_err(|e| e.to_string())?;
    *state.view.lock().map_err(|e| e.to_string())? = Some(view.clone());
    if let Err(error) = view.navigate(target) {
        let close_error = view.close().err();
        *state.view.lock().map_err(|e| e.to_string())? = None;
        *state.open.lock().map_err(|e| e.to_string())? = None;
        return Err(match close_error {
            Some(close_error) => format!("{error}; modal close failed: {close_error}"),
            None => error.to_string(),
        });
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
    let current = state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .is_some_and(|m| m.id == request.id);
    let Some(view) = state
        .view
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .filter(|_| current)
    else {
        return Ok(Rect::default());
    };
    let (x, y, w, h) = aligned(
        request.rect.x,
        request.rect.y,
        request.rect.w.max(1.0),
        request.rect.h.max(1.0),
        scale,
    );
    let at = Rect { x, y, w, h };
    place_overlay(&view, at)?;
    if let Some(modal) = state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_mut()
        .filter(|m| m.id == request.id)
    {
        modal.at = at;
        modal.content.card = request.card;
        modal.revision += 1;
        let position = ModalPosition {
            id: modal.id.clone(),
            instance: modal.instance,
            revision: modal.revision,
            card: request.card,
        };
        emit_window(window, "modal-position", position).map_err(|e| e.to_string())?;
    }
    Ok(at)
}

/// id 와 instance 가 현재 모달과 같으면 모달 내용을 반환한다. 다른 모달이면 번호 0 의 빈 내용을
/// 반환하고, 모달 페이지는 그것을 버린다.
pub(crate) fn content(
    window: &Window,
    id: String,
    instance: u64,
) -> Result<RevisedContent, String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let content = state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|modal| modal.id == id && modal.instance == instance)
        .map(|modal| RevisedContent {
            revision: modal.revision,
            content: modal.content.clone(),
        })
        // 기본값: 다른 모달의 요청에는 번호 0 의 빈 내용으로 답하고 모달 페이지가 그것을 버린다(위 설명).
        .unwrap_or_default();
    // 검사가 응답을 붙잡았으면 놓을 때까지 보내지 않는다.
    #[cfg(feature = "diagnostics")]
    crate::diagnostics::hold_modal_content(window.label());
    Ok(content)
}

/// 이번 표시의 문서가 렌더링되면 모달 웹뷰를 표시한다.
pub(crate) fn ready(window: &Window, id: String, instance: u64) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let view = state
        .view
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("modal webview is gone")?;
    let first = {
        let mut held = state.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held
            .as_mut()
            .filter(|m| m.id == id && m.instance == instance)
        else {
            return Ok(());
        };
        if modal.shown {
            emit_window(window, "modal-rendered", &id).map_err(|e| e.to_string())?;
            exposure::log(window, &format!("observe: modal rendered {id}"));
            return Ok(());
        }
        modal.shown = true;
        modal.clone()
    };
    let platform = platform::current()?;
    set_background(window, first.content.mode == "dialog")?;
    view.with_webview(move |webview| {
        log_failure(
            "modal corners",
            platform.round_corners(&webview, first.radius),
        );
        log_failure("modal raise", platform.raise_webview(&webview));
    })
    .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    let host = window.clone();
    view.with_webview(move |webview| {
        if let Err(error) = platform.focus_webview(&webview) {
            log_error(&format!("modal {id}"), error);
            return;
        }
        let marked = window_data(&host).and_then(|context| {
            let mut open = context.overlay.open.lock().map_err(|e| e.to_string())?;
            if let Some(modal) = open
                .as_mut()
                .filter(|m| m.id == id && m.instance == instance)
            {
                modal.visible = true;
            }
            Ok(())
        });
        log_failure(&format!("modal {id}"), marked);
        if let Err(error) = emit_window(&host, "modal-rendered", &id) {
            log_error("modal-rendered", error);
        }
        exposure::log(&host, &format!("observe: modal rendered {id}"));
        exposure::window_changed(&host);
    })
    .map_err(|e| e.to_string())
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
    // `discard`는 open 기록도 지운다. 같은 mutex를 잡은 상태에서 호출하지 않는다.
    // 그렇게 하면 main thread가 자신의 lock을 기다리며 모든 endpoint request의 처리를
    // 멈춘다.
    state.discard()?;
    exposure::window_changed(window);
    // terminal image region은 `resignFirstResponder`를 동기적으로 보고한다. 여기서 `set_focus`를
    // 호출하면 현재 Tauri invoke가 아직 WebKit dispatch lock을 소유한 상태에서 main WebView에
    // 다시 진입하므로, focus callback이 event loop를 deadlock시킬 수 있다.
    // 먼저 hide command에서 반환한 뒤 다음 AppKit turn에서 focus를 복원한다.
    // 그 turn 전에 교체 modal이 열렸을 수 있다. 그 경우 이전 복원은
    // 교체 child WebView의 focus를 가져가지 않아야 한다.
    let host = window.clone();
    platform::current()?
        .enqueue_ui(Box::new(move || {
            let has_modal = window_data(&host)
                .ok()
                .and_then(|context| context.overlay.open_state())
                .is_some();
            if has_modal {
                return;
            }
            if let Some(main) = root_view(&host) {
                if let Err(error) = main.set_focus() {
                    log_error("modal focus restoration", error);
                }
            }
        }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 현재 모달 문서의 선택을 페이지에 전달한다. 이전 문서는 뷰가 제거된 뒤에도 답을 보낼 수
/// 있으므로 id 와 instance 를 확인한다.
pub(crate) fn pick(
    window: &Window,
    id: String,
    instance: u64,
    key: String,
    value: String,
) -> Result<(), String> {
    let context = window_data(window)?;
    let state = &context.overlay;

    let current = state
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .is_some_and(|m| m.id == id && m.instance == instance);
    if current && root_view(window).is_some() {
        emit_window(window, "overlay-pick", Picked { id, key, value })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 열린 모달의 내용을 뷰를 다시 만들지 않고 바꾼다. 페이지 상태를 바꾸는 컨트롤이 있는 모달은
/// 열린 동안 다시 그려지고, 뷰를 다시 만들면 깜박인다.
pub(crate) fn update(window: &Window, request: UpdateRequest) -> Result<(), String> {
    let context = window_data(window)?;
    let overlay = &context.overlay;

    let content = OverlayContent {
        mode: request.mode,
        card: request.card,
        title: request.title,
        css: request.css,
        class_name: request.class_name,
        html: request.html,
        border: request.border,
    };
    let (instance, revision) = {
        let mut held = overlay.open.lock().map_err(|e| e.to_string())?;
        let Some(modal) = held.as_mut().filter(|m| m.id == request.id) else {
            return Ok(());
        };
        modal.content = content.clone();
        modal.revision += 1;
        (modal.instance, modal.revision)
    };
    // 모든 페이지가 이벤트를 받으므로 id 를 포함하고, 각 모달 페이지는 자신의 이벤트만 사용한다.
    emit_window(
        window,
        "modal-content",
        ModalContentEvent {
            instance,
            id: request.id,
            revision,
            content,
        },
    )
    .map_err(|e| e.to_string())
}
