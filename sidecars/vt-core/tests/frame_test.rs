use soksak_sidecar_vt_core::platform::darwin::frame::{metrics, CursorRender, Frame};
use soksak_sidecar_vt_core::protocol::{Cell, Cursor, CursorShape, JsonRange, Preedit, Screen};
use soksak_sidecar_vt_core::TerminalTheme;

fn screen(cols: u16, rows: u16) -> Screen {
    Screen {
        cols,
        rows,
        cursor: Cursor {
            col: 0,
            row: 0,
            shape: CursorShape::Block,
            visible: true,
            blinking: false,
            focused: false,
            preedit: None,
        },
        lines: (0..rows)
            .map(|_| (0..cols).map(|_| Cell::default()).collect())
            .collect(),
    }
}

fn bright(frame: &Frame, width: u32, height: u32) -> usize {
    (0..width)
        .flat_map(|x| (0..height).map(move |y| (x, y)))
        .filter_map(|(x, y)| frame.read_pixel(x, y))
        .filter(|pixel| pixel[0] > 100 || pixel[1] > 100 || pixel[2] > 100)
        .count()
}

fn bright_region(frame: &Frame, x0: u32, x1: u32, y0: u32, y1: u32) -> usize {
    (x0..x1)
        .flat_map(|x| (y0..y1).map(move |y| (x, y)))
        .filter_map(|(x, y)| frame.read_pixel(x, y))
        .filter(|pixel| pixel[0] > 100 || pixel[1] > 100 || pixel[2] > 100)
        .count()
}

fn pixels(frame: &Frame, width: u32, height: u32) -> Vec<[u8; 4]> {
    (0..width)
        .flat_map(|x| (0..height).map(move |y| (x, y)))
        .map(|(x, y)| frame.read_pixel(x, y).expect("pixel in frame"))
        .collect()
}

#[test]
fn cursor_styles_and_row_coordinates_are_pixel_distinct() {
    let metrics = metrics(13.0, 1.0);
    let width = metrics.cell_width as u32;
    let height = metrics.cell_height as u32;
    let mut state = screen(1, 3);
    state.cursor.row = 2;
    state.cursor.focused = true;
    let frame = Frame::new(width, height * 3).expect("frame");
    frame.draw(&state, &metrics).expect("cursor");
    assert!(bright(&frame, width, height * 3) > 0);
    let row_zero = frame.read_pixel(width / 2, height / 2).expect("row zero");
    let row_two = frame
        .read_pixel(width / 2, height * 2 + height / 2)
        .expect("row two");
    assert!(row_zero[0] < 100 && row_zero[1] < 100 && row_zero[2] < 100);
    assert!(row_two[0] > 100 || row_two[1] > 100 || row_two[2] > 100);

    let mut text_state = screen(1, 1);
    text_state.cursor.focused = true;
    text_state.lines[0][0].ch = Some("X".to_string());
    let text_frame = Frame::new(width, height).expect("text frame");
    text_frame
        .draw(&text_state, &metrics)
        .expect("inverted cursor");
    assert!(
        bright(&text_frame, width, height) < (width * height) as usize,
        "focused block erased the glyph instead of inverting it"
    );

    let hidden = Frame::new(width, height).expect("hidden frame");
    hidden
        .draw_with_cursor(
            &screen(1, 1),
            &metrics,
            CursorRender {
                visible: false,
                ..CursorRender::default()
            },
        )
        .expect("hidden cursor");
    assert_eq!(bright(&hidden, width, height), 0);
}

#[test]
fn complex_utf8_and_cjk_are_not_truncated_or_overlapped() {
    let metrics = metrics(13.0, 1.0);
    let mut state = screen(8, 1);
    state.lines[0][0].ch = Some("👩‍💻".to_string());
    state.lines[0][0].width = 2;
    state.lines[0][2].ch = Some("tail".to_string());
    let frame =
        Frame::new(metrics.cell_width as u32 * 8, metrics.cell_height as u32).expect("frame");
    frame.draw(&state, &metrics).expect("complex grapheme");
    assert!(
        bright(
            &frame,
            metrics.cell_width as u32 * 8,
            metrics.cell_height as u32
        ) > 0
    );

    state.lines[0][0].ch = None;
    state.lines[0][0].width = 1;
    state.lines[0][2].ch = Some("T".to_string());
    state.cursor.preedit = Some(Preedit {
        text: "한".to_string(),
        selected_range: None,
        replacement_range: None,
        attributed: false,
    });
    let marked = Frame::new(metrics.cell_width as u32 * 8, metrics.cell_height as u32)
        .expect("marked frame");
    marked
        .draw(&state, &metrics)
        .expect("marked text with tail");
    let tail_bright = bright_region(
        &marked,
        metrics.cell_width as u32 * 2,
        metrics.cell_width as u32 * 3,
        0,
        metrics.cell_height as u32,
    );
    assert!(
        tail_bright > 0,
        "existing text was overwritten by preedit: bright={tail_bright}"
    );
}

#[test]
fn preedit_uses_json_location_length_and_document_replacement_range() {
    let decoded: Preedit = serde_json::from_str(
        r#"{"text":"한글","selectedRange":{"location":2,"length":0},"replacementRange":{"location":400,"length":30},"attributed":true}"#,
    )
    .expect("native JSON range contract");
    assert_eq!(decoded.selected_range.unwrap().location, 2);
    assert_eq!(decoded.replacement_range.unwrap().length, 30);

    let metrics = metrics(13.0, 1.0);
    let mut state = screen(8, 1);
    state.cursor.preedit = Some(Preedit {
        text: "한😀".to_string(),
        selected_range: Some(JsonRange {
            location: 0,
            length: 1,
        }),
        replacement_range: Some(JsonRange {
            location: 400,
            length: 30,
        }),
        attributed: true,
    });
    let frame =
        Frame::new(metrics.cell_width as u32 * 8, metrics.cell_height as u32).expect("frame");
    frame
        .draw(&state, &metrics)
        .expect("document replacement range is not preedit-bounded");

    state.cursor.preedit.as_mut().unwrap().selected_range = Some(JsonRange {
        location: 0,
        length: 99,
    });
    assert!(frame.draw(&state, &metrics).is_err());
}

