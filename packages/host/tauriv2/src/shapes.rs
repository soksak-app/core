//! The shapes drawn over a surface.
//!
//! A shape is a layer-backed view and not a webview, so the alpha of the fill color and the line color is composed over
//! the surface content.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::Window;

use crate::platform::{self, Handle};
use crate::surfaces::Rect;
use crate::windows::{native_owner, window_data};

/// A rectangle that the page draws over a surface.
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

/// A shape view on the screen. It is found by id.
#[derive(Default)]
pub(crate) struct Shapes(pub Mutex<HashMap<String, Handle>>);

/// Converts the 0-255 color channels of the page into the 0-1 range of AppKit. The alpha is already in the 0-1 range.
fn srgba(c: [f64; 4]) -> [f64; 4] {
    [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, c[3]]
}

/// Creates or moves a shape and applies its style.
pub(crate) fn set(window: &Window, request: ShapeRequest) -> Result<(), String> {
    let context = window_data(window)?;
    let shapes = &context.shapes;
    let platform = platform::current()?;

    // A shape is added directly to the content view, so its coordinates are AppKit coordinates with the origin at the
    // lower left. Tauri converts the coordinates of a child webview, but a shape is converted here.
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

/// Removes the shape of id.
pub(crate) fn clear(window: &Window, id: String) -> Result<(), String> {
    let context = window_data(window)?;
    let shapes = &context.shapes;

    let mut held = shapes.0.lock().map_err(|e| e.to_string())?;
    if let Some(view) = held.remove(&id) {
        platform::current()?.destroy_shape(view)?;
    }
    Ok(())
}
