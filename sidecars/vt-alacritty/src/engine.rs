use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, Processor, Rgb};
use soksak_sidecar_vt_core::{
    default_terminal_color, Cell, ClipboardSelection, Cursor, CursorShape as ProtocolCursorShape,
    Engine, EngineEvent, Modes, Screen, TerminalTheme,
};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

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
        if point.column >= self.term.grid().columns() || point.line.0 < 0 || point.line.0 >= self.term.grid().screen_lines() as i32 {
            return Err(format!("selection cell is outside the terminal grid: {col},{row}"));
        }
        self.term.selection = Some(Selection::new(SelectionType::Simple, point, Side::Left));
        Ok(())
    }

    pub fn selection_update(&mut self, col: u16, row: u16) -> Result<(), String> {
        let point = Point::new(Line(i32::from(row)), Column(usize::from(col)));
        if point.column >= self.term.grid().columns() || point.line.0 < 0 || point.line.0 >= self.term.grid().screen_lines() as i32 {
            return Err(format!("selection cell is outside the terminal grid: {col},{row}"));
        }
        let selection = self.term.selection.as_mut().ok_or_else(|| "selection update without selection start".to_string())?;
        selection.update(point, Side::Right);
        Ok(())
    }

    pub fn selection_end(&mut self) -> Result<String, String> {
        self.term.selection_to_string().filter(|text| !text.is_empty()).ok_or_else(|| "selection is empty".to_string())
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
        self.processor.advance(&mut self.term, bytes);
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

    fn modes(&self) -> Modes {
        let mode = self.term.mode();
        Modes {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            app_keypad: mode.contains(TermMode::APP_KEYPAD),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            mouse_report: mode.contains(TermMode::MOUSE_REPORT_CLICK)
                || mode.contains(TermMode::MOUSE_MOTION),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}
