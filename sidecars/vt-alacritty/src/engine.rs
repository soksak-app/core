use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, Processor, Rgb};
use soksak_sidecar_vt_core::{
    default_terminal_color, inline_image::parse as parse_inline_image, Cell, ClipboardSelection,
    Cursor, CursorShape as ProtocolCursorShape, Engine, EngineEvent, Modes, Screen, ShellMarker,
    TerminalTheme,
};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OscOutcome {
    Implemented,
    Unsupported,
    Vendor,
}

fn osc_outcome(selector: &[u8]) -> OscOutcome {
    let Ok(selector) = std::str::from_utf8(selector) else {
        return OscOutcome::Unsupported;
    };
    let Ok(number) = selector.parse::<u16>() else {
        return OscOutcome::Unsupported;
    };
    match number {
        0 | 2 | 4 | 10..=12 | 50 | 52 | 104 | 110..=112 => OscOutcome::Implemented,
        7 | 8 | 9 | 133 | 1337 => OscOutcome::Vendor,
        _ => OscOutcome::Unsupported,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OscSelectorEvidence {
    pub selector: &'static str,
    pub outcome: OscOutcome,
    pub test: &'static str,
}

/// Selector-level scope used by the protocol audit. Parser acceptance is not
/// used to derive this inventory; every row names an observable test or an
/// explicit separate vendor contract.
pub const OSC_SELECTOR_INVENTORY: &[OscSelectorEvidence] = &[
    OscSelectorEvidence {
        selector: "0,2",
        outcome: OscOutcome::Implemented,
        test: "vt_events_are_retained_and_exposed_in_order",
    },
    OscSelectorEvidence {
        selector: "1,3",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "4",
        outcome: OscOutcome::Implemented,
        test: "indexed_colors_and_combining_characters_survive_export",
    },
    OscSelectorEvidence {
        selector: "5,6",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "10-12",
        outcome: OscOutcome::Implemented,
        test: "dynamic_color_replies_and_screen_colors_use_the_same_palette",
    },
    OscSelectorEvidence {
        selector: "13-19,21,22,46",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "50",
        outcome: OscOutcome::Implemented,
        test: "osc50_cursor_shape_changes_program_cursor",
    },
    OscSelectorEvidence {
        selector: "51",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "52",
        outcome: OscOutcome::Implemented,
        test: "clipboard_query_uses_a_token_and_resolves_to_pty_bytes",
    },
    OscSelectorEvidence {
        selector: "60-62",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "104",
        outcome: OscOutcome::Implemented,
        test: "osc104_resets_indexed_colors",
    },
    OscSelectorEvidence {
        selector: "105,106",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "110-112",
        outcome: OscOutcome::Implemented,
        test: "osc_dynamic_color_resets_restore_defaults",
    },
    OscSelectorEvidence {
        selector: "I,l,L",
        outcome: OscOutcome::Unsupported,
        test: "osc_selector_inventory_records_unsupported_operations",
    },
    OscSelectorEvidence {
        selector: "7,8,9,133",
        outcome: OscOutcome::Vendor,
        test: "vendor_osc_contracts_are_separate",
    },
    OscSelectorEvidence {
        selector: "1337",
        outcome: OscOutcome::Vendor,
        test: "osc1337_inline_image_is_typed_and_survives_input_chunk_boundaries",
    },
];

fn parse_vendor_osc(selector: &[u8], payload: &[u8]) -> Result<Option<EngineEvent>, String> {
    let selector = std::str::from_utf8(selector)
        .map_err(|_| "vendor OSC selector is not UTF-8".to_string())?;
    let payload = std::str::from_utf8(payload)
        .map_err(|_| format!("OSC {selector} payload is not UTF-8"))?;
    match selector {
        "7" => {
            if payload.is_empty() {
                return Err("OSC 7 directory URI is empty".to_string());
            }
            Ok(Some(EngineEvent::Directory {
                uri: payload.to_string(),
            }))
        }
        "8" => {
            let Some((params, uri)) = payload.split_once(';') else {
                return Err("OSC 8 hyperlink payload must contain params and URI".to_string());
            };
            let id = if params.is_empty() {
                String::new()
            } else {
                let mut id = None;
                for parameter in params.split(':') {
                    let Some(value) = parameter.strip_prefix("id=") else {
                        return Err(format!("OSC 8 hyperlink parameter is unsupported: {parameter}"));
                    };
                    if id.replace(value).is_some() {
                        return Err("OSC 8 hyperlink id is duplicated".to_string());
                    }
                }
                id.unwrap_or_default().to_string()
            };
            Ok(Some(EngineEvent::Hyperlink {
                id,
                uri: (!uri.is_empty()).then_some(uri.to_string()),
            }))
        }
        "9" => {
            if payload.is_empty() {
                return Err("OSC 9 notification is empty".to_string());
            }
            Ok(Some(EngineEvent::Notification {
                message: payload.to_string(),
            }))
        }
        "133" => {
            let (marker, params) = payload.split_once(';').unwrap_or((payload, ""));
            let marker = match marker {
                "A" => ShellMarker::PromptStart,
                "B" => ShellMarker::PromptEnd,
                "C" => ShellMarker::CommandStart,
                "D" => ShellMarker::CommandFinished,
                value => return Err(format!("OSC 133 shell marker is unsupported: {value}")),
            };
            Ok(Some(EngineEvent::ShellState {
                marker,
                params: if params.is_empty() {
                    Vec::new()
                } else {
                    params.split(';').map(str::to_string).collect()
                },
            }))
        }
        "1337" => Ok(None),
        _ => Err(format!("unsupported vendor OSC selector {selector}")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CsiOutcome {
    Implemented,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CsiSelectorEvidence {
    pub selector: &'static str,
    pub outcome: CsiOutcome,
    pub test: &'static str,
}

/// Selector-level evidence for CSI behavior that this sidecar currently exposes.
/// This is deliberately a partial inventory until the remaining XTerm categories
/// have executable behavior and rejection contracts.
pub const CSI_SELECTOR_INVENTORY: &[CsiSelectorEvidence] = &[
    CsiSelectorEvidence { selector: "A/B/C/D/G/H/f/s/u", outcome: CsiOutcome::Implemented, test: "csi_cursor_movement_and_save_restore_are_observable" },
    CsiSelectorEvidence { selector: "E/F", outcome: CsiOutcome::Implemented, test: "csi_cursor_next_and_previous_line_are_observable" },
    CsiSelectorEvidence { selector: "3C", outcome: CsiOutcome::Implemented, test: "display_points_are_used_as_cell_indices" },
    CsiSelectorEvidence { selector: "?12h/l", outcome: CsiOutcome::Implemented, test: "cursor_visibility_and_application_shape_are_exported" },
    CsiSelectorEvidence { selector: "?25h/l", outcome: CsiOutcome::Implemented, test: "cursor_visibility_and_application_shape_are_exported" },
    CsiSelectorEvidence { selector: "0,7 SP q", outcome: CsiOutcome::Implemented, test: "decscusr_initial_cursor_resources_are_observable" },
    CsiSelectorEvidence { selector: "1-6 SP q", outcome: CsiOutcome::Implemented, test: "decscusr_cursor_style_ids_are_observable" },
    CsiSelectorEvidence { selector: "CSI framing", outcome: CsiOutcome::Implemented, test: "csi_fragmentation_and_malformed_input_preserve_engine_state" },
    CsiSelectorEvidence { selector: "m", outcome: CsiOutcome::Implemented, test: "sgr_color_does_not_drop_the_character" },
    CsiSelectorEvidence { selector: "?1049h/l", outcome: CsiOutcome::Implemented, test: "alternate_screen_is_separate_from_primary_scrollback" },
    CsiSelectorEvidence { selector: "?47/?1047/?1048h/l", outcome: CsiOutcome::Unsupported, test: "unsupported_csi_alternate_modes_are_explicit_errors" },
    CsiSelectorEvidence { selector: "S/T;r", outcome: CsiOutcome::Implemented, test: "csi_scroll_moves_the_visible_grid_and_respects_a_scroll_region" },
    CsiSelectorEvidence { selector: "J/K", outcome: CsiOutcome::Implemented, test: "csi_erase_display_and_line_change_only_the_requested_cells" },
    CsiSelectorEvidence { selector: "@/P", outcome: CsiOutcome::Implemented, test: "csi_insert_delete_characters_and_lines_preserve_requested_cells" },
    CsiSelectorEvidence { selector: "L/M", outcome: CsiOutcome::Implemented, test: "csi_insert_delete_characters_and_lines_preserve_requested_cells" },
    CsiSelectorEvidence { selector: "I/Z", outcome: CsiOutcome::Implemented, test: "csi_tabulation_forward_and_backward_use_tab_stops" },
    CsiSelectorEvidence { selector: "6n/c", outcome: CsiOutcome::Implemented, test: "bel_and_st_terminated_effects_and_queries_preserve_response_order" },
    CsiSelectorEvidence { selector: "5n/6n", outcome: CsiOutcome::Implemented, test: "csi_device_status_reports_are_observable" },
    CsiSelectorEvidence { selector: "c/>c", outcome: CsiOutcome::Implemented, test: "csi_device_status_reports_are_observable" },
    CsiSelectorEvidence { selector: "b", outcome: CsiOutcome::Implemented, test: "csi_repeat_repeats_the_last_printed_character" },
    CsiSelectorEvidence { selector: "?1,?1000,?1002,?1003,?1004,?1005,?1006,?1007,?2004 h/l", outcome: CsiOutcome::Implemented, test: "csi_private_modes_export_keyboard_paste_and_mouse_state" },
    CsiSelectorEvidence { selector: "ESC =/>", outcome: CsiOutcome::Implemented, test: "csi_application_keypad_mode_uses_the_private_equals_prefix" },
    CsiSelectorEvidence { selector: "14t", outcome: CsiOutcome::Implemented, test: "text_area_callback_is_not_discarded" },
    CsiSelectorEvidence { selector: "other t", outcome: CsiOutcome::Unsupported, test: "unsupported_csi_window_report_is_an_explicit_error" },
    CsiSelectorEvidence { selector: "rectangle/protected/palette", outcome: CsiOutcome::Unsupported, test: "unsupported_csi_rectangle_protected_and_palette_reports_are_explicit_errors" },
];

#[derive(Clone, Copy)]
struct TermSize {
    columns: usize,
    lines: usize,
}

impl TermSize {
    fn new(columns: usize, lines: usize) -> Self {
        Self { columns, lines }
    }
}

impl Dimensions for TermSize {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

/// VT 엔진이 발생한 이벤트를 소유자가 회수할 때까지 발생 순서대로 보존한다.
/// 콜백 이벤트는 엔진 경계에서 필요한 값으로 변환한 뒤 중립 이벤트로 전달한다.
struct EventQueue {
    events: Mutex<VecDeque<QueuedEvent>>,
}

enum QueuedEvent {
    Alacritty(Event),
    Neutral(EngineEvent),
}

impl EventQueue {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(VecDeque::new()),
        })
    }

    fn drain(&self) -> Vec<QueuedEvent> {
        let mut events = self.events.lock().expect("engine event queue poisoned");
        events.drain(..).collect()
    }
}

#[derive(Clone)]
struct EventSink(Arc<EventQueue>);

impl EventListener for EventSink {
    fn send_event(&self, event: Event) {
        self.0
            .events
            .lock()
            .expect("engine event queue poisoned")
            .push_back(QueuedEvent::Alacritty(event));
    }
}

pub struct AlacrittyEngine {
    term: Term<EventSink>,
    processor: Processor,
    events: Arc<EventQueue>,
    pending_clipboard: HashMap<u64, Arc<dyn Fn(&str) -> String + Sync + Send + 'static>>,
    next_clipboard_request: u64,
    cell_metrics: Option<(u16, u16)>,
    theme: TerminalTheme,
    pending_input: Vec<u8>,
    pending_osc: Vec<u8>,
    pending_csi: Vec<u8>,
    pending_cursor_reset: Vec<u8>,
}

impl AlacrittyEngine {
    pub fn new() -> Self {
        let events = EventQueue::new();
        let mut config = Config::default();
        config.osc52 = Osc52::CopyPaste;
        let term = Term::new(config, &TermSize::new(80, 24), EventSink(events.clone()));
        Self {
            term,
            processor: Processor::new(),
            events,
            pending_clipboard: HashMap::new(),
            next_clipboard_request: 1,
            cell_metrics: None,
            theme: TerminalTheme::dark(),
            pending_input: Vec::new(),
            pending_osc: Vec::new(),
            pending_csi: Vec::new(),
            pending_cursor_reset: Vec::new(),
        }
    }

    fn normalize_initial_cursor_resource(&mut self, bytes: &[u8]) -> Vec<u8> {
        const DECSCUSR_INITIAL: &[u8] = b"\x1b[7 q";
        let mut input = std::mem::take(&mut self.pending_cursor_reset);
        input.extend_from_slice(bytes);
        let mut normalized = Vec::with_capacity(input.len());
        let mut index = 0;
        while index < input.len() {
            let remaining = &input[index..];
            if remaining[0] == 0x1b {
                let prefix_len = remaining.len().min(DECSCUSR_INITIAL.len());
                if remaining[..prefix_len] == DECSCUSR_INITIAL[..prefix_len]
                    && remaining.len() < DECSCUSR_INITIAL.len()
                {
                    self.pending_cursor_reset.extend_from_slice(remaining);
                    break;
                }
                if remaining.starts_with(DECSCUSR_INITIAL) {
                    normalized.extend_from_slice(b"\x1b[0 q");
                    index += DECSCUSR_INITIAL.len();
                    continue;
                }
            }
            normalized.push(input[index]);
            index += 1;
        }
        normalized
    }

    fn audit_osc(&mut self, bytes: &[u8]) {
        let mut index = 0;
        while index < bytes.len() {
            if self.pending_osc.is_empty() {
                if bytes[index..].starts_with(b"\x1b]") {
                    self.pending_osc.extend_from_slice(b"\x1b]");
                    index += 2;
                } else {
                    index += 1;
                }
                continue;
            }

            self.pending_osc.push(bytes[index]);
            let terminated = bytes[index] == b'\x07'
                || (self.pending_osc.len() >= 2
                    && self.pending_osc[self.pending_osc.len() - 2..] == *b"\x1b\\");
            index += 1;
            if !terminated {
                continue;
            }

            let terminator = if self.pending_osc.last() == Some(&b'\x07') {
                self.pending_osc.len() - 1
            } else {
                self.pending_osc.len() - 2
            };
            let body = &self.pending_osc[2..terminator];
            let (selector, payload) = body
                .iter()
                .position(|byte| *byte == b';')
                .map(|position| (&body[..position], &body[position + 1..]))
                .unwrap_or((body, &[]));
            let outcome = osc_outcome(selector);
            let event = if outcome == OscOutcome::Vendor {
                match parse_vendor_osc(selector, payload) {
                    Ok(Some(event)) => Some(event),
                    Ok(None) => None,
                    Err(error) => Some(EngineEvent::Error(error)),
                }
            } else if outcome == OscOutcome::Unsupported {
                let selector = String::from_utf8_lossy(selector);
                Some(EngineEvent::Error(format!("unsupported OSC selector {selector}")))
            } else {
                None
            };
            if let Some(event) = event {
                self.events
                    .events
                    .lock()
                    .expect("engine event queue poisoned")
                    .push_back(QueuedEvent::Neutral(event));
            }
            self.pending_osc.clear();
        }
    }

    fn audit_csi(&mut self, bytes: &[u8]) {
        let mut input = std::mem::take(&mut self.pending_csi);
        input.extend_from_slice(bytes);
        let mut index = 0;
        while index < input.len() {
            let Some(relative) = input[index..]
                .windows(2)
                .position(|pair| pair == b"\x1b[")
            else {
                if input.last() == Some(&0x1b) {
                    self.pending_csi.push(0x1b);
                }
                return;
            };
            let start = index + relative;
            let Some(final_offset) = input[start + 2..]
                .iter()
                .position(|byte| (0x40..=0x7e).contains(byte))
            else {
                self.pending_csi.extend_from_slice(&input[start..]);
                return;
            };
            let final_index = start + 2 + final_offset;
            let body = &input[start + 2..final_index];
            let unsupported = if input[final_index] == b't' && body != b"14" {
                Some(format!("window report {}t", String::from_utf8_lossy(body)))
            } else if (input[final_index] == b'h' || input[final_index] == b'l')
                && matches!(body, b"?47" | b"?1047" | b"?1048")
            {
                Some(format!("alternate screen mode {}{}", String::from_utf8_lossy(body), input[final_index] as char))
            } else if input[final_index] == b'x' && body.contains(&b'$') {
                Some(format!("rectangle report {}x", String::from_utf8_lossy(body)))
            } else if input[final_index] == b'q' && body.contains(&b'"') {
                Some(format!("protected-cell report {}q", String::from_utf8_lossy(body)))
            } else if input[final_index] == b'p' && body.starts_with(b"#") {
                Some(format!("palette report {}p", String::from_utf8_lossy(body)))
            } else {
                None
            };
            if let Some(selector) = unsupported {
                    self.events
                        .events
                        .lock()
                        .expect("engine event queue poisoned")
                        .push_back(QueuedEvent::Neutral(EngineEvent::Error(format!(
                            "unsupported CSI {selector}"
                        ))));
            }
            index = final_index + 1;
        }
    }

    fn feed_plain(&mut self, bytes: &[u8]) {
        let bytes = self.normalize_initial_cursor_resource(bytes);
        if !bytes.is_empty() {
            self.audit_osc(&bytes);
            self.audit_csi(&bytes);
            self.processor.advance(&mut self.term, &bytes);
        }
    }

    fn feed_with_inline_images(&mut self, bytes: &[u8]) {
        const PREFIX: &[u8] = b"\x1b]1337;";
        self.pending_input.extend_from_slice(bytes);
        loop {
            let Some(start) = self
                .pending_input
                .windows(PREFIX.len())
                .position(|candidate| candidate == PREFIX)
            else {
                let keep = (1..PREFIX.len())
                    .rev()
                    .find(|length| self.pending_input.ends_with(&PREFIX[..*length]))
                    .unwrap_or(0);
                let split = self.pending_input.len().saturating_sub(keep);
                let plain = self.pending_input[..split].to_vec();
                self.pending_input.drain(..split);
                self.feed_plain(&plain);
                return;
            };

            let before = self.pending_input[..start].to_vec();
            self.pending_input.drain(..start);
            self.feed_plain(&before);

            let body_start = PREFIX.len();
            let terminator = self.pending_input[body_start..]
                .iter()
                .enumerate()
                .find_map(|(offset, byte)| (*byte == b'\x07').then_some((body_start + offset, 1)))
                .or_else(|| {
                    self.pending_input[body_start..]
                        .windows(2)
                        .position(|pair| pair == b"\x1b\\")
                        .map(|offset| (body_start + offset, 2))
                });
            let Some((end, terminator_len)) = terminator else {
                return;
            };
            let payload = self.pending_input[body_start..end].to_vec();
            self.pending_input.drain(..end + terminator_len);
            match parse_inline_image(&payload) {
                Ok(command) => self
                    .events
                    .events
                    .lock()
                    .expect("engine event queue poisoned")
                    .push_back(QueuedEvent::Neutral(EngineEvent::InlineImage(command))),
                Err(error) => self
                    .events
                    .events
                    .lock()
                    .expect("engine event queue poisoned")
                    .push_back(QueuedEvent::Neutral(EngineEvent::Error(error))),
            }
        }
    }

    fn clipboard_selection(
        selection: alacritty_terminal::term::ClipboardType,
    ) -> ClipboardSelection {
        match selection {
            alacritty_terminal::term::ClipboardType::Clipboard => ClipboardSelection::Clipboard,
            alacritty_terminal::term::ClipboardType::Selection => ClipboardSelection::Selection,
        }
    }

    fn event(&self, event: Event) -> Option<EngineEvent> {
        match event {
            Event::Title(value) => Some(EngineEvent::Title(value)),
            Event::ResetTitle => Some(EngineEvent::ResetTitle),
            Event::ClipboardStore(selection, text) => Some(EngineEvent::ClipboardStore {
                selection: Self::clipboard_selection(selection),
                text,
            }),
            Event::ClipboardLoad(_, _) => None,
            Event::ColorRequest(_, _) | Event::TextAreaSizeRequest(_) => None,
            Event::PtyWrite(value) => Some(EngineEvent::PtyWrite(value.into_bytes())),
            Event::CursorBlinkingChange => Some(EngineEvent::CursorBlinkingChange),
            Event::Wakeup => Some(EngineEvent::Wakeup),
            Event::Bell => Some(EngineEvent::Bell),
            Event::Exit => Some(EngineEvent::Exit),
            Event::ChildExit(status) => Some(EngineEvent::ChildExit {
                success: status.success(),
                code: status.code(),
            }),
            Event::MouseCursorDirty => Some(EngineEvent::MouseCursorDirty),
        }
    }

    pub fn drain_events(&mut self) -> Vec<EngineEvent> {
        let raw_events = self.events.drain();
        let mut result = Vec::new();
        for queued in raw_events {
            let event = match queued {
                QueuedEvent::Neutral(event) => {
                    result.push(event);
                    continue;
                }
                QueuedEvent::Alacritty(event) => event,
            };
            match event {
                Event::ClipboardLoad(selection, callback) => {
                    let request_id = self.next_clipboard_request;
                    self.next_clipboard_request = self
                        .next_clipboard_request
                        .checked_add(1)
                        .expect("clipboard request id exhausted");
                    self.pending_clipboard.insert(request_id, callback);
                    result.push(EngineEvent::ClipboardQuery {
                        request_id,
                        selection: Self::clipboard_selection(selection),
                    });
                }
                Event::ColorRequest(index, callback) => {
                    let color = match self.color_request(index) {
                        Ok(color) => color,
                        Err(error) => {
                            result.push(EngineEvent::Error(error));
                            continue;
                        }
                    };
                    result.push(EngineEvent::PtyWrite(callback(color).into_bytes()));
                }
                Event::TextAreaSizeRequest(callback) => {
                    let Some((cell_width, cell_height)) = self.cell_metrics else {
                        result.push(EngineEvent::Error(
                            "text area size requested before renderer metrics were configured"
                                .to_string(),
                        ));
                        continue;
                    };
                    let reply = callback(WindowSize {
                        num_lines: self.term.grid().screen_lines() as u16,
                        num_cols: self.term.grid().columns() as u16,
                        cell_width,
                        cell_height,
                    });
                    result.push(EngineEvent::PtyWrite(reply.into_bytes()));
                }
                event => {
                    if let Some(event) = self.event(event) {
                        result.push(event);
                    }
                }
            }
        }
        result
    }

    pub fn resolve_clipboard(&mut self, request_id: u64, text: &str) -> Result<(), String> {
        let callback = self
            .pending_clipboard
            .remove(&request_id)
            .ok_or_else(|| format!("unknown clipboard request {request_id}"))?;
        self.events
            .events
            .lock()
            .expect("engine event queue poisoned")
            .push_back(QueuedEvent::Neutral(EngineEvent::PtyWrite(
                callback(text).into_bytes(),
            )));
        Ok(())
    }

    pub fn reject_clipboard(&mut self, request_id: u64, reason: &str) -> Result<(), String> {
        self.pending_clipboard
            .remove(&request_id)
            .ok_or_else(|| format!("unknown clipboard request {request_id}"))?;
        if reason.is_empty() {
            return Err("clipboard rejection reason is empty".to_string());
        }
        Ok(())
    }

    pub fn selection_start(&mut self, col: u16, row: u16) -> Result<(), String> {
        let point = Point::new(Line(i32::from(row)), Column(usize::from(col)));
        if point.column >= self.term.grid().columns()
            || point.line.0 < 0
            || point.line.0 >= self.term.grid().screen_lines() as i32
        {
            return Err(format!(
                "selection cell is outside the terminal grid: {col},{row}"
            ));
        }
        self.term.selection = Some(Selection::new(SelectionType::Simple, point, Side::Left));
        Ok(())
    }

    pub fn selection_update(&mut self, col: u16, row: u16) -> Result<(), String> {
        let point = Point::new(Line(i32::from(row)), Column(usize::from(col)));
        if point.column >= self.term.grid().columns()
            || point.line.0 < 0
            || point.line.0 >= self.term.grid().screen_lines() as i32
        {
            return Err(format!(
                "selection cell is outside the terminal grid: {col},{row}"
            ));
        }
        let selection = self
            .term
            .selection
            .as_mut()
            .ok_or_else(|| "selection update without selection start".to_string())?;
        selection.update(point, Side::Right);
        Ok(())
    }

    pub fn selection_end(&mut self) -> Result<String, String> {
        self.term
            .selection_to_string()
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "selection is empty".to_string())
    }

    fn color_request(&self, index: usize) -> Result<Rgb, String> {
        if index >= 269 {
            return Err(format!("unsupported terminal color index {index}"));
        }
        self.term.colors()[index]
            .or_else(|| {
                self.theme
                    .color(index)
                    .or_else(|| default_terminal_color(index))
                    .map(|rgb| Rgb {
                        r: rgb[0],
                        g: rgb[1],
                        b: rgb[2],
                    })
            })
            .ok_or_else(|| format!("unsupported terminal color index {index}"))
    }

    pub fn cursor(&self) -> Cursor {
        let renderable = self.term.renderable_content();
        Cursor {
            col: renderable.cursor.point.column.0 as u16,
            row: renderable.cursor.point.line.0 as u16,
            shape: match renderable.cursor.shape {
                CursorShape::Block => ProtocolCursorShape::Block,
                CursorShape::Underline => ProtocolCursorShape::Underline,
                CursorShape::Beam => ProtocolCursorShape::Beam,
                CursorShape::HollowBlock => ProtocolCursorShape::HollowBlock,
                CursorShape::Hidden => ProtocolCursorShape::Hidden,
            },
            visible: renderable.cursor.shape != CursorShape::Hidden,
            blinking: self.term.cursor_style().blinking,
            blink_visible: true,
            focused: false,
            preedit: None,
        }
    }

    fn color(
        &self,
        color: Color,
        colors: &alacritty_terminal::term::color::Colors,
    ) -> Option<String> {
        let rgb = match color {
            Color::Named(name) => colors[name].or_else(|| {
                self.theme
                    .color(name as usize)
                    .or_else(|| default_terminal_color(name as usize))
                    .map(|rgb| Rgb {
                        r: rgb[0],
                        g: rgb[1],
                        b: rgb[2],
                    })
            }),
            Color::Spec(rgb) => Some(rgb),
            Color::Indexed(index) => colors[index as usize].or_else(|| {
                self.theme
                    .color(index as usize)
                    .or_else(|| default_terminal_color(index as usize))
                    .map(|rgb| Rgb {
                        r: rgb[0],
                        g: rgb[1],
                        b: rgb[2],
                    })
            }),
        }?;
        Some(format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b))
    }

    fn cell(
        &self,
        cell: &alacritty_terminal::term::cell::Cell,
        colors: &alacritty_terminal::term::color::Colors,
    ) -> Cell {
        let mut text = String::new();
        if cell.c != '\0' && (cell.c != ' ' || cell.zerowidth().is_some()) {
            text.push(cell.c);
        }
        if let Some(combining) = cell.zerowidth() {
            text.extend(combining.iter().copied());
        }
        Cell {
            ch: (!text.is_empty()).then_some(text),
            width: if cell.flags.contains(Flags::WIDE_CHAR) {
                2
            } else if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                0
            } else {
                1
            },
            fg: self.color(cell.fg, colors),
            bg: self.color(cell.bg, colors),
            bold: cell.flags.contains(Flags::BOLD),
            italic: cell.flags.contains(Flags::ITALIC),
            underline: cell.flags.contains(Flags::UNDERLINE),
            inverse: cell.flags.contains(Flags::INVERSE),
        }
    }

    fn is_trimmable_default_cell(&self, cell: &Cell) -> bool {
        cell.ch.is_none()
            && cell.width == 1
            && !cell.bold
            && !cell.italic
            && !cell.underline
            && !cell.inverse
            && cell
                .fg
                .as_deref()
                .is_none_or(|color| color == self.theme_hex(self.theme.foreground).as_str())
            && cell
                .bg
                .as_deref()
                .is_none_or(|color| color == self.theme_hex(self.theme.background).as_str())
    }

    fn theme_hex(&self, rgb: [u8; 3]) -> String {
        format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
    }
}

impl Engine for AlacrittyEngine {
    fn set_theme(&mut self, theme: TerminalTheme) {
        self.theme = theme;
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.term
            .resize(TermSize::new(cols as usize, rows as usize));
    }

    fn set_cell_metrics(&mut self, width: u16, height: u16) -> Result<(), String> {
        if width == 0 || height == 0 {
            return Err("terminal cell metrics must be positive".to_string());
        }
        self.cell_metrics = Some((width, height));
        Ok(())
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.feed_with_inline_images(bytes);
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        AlacrittyEngine::drain_events(self)
    }

    fn resolve_clipboard(&mut self, request_id: u64, text: &str) -> Result<(), String> {
        AlacrittyEngine::resolve_clipboard(self, request_id, text)
    }

    fn reject_clipboard(&mut self, request_id: u64, reason: &str) -> Result<(), String> {
        AlacrittyEngine::reject_clipboard(self, request_id, reason)
    }

    fn selection_start(&mut self, col: u16, row: u16) -> Result<(), String> {
        AlacrittyEngine::selection_start(self, col, row)
    }

    fn selection_update(&mut self, col: u16, row: u16) -> Result<(), String> {
        AlacrittyEngine::selection_update(self, col, row)
    }

    fn selection_end(&mut self) -> Result<String, String> {
        AlacrittyEngine::selection_end(self)
    }

    fn cursor(&self) -> Cursor {
        AlacrittyEngine::cursor(self)
    }

    fn screen(&mut self) -> Screen {
        let renderable = self.term.renderable_content();
        let cols = self.term.grid().columns() as u16;
        let rows = self.term.grid().screen_lines() as u16;
        let mut lines = vec![Vec::<Cell>::new(); rows as usize];

        for indexed in renderable.display_iter {
            let row =
                usize::try_from(indexed.point.line.0).expect("display row must be non-negative");
            let col = usize::from(indexed.point.column.0);
            if row >= lines.len() || col >= usize::from(cols) {
                panic!("display point outside terminal dimensions");
            }
            lines[row].resize_with(col + 1, Cell::default);
            let mut cell = self.cell(indexed.cell, renderable.colors);
            if renderable.selection.as_ref().is_some_and(|selection| {
                selection.contains_cell(&indexed, indexed.point, renderable.cursor.shape)
            }) {
                cell.inverse = !cell.inverse;
            }
            lines[row][col] = cell;
        }

        for line in &mut lines {
            while line
                .last()
                .is_some_and(|cell| self.is_trimmable_default_cell(cell))
            {
                line.pop();
            }
        }

        Screen {
            cols,
            rows,
            cursor: Cursor {
                col: renderable.cursor.point.column.0 as u16,
                row: renderable.cursor.point.line.0 as u16,
                shape: self.cursor().shape,
                visible: self.cursor().visible,
                blinking: self.cursor().blinking,
                blink_visible: true,
                focused: false,
                preedit: None,
            },
            lines,
        }
    }

    fn scroll_generation(&self) -> i64 {
        self.term.grid().history_size() as i64
    }

    fn modes(&self) -> Modes {
        let mode = self.term.mode();
        Modes {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            app_keypad: mode.contains(TermMode::APP_KEYPAD),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            mouse_report: mode.contains(TermMode::MOUSE_REPORT_CLICK)
                || mode.contains(TermMode::MOUSE_MOTION),
            focus_in_out: mode.contains(TermMode::FOCUS_IN_OUT),
            utf8_mouse: mode.contains(TermMode::UTF8_MOUSE),
            sgr_mouse: mode.contains(TermMode::SGR_MOUSE),
            alternate_scroll: mode.contains(TermMode::ALTERNATE_SCROLL),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}
