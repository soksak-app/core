#[path = "../src/engine.rs"]
mod engine;

use engine::{AlacrittyEngine, CsiOutcome, OscOutcome, CSI_SELECTOR_INVENTORY, OSC_SELECTOR_INVENTORY};
use soksak_sidecar_vt_core::{
    default_terminal_color, inline_image::Dimension, inline_image::InlineImageCommand, CursorShape,
    Engine, EngineEvent, TerminalTheme, DEFAULT_PALETTE,
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
fn osc1337_inline_image_is_typed_and_survives_input_chunk_boundaries() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"before\x1b]1337;File=name=ZmlsZS5wbmc=;size=5;inline=1;width=2px:aGVsbG8=");
    assert!(
        engine.drain_events().is_empty(),
        "incomplete OSC must remain pending"
    );

    engine.feed(b"\x07after");
    let events = engine.drain_events();
    assert!(matches!(
        events.as_slice(),
        [EngineEvent::InlineImage(InlineImageCommand::Display {
            name,
            data,
            width: Dimension::Pixels(2),
            ..
        })] if name == "file.png" && data == b"hello"
    ));
    let screen = engine.screen();
    let text = screen
        .lines
        .iter()
        .flat_map(|line| line.iter().filter_map(|cell| cell.ch.as_deref()))
        .collect::<String>();
    assert!(
        text.contains("before"),
        "text before image was lost: {text:?}"
    );
    assert!(
        text.contains("after"),
        "text after image was lost: {text:?}"
    );
}

#[test]
fn scroll_generation_advances_when_output_scrolls_the_primary_grid() {
    let mut engine = AlacrittyEngine::new();
    engine.resize(8, 2);
    let before = engine.scroll_generation();
    engine.feed(b"one\ntwo\nthree");
    assert!(engine.scroll_generation() > before);
}

#[test]
fn malformed_osc1337_is_an_explicit_engine_error() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]1337;File=inline=1:%%%\x07");
    let events = engine.drain_events();
    assert!(matches!(
        events.as_slice(),
        [EngineEvent::Error(reason)] if reason.contains("invalid base64")
    ));
}

#[test]
fn osc_selector_inventory_records_unsupported_operations() {
    let unsupported: Vec<_> = OSC_SELECTOR_INVENTORY
        .iter()
        .filter(|entry| entry.outcome == OscOutcome::Unsupported)
        .collect();
    assert!(!unsupported.is_empty());
    for entry in unsupported {
        assert!(!entry.selector.is_empty());
        assert_eq!(
            entry.test,
            "osc_selector_inventory_records_unsupported_operations"
        );
    }
}

#[test]
fn unsupported_osc_selector_is_an_explicit_error_after_fragmented_bel() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]6;ignored");
    assert!(engine.drain_events().is_empty());
    engine.feed(b"\x07");
    assert!(matches!(
        engine.drain_events().as_slice(),
        [EngineEvent::Error(reason)] if reason == "unsupported OSC selector 6"
    ));
}

#[test]
fn unsupported_osc_selector_is_an_explicit_error_after_st() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]I;ignored\x1b\\");
    assert!(matches!(
        engine.drain_events().as_slice(),
        [EngineEvent::Error(reason)] if reason == "unsupported OSC selector I"
    ));
}

#[test]
fn every_unsupported_osc_inventory_selector_emits_an_explicit_error() {
    for selector in ["1", "3", "5", "6", "13", "19", "21", "22", "46", "51", "60", "62", "105", "106", "I", "l", "L"] {
        let mut engine = AlacrittyEngine::new();
        engine.feed(format!("\x1b]{selector};ignored\x07").as_bytes());
        assert!(matches!(
            engine.drain_events().as_slice(),
            [EngineEvent::Error(reason)] if reason == &format!("unsupported OSC selector {selector}")
        ), "selector {selector} did not produce an explicit rejection");
    }
}

#[test]
fn implemented_and_vendor_osc_selectors_do_not_emit_unsupported_errors() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]2;title\x07\x1b]7;file:///tmp\x07");
    let events = engine.drain_events();
    assert!(events.iter().any(|event| event == &EngineEvent::Title("title".to_string())));
    assert!(!events.iter().any(|event| matches!(event, EngineEvent::Error(_))));
}

#[test]
fn vendor_osc_contracts_are_separate() {
    let vendor: Vec<_> = OSC_SELECTOR_INVENTORY
        .iter()
        .filter(|entry| entry.outcome == OscOutcome::Vendor)
        .collect();
    assert_eq!(
        vendor
            .iter()
            .map(|entry| entry.selector)
            .collect::<Vec<_>>(),
        ["7,8,9,133", "1337"]
    );
    assert!(vendor.iter().all(|entry| !entry.test.is_empty()));
}

