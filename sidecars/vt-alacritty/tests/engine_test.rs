#[path = "../src/engine.rs"]
mod engine;

use engine::AlacrittyEngine;
use soksak_sidecar_vt_core::{
    default_terminal_color, CursorShape, Engine, EngineEvent, DEFAULT_PALETTE,
};

fn text(screen: &soksak_sidecar_vt_core::Screen) -> String {
    screen
        .lines
        .iter()
        .flat_map(|line| line.iter().filter_map(|cell| cell.ch.as_deref()))
        .collect()
}

#[test]
fn vt_events_are_retained_and_exposed_in_order() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]2;title\x07\x07\x1b[6n\x1b[c");

    let events = engine.drain_events();
    assert!(matches!(&events[0], EngineEvent::Title(title) if title == "title"));
    assert!(matches!(&events[1], EngineEvent::Bell));
    let replies: Vec<&[u8]> = events
        .iter()
        .filter_map(|event| {
            if let EngineEvent::PtyWrite(bytes) = event {
                Some(bytes.as_slice())
            } else {
                None
            }
        })
        .collect();
    assert!(replies.contains(&b"\x1b[1;1R".as_slice()));
    assert!(replies.contains(&b"\x1b[?6c".as_slice()));
    assert!(engine.drain_events().is_empty());
}

#[test]
fn osc_default_color_queries_match_renderer_defaults() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    let replies: Vec<Vec<u8>> = engine
        .drain_events()
        .into_iter()
        .filter_map(|event| {
            if let EngineEvent::PtyWrite(bytes) = event {
                Some(bytes)
            } else {
                None
            }
        })
        .collect();
    assert!(replies
        .iter()
        .any(|reply| reply.windows(18).any(|part| part == b"rgb:d0d0/d0d0/d0d0")));
    assert!(replies
        .iter()
        .any(|reply| reply.windows(18).any(|part| part == b"rgb:1e1e/1e1e/1e1e")));
    assert_eq!(replies.len(), 3);
}

#[test]
fn every_default_indexed_color_query_returns_the_default_palette() {
    let mut engine = AlacrittyEngine::new();
    for index in 0..256 {
        engine.feed(format!("\x1b]4;{index};?\x07").as_bytes());
        let events = engine.drain_events();
        let expected = default_terminal_color(index).expect("defined default color slot");
        let expected_reply = format!(
            "rgb:{:02x}{:02x}/{:02x}{:02x}/{:02x}{:02x}",
            expected[0], expected[0], expected[1], expected[1], expected[2], expected[2]
        );
        assert!(events.iter().any(|event| {
            matches!(event, EngineEvent::PtyWrite(bytes)
                if bytes.windows(expected_reply.len()).any(|part| part == expected_reply.as_bytes()))
        }), "missing default response for indexed color {index}");
        assert!(!events
            .iter()
            .any(|event| matches!(event, EngineEvent::Error(_))));
    }

    engine.feed(b"\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    let events = engine.drain_events();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, EngineEvent::PtyWrite(_)))
            .count(),
        3
    );
    assert!(!events
        .iter()
        .any(|event| matches!(event, EngineEvent::Error(_))));
}

#[test]
fn every_named_color_slot_has_a_default_value() {
    for index in 256..269 {
        assert!(
            default_terminal_color(index).is_some(),
            "missing named color {index}"
        );
    }
}

#[test]
fn event_queue_is_available_through_engine_trait() {
    let mut engine: Box<dyn Engine> = Box::new(AlacrittyEngine::new());
    engine.feed(b"\x07");
    assert!(matches!(
        engine.drain_events().as_slice(),
        [EngineEvent::Bell]
    ));
}

#[test]
fn simple_text_is_exported() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"hi");
    let screen = engine.screen();
    assert_eq!(screen.lines.len() as u16, screen.rows);
    assert_eq!(screen.lines[0].len(), 2);
    assert_eq!(screen.lines[0][0].ch.as_deref(), Some("h"));
    assert_eq!(screen.lines[0][1].ch.as_deref(), Some("i"));
}

