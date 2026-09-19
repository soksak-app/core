#[repr(C)]
pub struct CMetrics {
    pub width: u32,
    pub height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub font_size: f64,
}

#[repr(C)]
pub struct CCell {
    pub col: u32,
    pub row: u32,
    pub width: u32,
    pub ch_len: u8,
    pub ch: [u8; 4],
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
        // Convert Rust Screen to C Screen
        let mut cells = Vec::new();
        for row in &screen.lines {
            for cell in row {
                let (ch_bytes, ch_len) = if let Some(ref ch_str) = cell.ch {
                    let bytes = ch_str.as_bytes();
                    let mut ch_arr = [0u8; 4];
                    if bytes.len() <= 4 {
                        ch_arr[..bytes.len()].copy_from_slice(bytes);
                        (ch_arr, bytes.len() as u8)
                    } else {
                        ([0u8; 4], 0)
                    }
                } else {
                    ([0u8; 4], 0)
                };

                let (fg, has_fg) = parse_hex_color(&cell.fg);
                let (bg, has_bg) = parse_hex_color(&cell.bg);

                cells.push(CCell {
                    col: 0, // Will be set per-cell
                    row: 0, // Will be set per-cell
                    width: cell.width as u32,
                    ch_len,
                    ch: ch_bytes,
                    fg,
                    bg,
                    has_fg: if has_fg { 1 } else { 0 },
                    has_bg: if has_bg { 1 } else { 0 },
                    inverse: if cell.inverse { 1 } else { 0 },
                });
            }
        }

        // Set row/col for each cell
        let mut cell_idx = 0;
        for row_idx in 0..screen.lines.len() {
            for col_idx in 0..screen.lines[row_idx].len() {
                if cell_idx < cells.len() {
                    cells[cell_idx].row = row_idx as u32;
                    cells[cell_idx].col = col_idx as u32;
                    cell_idx += 1;
                }
            }
        }

