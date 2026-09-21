#[repr(C)]
pub struct CMetrics {
    pub width: u32,
    pub height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub font_size: f64,
}

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[repr(C)]
pub struct CCell {
    pub col: u32,
    pub row: u32,
    pub width: u32,
    pub ch: *const u8,
    pub ch_len: u32,
    pub fg: [u8; 3],
    pub bg: [u8; 3],
    pub has_fg: u8,
    pub has_bg: u8,
    pub inverse: u8,
}

#[repr(C)]
pub struct CScreen {
    pub width: u32,
    pub height: u32,
    pub cursor_col: u32,
    pub cursor_row: u32,
    pub cells: *mut CCell,
    pub cell_count: u32,
    pub cursor_visible: u8,
    pub cursor_focused: u8,
    pub cursor_blink_visible: u8,
    pub cursor_shape: u8,
    pub default_foreground: [u8; 3],
    pub default_background: [u8; 3],
    pub default_cursor: [u8; 3],
}

// Opaque frame type
#[repr(C)]
pub struct CFrame {
    _private: [u8; 0],
}

// IOSurface is thread-safe, so it's safe to send Frame across threads
unsafe impl Send for CFrame {}
unsafe impl Sync for CFrame {}

extern "C" {
    fn frame_new(width_px: u32, height_px: u32) -> *mut CFrame;
    fn frame_id(frame: *mut CFrame) -> u32;
    fn frame_nonce(frame: *mut CFrame, buf: *mut u8);
    fn frame_draw(frame: *mut CFrame, screen: *mut CScreen, metrics: *mut CMetrics) -> i32;
    fn frame_drop(frame: *mut CFrame);
    fn frame_metrics(font_size: f64, scale: f64) -> CMetrics;
    fn frame_pixel(frame: *mut CFrame, x: u32, y: u32, out: *mut u8) -> i32;
}

pub struct Frame {
    ptr: *mut CFrame,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorRender {
    pub visible: bool,
    pub focused: bool,
    pub blink_visible: bool,
    pub shape: crate::protocol::CursorShape,
}

impl CursorRender {
    fn from_protocol(cursor: &crate::protocol::Cursor) -> Self {
        Self {
            visible: cursor.visible,
            focused: cursor.focused,
            // 엔진의 blinking 값은 활성화 상태일 뿐이다. phase는 서비스 scheduler가 전달한다.
            blink_visible: true,
            shape: cursor.shape,
        }
    }
}

impl Default for CursorRender {
    fn default() -> Self {
        Self {
            visible: true,
            focused: false,
            blink_visible: true,
            shape: crate::protocol::CursorShape::Block,
        }
    }
}

// Frame is Send/Sync because CFrame (IOSurface) is thread-safe
unsafe impl Send for Frame {}
unsafe impl Sync for Frame {}

impl Frame {
    pub fn new(width_px: u32, height_px: u32) -> Option<Frame> {
        unsafe {
            let ptr = frame_new(width_px, height_px);
            if ptr.is_null() {
                None
            } else {
                Some(Frame { ptr })
            }
        }
    }

    pub fn id(&self) -> u32 {
        unsafe { frame_id(self.ptr) }
    }

    pub fn nonce(&self) -> [u8; 16] {
        let mut buf = [0u8; 16];
        unsafe {
            frame_nonce(self.ptr, buf.as_mut_ptr());
        }
        buf
    }

    pub fn draw(&self, screen: &crate::protocol::Screen, metrics: &Metrics) -> Result<(), String> {
        self.draw_with_cursor(screen, metrics, CursorRender::from_protocol(&screen.cursor))
    }

    pub fn draw_with_cursor(
        &self,
        screen: &crate::protocol::Screen,
        metrics: &Metrics,
        cursor: CursorRender,
    ) -> Result<(), String> {
        let mut render_screen = screen.clone();
        if let Some(preedit) = render_screen.cursor.preedit.clone() {
            apply_preedit(&mut render_screen, &preedit)?;
        }
        // render_screen과 CCell이 참조하는 문자열은 이 호출이 끝날 때까지 Rust가 소유한다.
        // 네이티브 함수는 이 빌린 포인터를 저장하지 않는다.
        // Rust Screen을 C Screen으로 변환한다.
        let mut cells = Vec::new();
        for row in &render_screen.lines {
            for cell in row {
                let (fg, has_fg) = parse_hex_color(&cell.fg);
                let (bg, has_bg) = parse_hex_color(&cell.bg);

                cells.push(CCell {
                    col: 0, // 셀별 위치를 아래에서 설정한다.
                    row: 0, // 셀별 위치를 아래에서 설정한다.
                    width: cell.width as u32,
                    ch: cell
                        .ch
                        .as_ref()
                        .map_or(std::ptr::null(), |text| text.as_ptr()),
                    ch_len: cell.ch.as_ref().map_or(0, |text| text.len() as u32),
                    fg,
                    bg,
                    has_fg: if has_fg { 1 } else { 0 },
                    has_bg: if has_bg { 1 } else { 0 },
                    inverse: if cell.inverse { 1 } else { 0 },
                });
            }
        }

        // 모든 셀의 행과 열을 설정한다.
        let mut cell_idx = 0;
        for row_idx in 0..render_screen.lines.len() {
            for col_idx in 0..render_screen.lines[row_idx].len() {
                if cell_idx < cells.len() {
                    cells[cell_idx].row = row_idx as u32;
                    cells[cell_idx].col = col_idx as u32;
                    cell_idx += 1;
                }
            }
        }

        let mut c_screen = CScreen {
            width: render_screen.cols as u32,
            height: render_screen.rows as u32,
            cursor_col: render_screen.cursor.col as u32,
            cursor_row: render_screen.cursor.row as u32,
            cells: cells.as_mut_ptr(),
            cell_count: cells.len() as u32,
            cursor_visible: cursor.visible as u8,
            cursor_focused: cursor.focused as u8,
            cursor_blink_visible: cursor.blink_visible as u8,
            cursor_shape: match cursor.shape {
                crate::protocol::CursorShape::Block => 0,
                crate::protocol::CursorShape::Underline => 1,
                crate::protocol::CursorShape::Beam => 2,
                crate::protocol::CursorShape::HollowBlock => 3,
                crate::protocol::CursorShape::Hidden => 4,
            },
            default_foreground: crate::palette::DEFAULT_FOREGROUND_RGB,
            default_background: crate::palette::DEFAULT_BACKGROUND_RGB,
            default_cursor: crate::palette::DEFAULT_CURSOR_RGB,
        };

        let mut c_metrics = CMetrics {
            width: 0,
            height: 0,
            cell_width: metrics.cell_width as u32,
            cell_height: metrics.cell_height as u32,
            font_size: metrics.font_size as f64,
        };

        let result = unsafe { frame_draw(self.ptr, &mut c_screen, &mut c_metrics) };

        if result == 0 {
            Ok(())
        } else {
            Err("Frame draw failed".to_string())
        }
    }