#[test]
fn korean_text_keeps_wide_cell_width() {
    let mut engine = AlacrittyEngine::new();
    engine.feed("한글".as_bytes());
    let screen = engine.screen();
    assert_eq!(screen.lines.len() as u16, screen.rows);
    assert_eq!(screen.lines[0][0].width, 2);
}

#[test]
fn sgr_color_does_not_drop_the_character() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b[31mA");
    let screen = engine.screen();
    assert_eq!(screen.lines.len() as u16, screen.rows);
    assert_eq!(screen.lines[0][0].ch.as_deref(), Some("A"));
}

#[test]
fn alternate_screen_mode_is_exported() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b[?1049h");
    assert!(engine.modes().alt_screen);
}

#[test]
fn resize_updates_screen_dimensions() {
    let mut engine = AlacrittyEngine::new();
    engine.resize(40, 10);
    let screen = engine.screen();
    assert_eq!(screen.cols, 40);
    assert_eq!(screen.rows, 10);
    assert_eq!(screen.lines.len(), 10);
}

#[test]
fn reset_clears_the_screen() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"hello");
    engine.reset();
    let screen = engine.screen();
    assert_eq!(screen.lines.len() as u16, screen.rows);
    assert!(screen.lines.iter().all(Vec::is_empty));
}

#[test]
fn empty_lines_in_the_middle_are_retained() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"a\r\n\r\nb");
    let screen = engine.screen();
    assert_eq!(screen.lines[0][0].ch.as_deref(), Some("a"));
    assert!(screen.lines[1].is_empty());
    assert_eq!(screen.lines[2][0].ch.as_deref(), Some("b"));
    assert_eq!(screen.cursor.row, 2);
}

#[test]
fn clipboard_query_uses_a_token_and_resolves_to_pty_bytes() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]52;c;?\x07");
    let events = engine.drain_events();
    let request_id = events
        .iter()
        .find_map(|event| {
            if let EngineEvent::ClipboardQuery { request_id, .. } = event {
                Some(*request_id)
            } else {
                None
            }
        })
        .expect("clipboard query must expose a request token");
    engine
        .resolve_clipboard(request_id, "secret")
        .expect("known clipboard token");
    assert!(engine.drain_events().iter().any(|event| {
        matches!(event, EngineEvent::PtyWrite(bytes) if bytes.windows(8).any(|window| window == b"c2VjcmV0"))
    }));
    assert!(engine.resolve_clipboard(request_id, "again").is_err());
}

#[test]
fn text_area_callback_is_not_discarded() {
    let mut engine = AlacrittyEngine::new();
    engine.set_cell_metrics(8, 16).expect("renderer metrics");
    engine.feed(b"\x1b[14t");
    assert!(engine.drain_events().iter().any(|event| {
        matches!(event, EngineEvent::PtyWrite(bytes) if bytes == b"\x1b[4;384;640t")
    }));
}

#[test]
fn text_area_query_without_renderer_metrics_is_explicitly_rejected() {
    let mut engine: Box<dyn Engine> = Box::new(AlacrittyEngine::new());
    engine.feed(b"\x1b[14t");
    assert!(
        matches!(engine.drain_events().as_slice(), [EngineEvent::Error(message)] if message.contains("renderer metrics"))
    );
}

#[test]
fn indexed_colors_and_combining_characters_survive_export() {
    let mut engine = AlacrittyEngine::new();
    engine.feed("\x1b]4;196;rgb:ffff/0000/0000\x07\x1b[38;5;196mX e\u{301}".as_bytes());

    let screen = engine.screen();
    let first = &screen.lines[0];
    let x = first
        .iter()
        .find(|cell| cell.ch.as_deref() == Some("X"))
        .expect("X cell");
    assert_eq!(x.fg.as_deref(), Some("#ff0000"));
    assert!(first
        .iter()
        .any(|cell| cell.ch.as_deref() == Some("e\u{301}")));
}

