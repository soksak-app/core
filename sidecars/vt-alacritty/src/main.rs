use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use soksak_sidecar_vt_core::{Cell, Cursor, Engine, Modes, Screen, serve, make_default_session_port_factory};
use std::sync::Arc;

/// 간단한 크기 구조체
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

/// 최소 이벤트 리스너 구현. VT 처리로 생성되는 이벤트를 단순 무시한다.
struct MinimalEventListener;

impl EventListener for MinimalEventListener {
    fn send_event(&self, _event: Event) {
        // 이벤트 무시
    }
}

/// Alacritty 엔진 구현
pub struct AlacrittyEngine {
    term: Term<MinimalEventListener>,
    processor: Processor,
}

impl AlacrittyEngine {
    pub fn new() -> Self {
        let config = Config::default();
        let dims = TermSize::new(80, 24);
        let listener = MinimalEventListener;
        let term = Term::new(config, &dims, listener);
        let processor = Processor::new();

        Self { term, processor }
    }
}

impl Engine for AlacrittyEngine {
    fn resize(&mut self, cols: u16, rows: u16) {
        let dims = TermSize::new(cols as usize, rows as usize);
        self.term.resize(dims);
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.processor.advance(&mut self.term, bytes);
    }

    fn screen(&mut self) -> Screen {
        let renderable = self.term.renderable_content();
        let cols = self.term.grid().columns() as u16;
        let rows = self.term.grid().screen_lines() as u16;

        let cursor = Cursor {
            col: renderable.cursor.point.column.0 as u16,
            row: renderable.cursor.point.line.0 as u16,
        };

        // 화면 행 수만큼 줄 배열 미리 생성
        let mut lines: Vec<Vec<Cell>> = vec![Vec::new(); rows as usize];
        let mut current_row_idx = 0;

        for indexed in renderable.display_iter {
            let cell = indexed.cell;
            let point = indexed.point;

            // 줄 번호가 변경되면 현재 줄을 다음 줄로 이동
            let row_idx = point.line.0 as usize;
            if row_idx != current_row_idx && row_idx < rows as usize {
                // 이전 줄의 끝 공백 제거 (줄의 내용은 유지)
                if !lines[current_row_idx].is_empty() {
                    while let Some(c) = lines[current_row_idx].last() {
                        if c.ch.is_some() {
                            break;
                        }
                        lines[current_row_idx].pop();
                    }
                }
                current_row_idx = row_idx;
            }

            if current_row_idx >= rows as usize {
                break;
            }

            let width = if cell.flags.contains(alacritty_terminal::term::cell::Flags::WIDE_CHAR)
            {
                2
            } else if cell
                .flags
                .contains(alacritty_terminal::term::cell::Flags::WIDE_CHAR_SPACER)
            {
                0
            } else {
                1
            };

            let ch = if cell.c != ' ' && cell.c != '\0' {
                Some(cell.c.to_string())
            } else {
                None
            };

            let fg = match cell.fg {
                alacritty_terminal::vte::ansi::Color::Named(named) => {
                    let rgb = renderable.colors[named];
                    rgb.map(|rgb| format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b))
                }
                alacritty_terminal::vte::ansi::Color::Spec(rgb) => {
                    Some(format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b))
                }
                _ => None,
            };