#[test]
fn cursor_metrics_are_stable_across_style_changes() {
    let before = metrics(13.0, 1.0);
    let frame = Frame::new(before.cell_width as u32, before.cell_height as u32).expect("frame");
    let state = screen(1, 1);
    for shape in [
        CursorShape::Block,
        CursorShape::Underline,
        CursorShape::Beam,
        CursorShape::HollowBlock,
    ] {
        frame
            .draw_with_cursor(
                &state,
                &before,
                CursorRender {
                    focused: true,
                    shape,
                    ..CursorRender::default()
                },
            )
            .expect("style");
    }
    let after = metrics(13.0, 1.0);
    assert_eq!(before.cell_width, after.cell_width);
    assert_eq!(before.cell_height, after.cell_height);
}

#[test]
fn engine_blink_enablement_does_not_hide_visible_phase() {
    let metrics = metrics(13.0, 1.0);
    let mut state = screen(1, 1);
    state.cursor.focused = true;
    state.cursor.blinking = true;
    let frame = Frame::new(metrics.cell_width as u32, metrics.cell_height as u32).expect("frame");

    frame.draw(&state, &metrics).expect("visible blink phase");
    let first = bright(
        &frame,
        metrics.cell_width as u32,
        metrics.cell_height as u32,
    );
    frame
        .draw(&state, &metrics)
        .expect("same visible blink phase");
    let second = bright(
        &frame,
        metrics.cell_width as u32,
        metrics.cell_height as u32,
    );
    assert!(
        first > 0,
        "enabled blinking cursor disappeared in the visible phase"
    );
    assert_eq!(
        first, second,
        "frame renderer introduced its own blink timing"
    );

    let hidden_phase = Frame::new(metrics.cell_width as u32, metrics.cell_height as u32)
        .expect("hidden phase frame");
    hidden_phase
        .draw_with_cursor(
            &state,
            &metrics,
            CursorRender {
                blink_visible: false,
                ..CursorRender::default()
            },
        )
        .expect("scheduler-owned hidden phase");
    assert_eq!(
        bright(
            &hidden_phase,
            metrics.cell_width as u32,
            metrics.cell_height as u32
        ),
        0
    );
}

#[test]
fn cell_raster_is_stable_when_cursor_phase_changes_outside_the_cell() {
    let metrics = metrics(13.0, 1.0);
    let width = metrics.cell_width as u32 * 4;
    let height = metrics.cell_height as u32 * 2;
    let mut state = screen(4, 2);
    state.lines[0][0].ch = Some("A".to_string());
    state.lines[0][1].ch = Some("한".to_string());
    state.lines[0][1].width = 2;
    state.cursor.row = 1;
    state.cursor.focused = true;
    let frame = Frame::new(width, height).expect("frame");
    frame.draw(&state, &metrics).expect("first raster");
    let first = pixels(&frame, width, metrics.cell_height as u32);
    frame.draw(&state, &metrics).expect("second raster");
    let second = pixels(&frame, width, metrics.cell_height as u32);
    assert_eq!(
        first, second,
        "cell raster changed between identical frames"
    );

    frame
        .draw_with_cursor(
            &state,
            &metrics,
            CursorRender {
                blink_visible: false,
                ..CursorRender::default()
            },
        )
        .expect("scheduler hidden phase");
    let hidden_cursor = pixels(&frame, width, metrics.cell_height as u32);
    assert_eq!(
        first, hidden_cursor,
        "cursor phase changed unrelated cell pixels"
    );
}

#[test]
fn terminal_theme_changes_background_foreground_and_cursor_pixels_without_metrics_change() {
    let initial_metrics = metrics(13.0, 1.0);
    let cursor = CursorRender {
        visible: true,
        focused: true,
        blink_visible: true,
        shape: CursorShape::Block,
    };
    let width = initial_metrics.cell_width as u32;
    let height = initial_metrics.cell_height as u32;
    let mut state = screen(1, 1);
    state.lines[0][0].ch = Some("X".to_string());
    state.cursor.focused = true;
    let frame = Frame::new(width, height).expect("theme frame");

    frame
        .draw_with_theme(&state, &initial_metrics, cursor, &TerminalTheme::dark())
        .expect("dark theme");
    let dark_background = frame.read_pixel(0, 0).expect("dark background");
    let dark_cursor = frame
        .read_pixel(width / 2, height / 2)
        .expect("dark cursor");

    frame
        .draw_with_theme(&state, &initial_metrics, cursor, &TerminalTheme::light())
        .expect("light theme");
    let light_background = frame.read_pixel(0, 0).expect("light background");
    let light_cursor = frame
        .read_pixel(width / 2, height / 2)
        .expect("light cursor");

    assert_ne!(dark_background, light_background);
    assert_ne!(dark_cursor, light_cursor);
    let unchanged = metrics(13.0, 1.0);
    assert_eq!(initial_metrics.cell_width, unchanged.cell_width);
    assert_eq!(initial_metrics.cell_height, unchanged.cell_height);
    assert_eq!(initial_metrics.font_size, unchanged.font_size);
}
