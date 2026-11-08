// The pixels of a frame. A frame is the declared color of its session, filled over the whole raster; the requested rows, painted
// from the top as bands of the row color one cell tall, each ending in a line of the session color so that the bands can be
// counted; and the identity marker, a square one cell tall at the bottom right whose color carries the frame identity: red is the
// low byte of the generation, green and blue the two low bytes of the sequence. The pixels are opaque premultiplied BGRA.

/// The cell of the grid at text size factor 1 in points; the cell in device pixels is this times the factor times the scale.
pub const CELL_POINTS: (f64, f64) = (8.0, 16.0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// Parses `#rrggbb` in either case.
    pub fn parse(text: &str) -> Option<Rgb> {
        let hex = text.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |index: usize| u8::from_str_radix(&hex[index..index + 2], 16).ok();
        Some(Rgb(byte(0)?, byte(2)?, byte(4)?))
    }

    /// The lowercase `#rrggbb` form.
    pub fn text(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    /// The color of the row bands: black on a light color and white on a dark one.
    pub fn contrast(self) -> Rgb {
        let luminance = 299 * u32::from(self.0) + 587 * u32::from(self.1) + 114 * u32::from(self.2);
        if luminance >= 128_000 { Rgb(0, 0, 0) } else { Rgb(255, 255, 255) }
    }
}

/// The grid of a raster: the cell size in device pixels and the rows and columns that fit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grid {
    pub cell_width: u32,
    pub cell_height: u32,
    pub rows: u32,
    pub cols: u32,
}

impl Grid {
    pub fn of(width: u32, height: u32, scale: f64, factor: f64) -> Grid {
        let cell = |points: f64| ((points * factor * scale).round() as u32).max(1);
        let cell_width = cell(CELL_POINTS.0);
        let cell_height = cell(CELL_POINTS.1);
        Grid { cell_width, cell_height, rows: height / cell_height, cols: width / cell_width }
    }
}

/// What a frame shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scene {
    pub width: u32,
    pub height: u32,
    pub grid: Grid,
    pub color: Rgb,
    /// The bands to paint, at most the rows of the grid.
    pub rows: u32,
    pub generation: u64,
    pub sequence: u64,
}

impl Scene {
    /// The color of the identity marker of the frame.
    pub fn marker(&self) -> Rgb {
        Rgb((self.generation & 0xff) as u8, ((self.sequence >> 8) & 0xff) as u8, (self.sequence & 0xff) as u8)
    }

    /// The side of the identity marker in device pixels.
    pub fn marker_side(&self) -> u32 {
        self.grid.cell_height.min(self.width).min(self.height)
    }
}

fn fill(buffer: &mut [u8], stride: usize, x0: u32, y0: u32, x1: u32, y1: u32, color: Rgb) {
    for y in y0..y1 {
        let row = &mut buffer[y as usize * stride..];
        for x in x0..x1 {
            let at = x as usize * 4;
            row[at..at + 4].copy_from_slice(&[color.2, color.1, color.0, 255]);
        }
    }
}

/// Paints the scene into a BGRA buffer of `stride` bytes per row that holds at least `scene.height` rows.
pub fn paint(buffer: &mut [u8], stride: usize, scene: &Scene) {
    assert!(stride >= scene.width as usize * 4, "the stride {stride} is shorter than a row of {} pixels", scene.width);
    assert!(buffer.len() >= stride * scene.height as usize, "the buffer is shorter than {} rows", scene.height);
    fill(buffer, stride, 0, 0, scene.width, scene.height, scene.color);
    let band = scene.color.contrast();
    let cell = scene.grid.cell_height;
    for row in 0..scene.rows.min(scene.grid.rows) {
        let top = row * cell;
        fill(buffer, stride, 0, top, scene.width, top + cell - 1, band);
    }
    let side = scene.marker_side();
    fill(buffer, stride, scene.width - side, scene.height - side, scene.width, scene.height, scene.marker());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(buffer: &[u8], stride: usize, x: u32, y: u32) -> Rgb {
        let at = y as usize * stride + x as usize * 4;
        assert_eq!(buffer[at + 3], 255, "the pixel {x},{y} is not opaque");
        Rgb(buffer[at + 2], buffer[at + 1], buffer[at])
    }

    #[test]
    fn colors_parse_in_either_case_and_print_in_lowercase() {
        assert_eq!(Rgb::parse("#0A80fF"), Some(Rgb(10, 128, 255)));
        assert_eq!(Rgb(10, 128, 255).text(), "#0a80ff");
        for text in ["0a80ff", "#0a80f", "#0a80fg", "#0a80ff0"] {
            assert_eq!(Rgb::parse(text), None, "{text}");
        }
    }

    #[test]
    fn the_grid_follows_the_scale_and_the_text_size_factor() {
        assert_eq!(Grid::of(800, 600, 2.0, 1.0), Grid { cell_width: 16, cell_height: 32, rows: 18, cols: 50 });
        assert_eq!(Grid::of(800, 600, 2.0, 1.5), Grid { cell_width: 24, cell_height: 48, rows: 12, cols: 33 });
        assert_eq!(Grid::of(10, 10, 1.0, 0.01), Grid { cell_width: 1, cell_height: 1, rows: 10, cols: 10 });
    }

    #[test]
    fn a_frame_shows_its_color_its_row_bands_and_its_identity_marker() {
        let (width, height) = (40, 30);
        let grid = Grid::of(width, height, 1.0, 0.5);
        assert_eq!(grid, Grid { cell_width: 4, cell_height: 8, rows: 3, cols: 10 });
        let scene = Scene { width, height, grid, color: Rgb(0, 80, 180), rows: 2, generation: 0x103, sequence: 0x0204 };
        let stride = width as usize * 4 + 16;
        let mut buffer = vec![0; stride * height as usize];
        paint(&mut buffer, stride, &scene);
        let band = Rgb(255, 255, 255);
        assert_eq!(pixel(&buffer, stride, 0, 0), band);
        assert_eq!(pixel(&buffer, stride, 0, 6), band);
        assert_eq!(pixel(&buffer, stride, 0, 7), scene.color, "each band ends in a line of the session color");
        assert_eq!(pixel(&buffer, stride, 0, 8), band);
        assert_eq!(pixel(&buffer, stride, 0, 16), scene.color, "only the requested rows are painted");
        assert_eq!(pixel(&buffer, stride, 39, 29), Rgb(3, 2, 4));
        assert_eq!(pixel(&buffer, stride, 32, 22), Rgb(3, 2, 4));
        assert_eq!(pixel(&buffer, stride, 31, 22), scene.color);
    }

    #[test]
    fn requested_rows_beyond_the_grid_paint_the_rows_that_fit() {
        let (width, height) = (16, 20);
        let grid = Grid::of(width, height, 1.0, 0.5);
        let scene = Scene { width, height, grid, color: Rgb(250, 250, 250), rows: 9, generation: 1, sequence: 1 };
        let mut buffer = vec![0; width as usize * 4 * height as usize];
        paint(&mut buffer, width as usize * 4, &scene);
        assert_eq!(pixel(&buffer, width as usize * 4, 0, 8), Rgb(0, 0, 0), "a light color takes black bands");
        assert_eq!(pixel(&buffer, width as usize * 4, 0, 17), scene.color, "the rest below the grid keeps the color");
    }
}