#[test]
fn csi_inventory_links_only_executed_behavior_cases() {
    assert!(!CSI_SELECTOR_INVENTORY.is_empty());
    for entry in CSI_SELECTOR_INVENTORY {
        assert_eq!(entry.outcome, CsiOutcome::Implemented);
        assert!(!entry.selector.is_empty());
        assert!(!entry.test.is_empty());
    }
}

#[test]
fn csi_cursor_movement_and_save_restore_are_observable() {
    let mut engine = AlacrittyEngine::new();
    engine.resize(20, 6);
    engine.feed(b"abc\x1b[s\x1b[2D\x1b[2B\x1b[3C\x1b[u");
    assert_eq!(engine.cursor().col, 3, "CSI s/u must restore the saved column");
    assert_eq!(engine.cursor().row, 0, "CSI s/u must restore the saved row");

    engine.feed(b"\x1b[2;5H\x1b[2A\x1b[3G");
    assert_eq!(engine.cursor().col, 2, "CSI G must select the requested column");
    assert_eq!(engine.cursor().row, 0, "CSI A must move up by the requested count");

    engine.feed(b"\x1b[2B\x1b[2D");
    assert_eq!(engine.cursor().col, 0, "CSI D must move left by the requested count");
    assert_eq!(engine.cursor().row, 2, "CSI B must move down by the requested count");
}

#[test]
fn osc50_cursor_shape_changes_program_cursor() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]50;CursorShape=2\x07");
    assert_eq!(engine.cursor().shape, CursorShape::Underline);
}

#[test]
fn osc104_resets_indexed_colors() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]4;1;rgb:0000/ffff/ffff\x07\x1b[38;5;1mX");
    assert_eq!(engine.screen().lines[0][0].fg.as_deref(), Some("#00ffff"));
    engine.feed(b"\x1b]104;1\x07\x1b[39mY\x1b[38;5;1mZ");
    let expected = default_terminal_color(1).expect("default color 1");
    let expected = format!("#{:02x}{:02x}{:02x}", expected[0], expected[1], expected[2]);
    assert_eq!(
        engine.screen().lines[0][2].fg.as_deref(),
        Some(expected.as_str())
    );
}

#[test]
fn osc_title_supports_bel_st_and_fragmentation() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]2;st");
    assert!(engine.drain_events().is_empty());
    engine.feed(b"\x1b\\\x1b]0;bel\x07");
    assert_eq!(
        engine.drain_events(),
        vec![
            EngineEvent::Title("st".to_string()),
            EngineEvent::Title("bel".to_string()),
        ]
    );
}

#[test]
fn osc104_without_parameters_resets_all_indexed_colors() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]4;1;rgb:0000/ffff/ffff\x07\x1b]4;2;rgb:ffff/0000/ffff\x07\x1b]104\x07\x1b[38;5;1mA\x1b[38;5;2mB");
    let expected_one = default_terminal_color(1).expect("default color 1");
    let expected_two = default_terminal_color(2).expect("default color 2");
    let expected_one = format!(
        "#{:02x}{:02x}{:02x}",
        expected_one[0], expected_one[1], expected_one[2]
    );
    let expected_two = format!(
        "#{:02x}{:02x}{:02x}",
        expected_two[0], expected_two[1], expected_two[2]
    );
    let screen = engine.screen();
    assert_eq!(
        screen.lines[0][0].fg.as_deref(),
        Some(expected_one.as_str())
    );
    assert_eq!(
        screen.lines[0][1].fg.as_deref(),
        Some(expected_two.as_str())
    );
}

#[test]
fn osc_dynamic_color_resets_restore_defaults() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]10;rgb:0000/ffff/ffff\x07\x1b]11;rgb:ffff/0000/ffff\x07\x1b]12;rgb:ffff/ffff/0000\x07");
    engine.drain_events();
    engine.feed(b"\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    let replies = engine
        .drain_events()
        .into_iter()
        .filter_map(|event| match event {
            EngineEvent::PtyWrite(bytes) => Some(bytes),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 3);
    assert!(replies
        .iter()
        .any(|reply| reply.windows(18).any(|part| part == b"rgb:d0d0/d0d0/d0d0")));
    assert!(replies
        .iter()
        .any(|reply| reply.windows(18).any(|part| part == b"rgb:1e1e/1e1e/1e1e")));
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
fn clipboard_rejection_clears_a_pending_query_token() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"\x1b]52;c;?\x07");
    let request_id = engine
        .drain_events()
        .into_iter()
        .find_map(|event| match event {
            EngineEvent::ClipboardQuery { request_id, .. } => Some(request_id),
            _ => None,
        })
        .expect("clipboard query must expose a request token");
    engine
        .reject_clipboard(request_id, "denied")
        .expect("known clipboard token");
    assert!(engine.resolve_clipboard(request_id, "secret").is_err());
    assert!(engine.reject_clipboard(request_id, "again").is_err());
}