            let bg = match cell.bg {
                alacritty_terminal::vte::ansi::Color::Named(named) => {
                    let rgb = renderable.colors[named];
                    rgb.map(|rgb| format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b))
                }
                alacritty_terminal::vte::ansi::Color::Spec(rgb) => {
                    Some(format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b))
                }
                _ => None,
            };

            let bold = cell.flags.contains(alacritty_terminal::term::cell::Flags::BOLD);
            let italic = cell.flags.contains(alacritty_terminal::term::cell::Flags::ITALIC);
            let underline =
                cell.flags.contains(alacritty_terminal::term::cell::Flags::UNDERLINE);
            let inverse =
                cell.flags.contains(alacritty_terminal::term::cell::Flags::INVERSE);

            lines[current_row_idx].push(Cell {
                ch,
                width,
                fg,
                bg,
                bold,
                italic,
                underline,
                inverse,
            });
        }

        // 마지막 줄의 끝 공백 제거
        if current_row_idx < rows as usize && !lines[current_row_idx].is_empty() {
            while let Some(c) = lines[current_row_idx].last() {
                if c.ch.is_some() {
                    break;
                }
                lines[current_row_idx].pop();
            }
        }

        Screen {
            cols,
            rows,
            cursor,
            lines,
        }
    }

    fn modes(&self) -> Modes {
        let mode = self.term.mode();

        Modes {
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            app_keypad: mode.contains(TermMode::APP_KEYPAD),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            mouse_report: mode
                .contains(TermMode::MOUSE_REPORT_CLICK)
                | mode.contains(TermMode::MOUSE_MOTION),
            alt_screen: mode.contains(TermMode::ALT_SCREEN),
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let engine_factory = Arc::new(|| Box::new(AlacrittyEngine::new()) as Box<dyn Engine>);
    serve(
        engine_factory,
        tokio::io::stdin(),
        tokio::io::stdout(),
        make_default_session_port_factory(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feed_simple_text() {
        let mut engine = AlacrittyEngine::new();
        engine.feed(b"hi");

        let screen = engine.screen();
        // 화면 행 수와 일치해야 함
        assert_eq!(screen.lines.len() as u16, screen.rows);
        // 첫 줄에 h, i
        assert_eq!(screen.lines[0].len(), 2);
        assert_eq!(screen.lines[0][0].ch, Some("h".to_string()));
        assert_eq!(screen.lines[0][1].ch, Some("i".to_string()));
    }

    #[test]
    fn test_feed_korean_text() {
        let mut engine = AlacrittyEngine::new();
        engine.feed("한글".as_bytes());

        let screen = engine.screen();
        assert_eq!(screen.lines.len() as u16, screen.rows);
        // 한글 문자는 width 2로 표현
        if !screen.lines[0].is_empty() {
            assert_eq!(screen.lines[0][0].width, 2);
        }
    }

    #[test]
    fn test_feed_color_sequence() {
        let mut engine = AlacrittyEngine::new();
        engine.feed(b"\x1b[31mA");

        let screen = engine.screen();
        assert_eq!(screen.lines.len() as u16, screen.rows);
        if !screen.lines[0].is_empty() {
            // 문자가 렌더링되는지 확인
            assert_eq!(screen.lines[0][0].ch, Some("A".to_string()));
        }
    }

    #[test]
    fn test_alt_screen_mode() {
        let mut engine = AlacrittyEngine::new();
        engine.feed(b"\x1b[?1049h");

        let modes = engine.modes();
        assert!(modes.alt_screen);
    }

    #[test]
    fn test_resize() {
        let mut engine = AlacrittyEngine::new();
        engine.resize(40, 10);

        let screen = engine.screen();
        assert_eq!(screen.cols, 40);
        assert_eq!(screen.rows, 10);
        // 화면 행 수와 일치
        assert_eq!(screen.lines.len(), 10);
    }

    #[test]
    fn test_reset() {
        let mut engine = AlacrittyEngine::new();
        engine.feed(b"hello");
        engine.reset();

        let screen = engine.screen();
        // reset 후에도 화면 행 수는 유지 (모두 비어있음)
        assert_eq!(screen.lines.len() as u16, screen.rows);
        // 모든 줄이 비어있어야 함
        for line in &screen.lines {
            assert!(line.is_empty());
        }
    }

    #[test]
    fn test_empty_lines_in_middle() {
        let mut engine = AlacrittyEngine::new();
        // 첫 줄: "a", 둘째 줄: 비움, 셋째 줄: "b"
        engine.feed(b"a\r\n\r\nb");

        let screen = engine.screen();
        // 화면 행 수와 일치
        assert_eq!(screen.lines.len() as u16, screen.rows);
        // 첫 줄에 'a'
        assert_eq!(screen.lines[0].len(), 1);
        assert_eq!(screen.lines[0][0].ch, Some("a".to_string()));
        // 둘째 줄은 비어있음
        assert!(screen.lines[1].is_empty());
        // 셋째 줄에 'b'
        assert_eq!(screen.lines[2].len(), 1);
        assert_eq!(screen.lines[2][0].ch, Some("b".to_string()));
        // 커서가 셋째 줄에 있어야 함
        assert_eq!(screen.cursor.row, 2);
    }
}