    pub fn read_pixel(&self, x: u32, y: u32) -> Option<[u8; 4]> {
        let mut bgra = [0u8; 4];
        unsafe {
            if frame_pixel(self.ptr, x, y, bgra.as_mut_ptr()) == 0 {
                Some(bgra)
            } else {
                None
            }
        }
    }
}

fn utf16_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn valid_json_range(
    range: Option<crate::protocol::JsonRange>,
    text_length: Option<usize>,
    name: &str,
) -> Result<(), String> {
    if let Some(crate::protocol::JsonRange { location, length }) = range {
        let end = location
            .checked_add(length)
            .ok_or_else(|| format!("{name} JSON range overflows UTF-16 location"))?;
        if let Some(limit) = text_length {
            if end > limit {
                return Err(format!("{name} JSON range [{location}, {length}] exceeds preedit UTF-16 length {limit}"));
            }
        }
    }
    Ok(())
}

fn selected_contains(range: Option<crate::protocol::JsonRange>, start: usize, end: usize) -> bool {
    range.is_some_and(|crate::protocol::JsonRange { location, length }| {
        let range_end = location.saturating_add(length);
        start < range_end && end > location
    })
}

fn apply_preedit(
    screen: &mut crate::protocol::Screen,
    preedit: &crate::protocol::Preedit,
) -> Result<(), String> {
    let length = utf16_length(&preedit.text);
    valid_json_range(preedit.selected_range, Some(length), "selectedRange")?;
    // replacementRange는 호스트 문서의 marked range인 [location,length]다.
    // 새 preedit 문자열의 범위가 아니므로 preedit UTF-16 길이로 제한하지 않는다.
    valid_json_range(preedit.replacement_range, None, "replacementRange")?;
    let row = screen.cursor.row as usize;
    while screen.lines.len() <= row {
        screen.lines.push(Vec::new());
    }
    let display_col = screen.cursor.col as usize;
    let line = &mut screen.lines[row];
    let mut marked = Vec::new();
    let mut utf16_col = 0;
    for grapheme in preedit.text.graphemes(true) {
        if grapheme.contains('\n') || grapheme.contains('\r') {
            return Err("preedit must be a single-line renderable grapheme sequence".to_string());
        }
        let utf16_end = utf16_col + grapheme.encode_utf16().count();
        let width = UnicodeWidthStr::width(grapheme);
        if width == 0 {
            utf16_col = utf16_end;
            continue;
        }
        let width = u8::try_from(width)
            .map_err(|_| "preedit grapheme display width exceeds Cell width".to_string())?;
        let mut cell = crate::protocol::Cell::default();
        cell.ch = Some(grapheme.to_string());
        cell.width = width;
        cell.underline = true;
        if selected_contains(preedit.selected_range, utf16_col, utf16_end) {
            cell.bg = Some("#808080".to_string());
        }
        marked.push(cell);
        for _ in 1..width {
            marked.push(crate::protocol::Cell::default());
        }
        utf16_col = utf16_end;
    }
    if display_col + marked.len() > screen.cols as usize {
        return Err("preedit extends beyond terminal columns".to_string());
    }
    while line.len() < display_col + marked.len() {
        line.push(crate::protocol::Cell::default());
    }
    let tail = line.split_off(display_col + marked.len());
    line.truncate(display_col);
    line.extend(marked);
    line.extend(tail);
    Ok(())
}

impl Drop for Frame {
    fn drop(&mut self) {
        unsafe {
            frame_drop(self.ptr);
        }
    }
}

pub struct Metrics {
    pub cell_width: f32,
    pub cell_height: f32,
    pub font_size: f32,
}

pub fn metrics(font_size: f32, scale: f32) -> Metrics {
    let c_metrics = unsafe { frame_metrics(font_size as f64, scale as f64) };
    Metrics {
        cell_width: c_metrics.cell_width as f32,
        cell_height: c_metrics.cell_height as f32,
        font_size: c_metrics.font_size as f32,
    }
}

fn parse_hex_color(color_opt: &Option<String>) -> ([u8; 3], bool) {
    if let Some(color_str) = color_opt {
        if color_str.starts_with('#') && color_str.len() == 7 {
            if let Ok(val) = u32::from_str_radix(&color_str[1..], 16) {
                let r = ((val >> 16) & 0xFF) as u8;
                let g = ((val >> 8) & 0xFF) as u8;
                let b = (val & 0xFF) as u8;
                return ([r, g, b], true);
            }
        }
    }
    ([0, 0, 0], false)
}