#[test]
fn native_selection_updates_raster_cells_and_returns_text_once() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"hello");
    engine.selection_start(0, 0).expect("selection start");
    engine.selection_update(4, 0).expect("selection update");
    let selected = engine.screen();
    assert!(selected.lines[0][2].inverse);
    assert_eq!(engine.selection_end().expect("selection copy"), "hello");
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
fn application_theme_changes_default_and_ansi_raster_colors_without_changing_text() {
    let mut engine = AlacrittyEngine::new();
    engine.feed(b"A\x1b[38;5;1mR");
    let dark = engine.screen();
    let dark_text = text(&dark);
    let dark_default = dark.lines[0][0].fg.clone();
    let dark_ansi = dark.lines[0][1].fg.clone();

    engine.set_theme(TerminalTheme::light());
    let light = engine.screen();
    assert_eq!(text(&light), dark_text);
    assert_ne!(light.lines[0][0].fg, dark_default);
    assert_ne!(light.lines[0][1].fg, dark_ansi);
    assert_eq!(engine.cursor().col, 2);
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
fn soft_wraps_rejoin_but_explicit_newlines_remain_after_resize() {
    let mut engine = AlacrittyEngine::new();
    let first = "AAAA-BBBB-CCCC-DDDD";
    let second = "hard-line";
    engine.resize(6, 8);
    engine.feed(format!("{first}\r\n{second}").as_bytes());
    let narrow = engine.screen();
    assert_eq!(text(&narrow), format!("{first}{second}"));
    assert!(narrow.lines.iter().filter(|line| !line.is_empty()).count() >= 4);

    engine.resize(40, 8);
    let wide = engine.screen();
    assert_eq!(text(&wide), format!("{first}{second}"));
    assert_eq!(
        wide.lines.iter().filter(|line| !line.is_empty()).count(),
        2,
        "the explicit newline must remain after soft wraps rejoin"
    );
}

#[test]
fn wide_cells_keep_their_width_and_text_through_reflow() {
    let mut engine = AlacrittyEngine::new();
    let value = "한글한글-終";
    engine.resize(5, 8);
    engine.feed(value.as_bytes());
    assert_eq!(text(&engine.screen()), value);
    assert!(engine.screen().lines[0].iter().any(|cell| cell.width == 2));

    engine.resize(20, 8);
    let wide = engine.screen();
    assert_eq!(text(&wide), value);
    assert!(wide.lines[0].iter().any(|cell| cell.width == 2));
}

#[test]
fn cell_metrics_are_fixed_renderer_values_across_grid_resize() {
    let mut engine = AlacrittyEngine::new();
    engine
        .set_cell_metrics(9, 17)
        .expect("positive renderer metrics");
    engine.feed(b"\x1b[14t");
    let before = engine.drain_events();
    engine.resize(40, 10);
    engine.feed(b"\x1b[14t");
    let after = engine.drain_events();
    let reply = |events: &[EngineEvent]| {
        events.iter().find_map(|event| match event {
            EngineEvent::PtyWrite(bytes) => Some(bytes.clone()),
            _ => None,
        })
    };
    assert_eq!(
        reply(&before).as_deref(),
        Some(b"\x1b[4;408;720t".as_slice())
    );
    assert_eq!(
        reply(&after).as_deref(),
        Some(b"\x1b[4;170;360t".as_slice())
    );
}

#[test]
fn scrollback_keeps_recent_visible_lines_after_overflow_and_resize() {
    let mut engine = AlacrittyEngine::new();
    engine.resize(20, 4);
    engine.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix");
    let narrow = engine.screen();
    assert!(text(&narrow).contains("six"));
    assert!(!text(&narrow).contains("one"));

    engine.resize(40, 4);
    let wide = engine.screen();
    assert!(text(&wide).contains("six"));
    assert!(!text(&wide).contains("one"));
}

#[test]
fn alternate_screen_is_separate_from_primary_scrollback() {
    let mut engine = AlacrittyEngine::new();
    engine.resize(20, 4);
    engine.feed(b"primary\r\ntext");
    let primary = text(&engine.screen());
    engine.feed(b"\x1b[?1049h");
    engine.feed(b"alternate");
    assert!(engine.modes().alt_screen);
    assert!(text(&engine.screen()).contains("alternate"));
    assert!(!text(&engine.screen()).contains("primary"));
    engine.feed(b"\x1b[?1049l");
    assert!(!engine.modes().alt_screen);
    assert!(text(&engine.screen()).contains(&primary));
    assert!(!text(&engine.screen()).contains("alternate"));
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