#[test]
fn dynamic_color_replies_and_screen_colors_use_the_same_palette() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]10;rgb:1122/3344/5566\x07\x1b]11;rgb:7788/99aa/bbcc\x07\x1b[39mA");
    let screen = engine.screen();
    assert_eq!(screen.lines[0][0].fg.as_deref(), Some("#113355"));
    assert_eq!(screen.lines[0][0].bg.as_deref(), Some("#7799bb"));

    engine.feed(b"\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    let replies: Vec<Vec<u8>> = engine
        .drain_events()
        .into_iter()
        .filter_map(|event| {
            if let EngineEvent::PtyWrite(bytes) = event {
                Some(bytes)
            } else {
                None
            }
        })
        .collect();
    assert!(replies
        .iter()
        .any(|reply| reply.windows(18).any(|part| part == b"rgb:1111/3333/5555")));
    assert!(replies
        .iter()
        .any(|reply| reply.windows(18).any(|part| part == b"rgb:7777/9999/bbbb")));
}

#[test]
fn default_palette_styled_cells_use_the_same_rgb_as_queries() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b[38;5;196m\x1b[48;5;21mX");
    let cell = &engine.screen().lines[0][0];
    assert_eq!(cell.fg.as_deref(), Some("#ff0000"));
    let expected_bg = DEFAULT_PALETTE[21];
    let expected_bg_text = format!(
        "#{:02x}{:02x}{:02x}",
        expected_bg[0], expected_bg[1], expected_bg[2]
    );
    assert_eq!(cell.bg.as_deref(), Some(expected_bg_text.as_str()));
}

#[test]
fn display_points_are_used_as_cell_indices() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\r\x1b[3CZ");
    let screen = engine.screen();
    assert_eq!(screen.lines[0][3].ch.as_deref(), Some("Z"));
    assert_eq!(screen.lines[0].len(), 4);
}

#[test]
fn cursor_visibility_and_application_shape_are_exported() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b[?25l");
    assert!(!engine.cursor().visible);
    engine.feed(b"\x1b[?25h\x1b[4 q");
    let cursor = engine.cursor();
    assert!(cursor.visible);
    assert_eq!(cursor.shape, CursorShape::Underline);
    assert!(!cursor.blinking);
    engine.feed(b"\x1b[?12h");
    assert!(engine.cursor().blinking);
    engine.feed(b"\x1b[?12l");
    assert!(engine
        .drain_events()
        .iter()
        .any(|event| matches!(event, EngineEvent::CursorBlinkingChange)));
    assert!(!engine.cursor().blinking);
}

#[test]
fn primary_screen_reflows_without_losing_text_when_width_changes() {
    let mut engine = AlacrittyEngine::new();
    let value = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH";
    engine.resize(20, 10);
    engine.feed(value.as_bytes());
    let narrow = engine.screen();
    assert_eq!(text(&narrow), value);
    assert!(narrow.lines.iter().filter(|line| !line.is_empty()).count() > 1);

    engine.resize(80, 10);
    let wide = engine.screen();
    assert_eq!(text(&wide), value);
    assert_eq!(wide.lines.iter().filter(|line| !line.is_empty()).count(), 1);
}

#[test]
fn csi_scroll_moves_the_visible_grid_and_respects_a_scroll_region() {
    let mut engine = AlacrittyEngine::new();
    engine.resize(10, 4);
    engine.feed(b"A\r\nB\r\nC\r\nD");

    engine.feed(b"\x1b[2S");
    let after_full_scroll = engine.screen();
    assert_eq!(after_full_scroll.lines[0][0].ch.as_deref(), Some("C"));
    assert_eq!(after_full_scroll.lines[1][0].ch.as_deref(), Some("D"));

    engine.reset();
    engine.resize(10, 4);
    engine.feed(b"A\r\nB\r\nC\r\nD");
    engine.feed(b"\x1b[2;3r\x1b[1S");
    let after_region_scroll = engine.screen();
    assert_eq!(after_region_scroll.lines[0][0].ch.as_deref(), Some("A"));
    assert_eq!(after_region_scroll.lines[1][0].ch.as_deref(), Some("C"));
    assert!(after_region_scroll.lines[2].is_empty());
    assert_eq!(after_region_scroll.lines[3][0].ch.as_deref(), Some("D"));
}
