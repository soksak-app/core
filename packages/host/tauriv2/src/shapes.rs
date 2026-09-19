//! 표면 위에 그리는 도형.
//!
//! 도형은 웹뷰가 아닌 레이어 기반 뷰이므로 채움 색과 선 색의 알파가 표면 내용 위에 합성된다.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::Window;

use crate::platform::{self, Handle};
use crate::surfaces::Rect;
use crate::windows::{native_owner, window_data};

/// 페이지가 표면 위에 그리는 사각형.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShapeRequest {
    id: String,
    rect: Rect,
    radius: f64,
    line_width: f64,
    fill: [f64; 4],
    line: [f64; 4],
}

/// 화면에 있는 도형 뷰. id 로 찾는다.
#[derive(Default)]
pub(crate) struct Shapes(pub Mutex<HashMap<String, Handle>>);

/// 페이지의 0-255 색 채널을 AppKit 의 0-1 범위로 바꾼다. 알파는 이미 0-1 범위이다.
fn srgba(c: [f64; 4]) -> [f64; 4] {
    [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, c[3]]
}

/// 도형을 만들거나 옮기고 스타일을 적용한다.
pub(crate) fn set(window: &Window, request: ShapeRequest) -> Result<(), String> {
    let context = window_data(window)?;
    let shapes = &context.shapes;
    let platform = platform::current()?;

    // 도형은 콘텐츠 뷰에 직접 추가하므로 좌표는 원점이 왼쪽 아래인 AppKit 좌표이다. 자식
    // 웹뷰는 Tauri 가 좌표를 변환하지만 도형은 여기서 변환한다.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let content = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale)
        .height;
    let h = request.rect.h.max(1.0);
    let frame = (
        request.rect.x,
        content - request.rect.y - h,
        request.rect.w.max(1.0),
        h,
    );
    let mut held = shapes.0.lock().map_err(|e| e.to_string())?;
    let view = match held.get(&request.id) {
        Some(&view) => {
            platform.place_shape(view, frame)?;
            view
        }
        None => {
            let handle = native_owner(window)?;
            let view = platform.create_shape(handle, frame)?;
            if view == 0 {
                return Ok(());
            }
            held.insert(request.id.clone(), view);
            platform.place_shape(view, frame)?;
            view
        }
    };
    platform.style_shape(
        view,
        request.radius,
        request.line_width,
        srgba(request.fill),
        srgba(request.line),
    )
}

/// id 의 도형을 제거한다.
pub(crate) fn clear(window: &Window, id: String) -> Result<(), String> {
    let context = window_data(window)?;
    let shapes = &context.shapes;

    let mut held = shapes.0.lock().map_err(|e| e.to_string())?;
    if let Some(view) = held.remove(&id) {
        platform::current()?.destroy_shape(view)?;
    }
    Ok(())
}
