#[cfg(target_os = "macos")]
pub use crate::platform::darwin::service;

#[cfg(target_os = "macos")]
pub use crate::platform::darwin::frame::{
    default_font, metrics, metrics_for, resolve_font_list, FontSelection, Frame, Metrics,
    TerminalFont,
};

#[cfg(target_os = "macos")]
pub struct ImageState {
    pub name: String,
    pub generation: u64,
    pub raster: u64,
    pub frame: Frame,
    pub metrics: Metrics,
    pub sequence: u32,
    pub pending_draw: bool,
    pub dirty: bool,
    pub width_px: u32,
    pub height_px: u32,
    pub scale: f32,
    pub theme: crate::palette::TerminalTheme,
    pub inline_images: Vec<crate::protocol::InlineImagePlacement>,
}

#[cfg(target_os = "macos")]
impl ImageState {
    pub fn new(
        name: String,
        generation: u64,
        raster: u64,
        width_px: u32,
        height_px: u32,
        scale: f32,
        font: &std::sync::Arc<TerminalFont>,
    ) -> Result<ImageState, String> {
        let frame = Frame::new(width_px, height_px)
            .ok_or_else(|| format!("IOSurface creation failed for {width_px}x{height_px}"))?;
        let device_metrics = metrics_for(font, 13.0, scale)?;
        Ok(ImageState {
            name,
            generation,
            raster,
            frame,
            metrics: device_metrics,
            sequence: 0,
            pending_draw: false,
            dirty: false,
            width_px,
            height_px,
            scale,
            theme: crate::palette::TerminalTheme::dark(),
            inline_images: Vec::new(),
        })
    }

    pub fn selection_cell(&self, x: f64, y: f64) -> Result<(u16, u16), String> {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
            return Err("selection coordinates must be finite and non-negative".to_string());
        }
        let cell_width = f64::from(self.metrics.cell_width) / f64::from(self.scale);
        let cell_height = f64::from(self.metrics.cell_height) / f64::from(self.scale);
        if cell_width <= 0.0 || cell_height <= 0.0 {
            return Err("selection cell metrics are unavailable".to_string());
        }
        let col = (x / cell_width).floor() as u16;
        let row = (y / cell_height).floor() as u16;
        let cols = (self.width_px as f32 / self.metrics.cell_width) as u16;
        let rows = (self.height_px as f32 / self.metrics.cell_height) as u16;
        if col >= cols || row >= rows {
            return Err(format!(
                "selection coordinates are outside the terminal grid: {x},{y}"
            ));
        }
        Ok((col, row))
    }
}

#[cfg(not(target_os = "macos"))]
pub struct ImageState;

#[cfg(not(target_os = "macos"))]
impl ImageState {
    pub fn new(
        _name: String,
        _generation: u64,
        _raster: u64,
        _width_px: u32,
        _height_px: u32,
        _scale: f32,
    ) -> Result<ImageState, String> {
        Err("terminal images are not implemented on this operating system".to_string())
    }

    pub fn selection_cell(&self, _x: f64, _y: f64) -> Result<(u16, u16), String> {
        Err("terminal selection is not implemented on this operating system".to_string())
    }
}