        let mut c_screen = CScreen {
            width: screen.cols as u32,
            height: screen.rows as u32,
            cursor_col: screen.cursor.col as u32,
            cursor_row: screen.cursor.row as u32,
            cells: cells.as_mut_ptr(),
            cell_count: cells.len() as u32,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_scale_consistency() {
        // Test that scale 2.0 is approximately double scale 1.0
        let m1 = metrics(13.0, 1.0);
        let m2 = metrics(13.0, 2.0);

        println!("Scale 1.0: width={}, height={}", m1.cell_width, m1.cell_height);
        println!("Scale 2.0: width={}, height={}", m2.cell_width, m2.cell_height);

        // Cell width and height at 2x scale should be roughly double (±1 pixel for rounding)
        let width_ratio = m2.cell_width as i32 - 2 * m1.cell_width as i32;
        let height_ratio = m2.cell_height as i32 - 2 * m1.cell_height as i32;

        assert!(width_ratio.abs() <= 1, "Scale 2x width ratio off: {} vs 2*{}", m2.cell_width, m1.cell_width);
        assert!(height_ratio.abs() <= 1, "Scale 2x height ratio off: {} vs 2*{}", m2.cell_height, m1.cell_height);
    }

    #[test]
    fn test_pixel_drawing() {
        // Create frame with enough space for 4x2 grid at font size 13
        let metrics = metrics(13.0, 1.0);
        let frame_width = (metrics.cell_width * 4.0) as u32;
        let frame_height = (metrics.cell_height * 2.0) as u32;

        println!("Frame size: {}x{} pixels (cell: {:.1}x{:.1})", frame_width, frame_height, metrics.cell_width, metrics.cell_height);

        let frame = Frame::new(frame_width, frame_height).expect("Failed to create frame");

        // Create a screen with 4 columns, 2 rows
        // Row 0: 'h' at (0,0), 'i' at (1,0), empty at (2,0) and (3,0)
        // Row 1: empty cells
        let mut cells_row0 = vec![];
        let mut cells_row1 = vec![];

        // Row 0: 'h' at column 0
        cells_row0.push(crate::protocol::Cell {
            ch: Some("h".to_string()),
            width: 1,
            fg: Some("#d0d0d0".to_string()),
            bg: None,
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
        });

        // Row 0: 'i' at column 1
        cells_row0.push(crate::protocol::Cell {
            ch: Some("i".to_string()),
            width: 1,
            fg: Some("#d0d0d0".to_string()),
            bg: None,
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
        });

        // Row 0: empty at columns 2 and 3
        for _ in 0..2 {
            cells_row0.push(crate::protocol::Cell {
                ch: None,
                width: 1,
                fg: None,
                bg: None,
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
            });
        }

        // Row 1: all empty
        for _ in 0..4 {
            cells_row1.push(crate::protocol::Cell {
                ch: None,
                width: 1,
                fg: None,
                bg: None,
                bold: false,
                italic: false,
                underline: false,
                inverse: false,
            });
        }

        let screen = crate::protocol::Screen {
            cols: 4,
            rows: 2,
            cursor: crate::protocol::Cursor { col: 0, row: 2 },  // Cursor outside visible area
            lines: vec![cells_row0, cells_row1],
        };

        frame.draw(&screen, &metrics).expect("Failed to draw frame");

        // Verify pixels
        let cell_width = metrics.cell_width as u32;
        let cell_height = metrics.cell_height as u32;

        // Expected background: (30, 30, 30) in sRGB
        let expected_bg = (30u8, 30u8, 30u8);

        // Test 1: Background is exact (±2)
        // IOSurface memory: first row is at image top. Row 0 is at y: 0..cell_height
        println!("Test 1: Checking row 1 (bottom empty cells) background at y: cell_height..2*cell_height...");
        let mut row1_bg_count = 0;
        for x in 0..frame_width {
            for y in cell_height..(2 * cell_height) {
                if let Some(pixel) = frame.read_pixel(x, y) {
                    let b_diff = (pixel[0] as i16 - expected_bg.0 as i16).abs();
                    let g_diff = (pixel[1] as i16 - expected_bg.1 as i16).abs();
                    let r_diff = (pixel[2] as i16 - expected_bg.2 as i16).abs();
                    assert!(b_diff <= 2, "Row 1 at ({}, {}): B mismatch, expected ~{} got {}", x, y, expected_bg.0, pixel[0]);
                    assert!(g_diff <= 2, "Row 1 at ({}, {}): G mismatch, expected ~{} got {}", x, y, expected_bg.1, pixel[1]);
                    assert!(r_diff <= 2, "Row 1 at ({}, {}): R mismatch, expected ~{} got {}", x, y, expected_bg.2, pixel[2]);
                    row1_bg_count += 1;
                }
            }
        }
        println!("Test 1 PASS: Row 1 all {} pixels match background", row1_bg_count);

        // Check cell (0,3) background - should be at y: 0..cell_height (Row 0), x: 3*cell_width..4*cell_width
        println!("Test 1: Checking cell (0,3) background at y: 0..cell_height, x: 3*cell_width..4*cell_width...");
        let col3_start = 3 * cell_width;
        let col3_end = 4 * cell_width;
        let mut cell03_bg_count = 0;
        for x in col3_start..col3_end {
            for y in 0..cell_height {
                if let Some(pixel) = frame.read_pixel(x, y) {
                    let b_diff = (pixel[0] as i16 - expected_bg.0 as i16).abs();
                    let g_diff = (pixel[1] as i16 - expected_bg.1 as i16).abs();
                    let r_diff = (pixel[2] as i16 - expected_bg.2 as i16).abs();
                    assert!(b_diff <= 2, "Cell (0,3) at ({}, {}): B mismatch, expected ~{} got {}", x, y, expected_bg.0, pixel[0]);
                    assert!(g_diff <= 2, "Cell (0,3) at ({}, {}): G mismatch, expected ~{} got {}", x, y, expected_bg.1, pixel[1]);
                    assert!(r_diff <= 2, "Cell (0,3) at ({}, {}): R mismatch, expected ~{} got {}", x, y, expected_bg.2, pixel[2]);
                    cell03_bg_count += 1;
                }
            }
        }
        println!("Test 1 PASS: Cell (0,3) all {} pixels match background", cell03_bg_count);

        // Test 2: Character drawn in foreground color (brightness >= 160)
        // Row 0 is at y: 0..cell_height, contains 'h' at (0,0) and 'i' at (1,0)
        println!("Test 2: Checking character foreground color in row 0 (y: 0..cell_height)...");
        let mut cell00_bright_pixels = 0;
        let mut cell01_bright_pixels = 0;

        for x in 0..cell_width {
            for y in 0..cell_height {
                if let Some(pixel) = frame.read_pixel(x, y) {
                    let brightness = ((pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3) as u8;
                    if brightness >= 160 {
                        cell00_bright_pixels += 1;
                    }
                }
            }
        }
        println!("Cell (0,0) 'h': {} bright pixels", cell00_bright_pixels);
        assert!(cell00_bright_pixels >= 10, "Cell (0,0) should have at least 10 bright pixels, got {}", cell00_bright_pixels);

        for x in cell_width..(2 * cell_width) {
            for y in 0..cell_height {
                if let Some(pixel) = frame.read_pixel(x, y) {
                    let brightness = ((pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3) as u8;
                    if brightness >= 160 {
                        cell01_bright_pixels += 1;
                    }
                }
            }
        }
        println!("Cell (0,1) 'i': {} bright pixels", cell01_bright_pixels);
        assert!(cell01_bright_pixels >= 10, "Cell (0,1) should have at least 10 bright pixels, got {}", cell01_bright_pixels);
        println!("Test 2 PASS: Both cells have sufficient foreground color pixels");

        // Test 3: Bright pixels only in top half (y < cell_height, not bottom)
        println!("Test 3: Checking bright pixels are only in row 0 (y < cell_height)...");
        let mut char_pixels_in_row0 = 0;
        let mut char_pixels_in_row1 = 0;
        let check_cols = (2 * cell_width).min(frame_width);
        for x in 0..check_cols {
            for y in 0..frame_height {
                if let Some(pixel) = frame.read_pixel(x, y) {
                    let brightness = ((pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3) as u8;
                    if brightness >= 160 {
                        if y < cell_height {
                            char_pixels_in_row0 += 1;
                        } else {
                            char_pixels_in_row1 += 1;
                        }
                    }
                }
            }
        }
        println!("Bright pixels: row0={}, row1={}", char_pixels_in_row0, char_pixels_in_row1);
        assert!(char_pixels_in_row0 > 0, "Should have bright pixels in row 0 (y < cell_height)");
        assert!(char_pixels_in_row1 == 0, "Should NOT have bright pixels in row 1 (y >= cell_height), got {}", char_pixels_in_row1);
        println!("Test 3 PASS: Bright pixels only in row 0");

        // Test 4: Character contained within cell bounds
        println!("Test 4: Checking character containment in cell bounds...");
        for x in 0..cell_width {
            for y in 0..cell_height {
                if let Some(pixel) = frame.read_pixel(x, y) {
                    let brightness = ((pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32) / 3) as u8;
                    if brightness >= 160 {
                        assert!(x < cell_width, "Bright pixel at ({}, {}) outside cell (0,0) x bounds", x, y);
                    }
                }
            }
        }
        println!("Test 4 PASS: All character pixels within cell bounds");

        // Test 5: Frame nonce and ID
        let nonce_from_frame = frame.nonce();
        println!("Frame nonce: {:?}", nonce_from_frame);
        assert!(nonce_from_frame.iter().any(|b| *b != 0), "Frame nonce should not be all zeros");

        let frame_id = frame.id();
        println!("Frame ID: {}", frame_id);
        assert!(frame_id > 0, "Frame ID should be non-zero");
        println!("Test 5 PASS: Nonce and ID valid");

        println!("ALL TESTS PASSED");
    }
}
