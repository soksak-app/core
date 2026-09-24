use async_trait::async_trait;
/// Integration tests for serve contract with fake daemon
use soksak_sidecar_vt_core::protocol::{
    serve, Cell, Cursor, CursorShape, DaemonEvent, Engine, EngineEvent, Modes, Screen, SessionPort,
};
use soksak_sidecar_vt_core::{
    inline_image::{Dimension, InlineImageCommand},
    TerminalTheme,
};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

struct MockEngine {
    cols: u16,
    rows: u16,
    feed_history: Vec<Vec<u8>>,
    custom_modes: Option<Modes>,
    themes: Vec<TerminalTheme>,
    pending_events: Vec<EngineEvent>,
    selection: Option<String>,
    selected_cells: Arc<Mutex<Vec<(u16, u16)>>>,
    viewport: Arc<Mutex<Vec<String>>>,
}

impl MockEngine {
    fn new() -> Self {
        Self {
            cols: 80,
            rows: 24,
            feed_history: Vec::new(),
            custom_modes: None,
            themes: Vec::new(),
            pending_events: Vec::new(),
            selection: Some("selected".to_string()),
            selected_cells: Arc::new(Mutex::new(Vec::new())),
            viewport: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn with_modes(modes: Modes) -> Self {
        Self {
            cols: 80,
            rows: 24,
            feed_history: Vec::new(),
            custom_modes: Some(modes),
            themes: Vec::new(),
            pending_events: Vec::new(),
            selection: Some("selected".to_string()),
            selected_cells: Arc::new(Mutex::new(Vec::new())),
            viewport: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl Engine for MockEngine {
    fn set_theme(&mut self, theme: TerminalTheme) {
        self.themes.push(theme);
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
    }

    fn set_cell_metrics(&mut self, width: u16, height: u16) -> Result<(), String> {
        if width == 0 || height == 0 {
            return Err("terminal cell metrics must be positive".to_string());
        }
        Ok(())
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.feed_history.push(bytes.to_vec());
        if bytes == b"\x1b]1337;File=name=ZmlsZS5wbmc=;size=5;inline=1;width=2px:aGVsbG8=\x07" {
            self.pending_events
                .push(EngineEvent::InlineImage(InlineImageCommand::Display {
                    name: "file.png".to_string(),
                    data: b"hello".to_vec(),
                    width: Dimension::Pixels(2),
                    height: Dimension::Auto,
                    preserve_aspect_ratio: true,
                }));
        }
        if bytes == b"\x1b]7;file:///tmp/project\x07" {
            self.pending_events.push(EngineEvent::Directory {
                uri: "file:///tmp/project".to_string(),
            });
        }
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        std::mem::take(&mut self.pending_events)
    }

    fn resolve_clipboard(&mut self, request_id: u64, _text: &str) -> Result<(), String> {
        Err(format!("unknown clipboard request {request_id}"))
    }

    fn reject_clipboard(&mut self, request_id: u64, _reason: &str) -> Result<(), String> {
        let _ = request_id;
        Ok(())
    }

    fn selection_start(&mut self, col: u16, row: u16) -> Result<(), String> {
        self.selected_cells.lock().unwrap().push((col, row));
        Ok(())
    }
    fn selection_update(&mut self, col: u16, row: u16) -> Result<(), String> {
        self.selected_cells.lock().unwrap().push((col, row));
        Ok(())
    }
    fn selection_end(&mut self) -> Result<Option<String>, String> {
        Ok(self.selection.clone())
    }
    fn selection_text(&self) -> Option<String> {
        self.selection.clone()
    }
    fn scroll_viewport(&mut self, lines: i32) {
        self.viewport
            .lock()
            .unwrap()
            .push(format!("viewport {lines}"));
    }
    fn scroll_to_newest(&mut self) -> bool {
        self.viewport.lock().unwrap().push("newest".to_string());
        false
    }

    fn cursor(&self) -> Cursor {
        Cursor {
            col: 0,
            row: 0,
            shape: CursorShape::Block,
            visible: true,
            blinking: false,
            blink_visible: true,
            focused: false,
            preedit: None,
        }
    }

    fn screen(&mut self) -> Screen {
        let mut lines = Vec::new();
        for history_bytes in &self.feed_history {
            if let Ok(s) = std::str::from_utf8(history_bytes) {
                let mut row = Vec::new();
                for ch in s.chars() {
                    let width = if (ch as u32) > 127 { 2 } else { 1 };
                    let cell = Cell {
                        ch: Some(ch.to_string()),
                        width,
                        ..Default::default()
                    };
                    row.push(cell);
                }
                if !row.is_empty() {
                    lines.push(row);
                }
            }
        }
        Screen {
            cols: self.cols,
            rows: self.rows,
            cursor: Cursor {
                col: 0,
                row: 0,
                shape: CursorShape::Block,
                visible: true,
                blinking: false,
                blink_visible: true,
                focused: false,
                preedit: None,
            },
            scrollback: Default::default(),
            lines,
        }
    }

    fn modes(&self) -> Modes {
        self.custom_modes.clone().unwrap_or_default()
    }

    fn reset(&mut self) {
        self.feed_history.clear();
    }
}

#[tokio::test]
async fn vendor_event_is_emitted_only_with_the_owning_surface_id() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = br#"{"surface":"owned-surface","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"owned-surface","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"owned-surface","body":{"operation":"input","bytes":"G103O2ZpbGU6Ly8vdG1wL3Byb2plY3QH"}}
"#;
    let (mut to_serve, serve_in) = tokio::io::duplex(16 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(16 * 1024);
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "owned-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let task = tokio::spawn(serve(
        engine_factory,
        serve_in,
        serve_out,
        session_port_factory,
    ));
    to_serve.write_all(input).await.unwrap();
    let mut lines = tokio::io::BufReader::new(from_serve).lines();
    let mut found = false;
    for _ in 0..8 {
        let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
            .await
            .expect("timeout waiting for owned vendor event")
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        if value["body"]["event"] == "directory" {
            assert_eq!(value["surface"], "owned-surface");
            assert_eq!(value["body"]["uri"], "file:///tmp/project");
            found = true;
            break;
        }
    }
    assert!(found, "owned vendor event was not emitted");
    drop(to_serve);
    task.await.unwrap().unwrap();
}

#[derive(Debug, Default, Clone)]
struct Calls {
    opens: Vec<(u16, u16)>,
    writes: Vec<(String, Vec<u8>)>,
    resizes: Vec<(String, u16, u16)>,
    detaches: Vec<String>,
    closes: Vec<String>,
}

struct FakeSessionPort {
    session_id: String,
    calls: Arc<Mutex<Calls>>,
    event_tx: mpsc::UnboundedSender<DaemonEvent>,
    event_rx: Arc<tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<DaemonEvent>>>>,
}

impl FakeSessionPort {
    fn new(session_id: String, calls: Arc<Mutex<Calls>>) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Self {
            session_id,
            calls,
            event_tx,
            event_rx: Arc::new(tokio::sync::Mutex::new(Some(event_rx))),
        }
    }

    pub fn push_event(&self, event: DaemonEvent) {
        let _ = self.event_tx.send(event);
    }
}

#[async_trait]
impl SessionPort for FakeSessionPort {
    async fn open(
        &self,
        _program: &str,
        cols: u16,
        rows: u16,
        _hint: Option<&str>,
    ) -> Result<String, String> {
        self.calls.lock().unwrap().opens.push((cols, rows));
        Ok(self.session_id.clone())
    }

    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .writes
            .push((session_id.to_string(), data.to_vec()));
        if data == b"\x1b]7;file:///tmp/project\x07" {
            let _ = self.event_tx.send(DaemonEvent::Output {
                session_id: self.session_id.clone(),
                data: data.to_vec(),
                sequence: 0,
                truncated: false,
            });
        }
        Ok(())
    }

    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .resizes
            .push((session_id.to_string(), cols, rows));
        Ok(())
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .detaches
            .push(session_id.to_string());
        Ok(())
    }

    async fn close(&self, session_id: &str) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .closes
            .push(session_id.to_string());
        Ok(())
    }

    async fn get_events(&self) -> mpsc::Receiver<DaemonEvent> {
        let (tx, rx) = mpsc::channel(10);
        let mut rx_guard = self.event_rx.lock().await;
        if let Some(mut unbounded_rx) = rx_guard.take() {
            tokio::spawn(async move {
                while let Some(event) = unbounded_rx.recv().await {
                    let _ = tx.send(event).await;
                }
            });
        }
        rx
    }
}

#[tokio::test]
async fn test_a3_input_calls_write() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","bytes":"aGk="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    // Verify that write was called with the right data
    let calls_lock = calls.lock().unwrap();
    assert!(!calls_lock.writes.is_empty(), "write not called");
    assert_eq!(
        calls_lock.writes[0].0, fake_session_id,
        "session_id mismatch"
    );
    assert_eq!(calls_lock.writes[0].1, b"hi", "write data mismatch");
}

#[tokio::test]
async fn an_open_without_a_shell_is_rejected_without_a_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let factory_calls = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "no-shell".to_string(),
            factory_calls.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let output = String::from_utf8(writer).unwrap();
    assert!(
        output.contains(r#""reason":"open requires a shell""#),
        "an open without a shell was not rejected: {output}"
    );
    assert!(
        calls.lock().unwrap().opens.is_empty(),
        "an open without a shell started a session"
    );
}

#[tokio::test]
async fn native_input_ack_is_not_reported_as_an_unsolicited_event() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let factory_calls = calls.clone();
    let factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "input-ack".to_string(),
            factory_calls.clone(),
        )) as Arc<dyn SessionPort>
    });
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","focus":{"focused":true}}}
{"surface":"s1","body":{"operation":"input","compose":{"text":"한","selectedRange":{"location":1,"length":0},"replacementRange":null,"attributed":true}}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);

    serve(engine_factory, reader, &mut writer, factory)
        .await
        .unwrap();

    let acknowledgements: Vec<serde_json::Value> = String::from_utf8(writer)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(|value: &serde_json::Value| value["body"]["ack"] == true)
        .collect();
    assert_eq!(
        acknowledgements.len(),
        2,
        "focus and compose must each acknowledge once"
    );
    for acknowledgement in acknowledgements {
        assert!(
            acknowledgement["body"]["event"].is_null(),
            "native input ACK must not become an unsolicited event: {acknowledgement}"
        );
    }
}

#[tokio::test]
async fn each_native_preedit_update_presents_a_fresh_terminal_frame() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let factory_calls = calls.clone();
    let factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "preedit-frame".to_string(),
            factory_calls.clone(),
        )) as Arc<dyn SessionPort>
    });
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":1}}}}
{"surface":"s1","body":{"operation":"input","focus":{"focused":true}}}
{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":2}}}}
{"surface":"s1","body":{"operation":"input","compose":{"text":"ㅎ","selectedRange":{"location":1,"length":0},"replacementRange":null,"attributed":true}}}
{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":3}}}}
{"surface":"s1","body":{"operation":"input","compose":{"text":"하","selectedRange":{"location":1,"length":0},"replacementRange":null,"attributed":true}}}
{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":4}}}}
{"surface":"s1","body":{"operation":"input","compose":{"text":"한","selectedRange":{"location":1,"length":0},"replacementRange":null,"attributed":true}}}
{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":5}}}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);

    serve(engine_factory, reader, &mut writer, factory)
        .await
        .unwrap();

    let frames = String::from_utf8(writer)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|value| value["body"]["image"]["sequence"].is_number())
        .count();
    assert!(frames >= 5,
        "initial frame, focus frame, and all three successive preedit frames must be presented; got {frames}");
}

#[tokio::test]
async fn test_paste_writes_ordered_text_using_bracketed_mode() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-paste-session".to_string();
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"paste","text":"one\ntwo"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let engine_factory = Arc::new(|| {
        Box::new(MockEngine::with_modes(Modes {
            bracketed_paste: true,
            ..Modes::default()
        })) as Box<dyn Engine>
    });
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes[0].1, b"\x1b[200~one\ntwo\x1b[201~");
}

#[tokio::test]
async fn test_paste_rejects_non_text_payload() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"paste","kind":"png","data":"iVBORw=="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "unused".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    assert!(String::from_utf8(writer)
        .unwrap()
        .contains("paste requires text string"));
    assert!(calls.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn test_bracketed_paste_rejects_embedded_terminator_without_writing() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh"}}
{"surface":"s1","body":{"operation":"paste","text":"before\u001b[201~after"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| {
        Box::new(MockEngine::with_modes(Modes {
            bracketed_paste: true,
            ..Modes::default()
        })) as Box<dyn Engine>
    });
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "unused".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let output = String::from_utf8(writer).unwrap();
    assert!(output.contains("bracketed-paste terminator"));
    assert!(calls.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn test_clipboard_reject_is_an_explicit_protocol_event() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","body":{"operation":"clipboard.reject","requestId":7,"reason":"denied"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "unused".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let output = String::from_utf8(writer).unwrap();
    assert!(output.contains("clipboard.rejected"));
    assert!(output.contains("\"requestId\":7"));
    assert!(output.contains("\"reason\":\"denied\""));
}

async fn serve_copy(selection: Option<&str>) -> String {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","body":{"operation":"open","shell":"/bin/sh"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"copy"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let selection = selection.map(str::to_string);
    let engine_factory = Arc::new(move || {
        let mut engine = MockEngine::new();
        engine.selection = selection.clone();
        Box::new(engine) as Box<dyn Engine>
    });
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new("copy".to_string(), calls.clone())) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    String::from_utf8(writer).unwrap()
}

#[tokio::test]
async fn a_copy_request_sends_the_current_selection_text_or_reports_none() {
    let output = serve_copy(Some("selected")).await;
    assert!(
        output.contains(r#""event":"copy""#)
            && output.contains(r#""text":"selected""#)
            && output.contains(r#""userInitiated":true"#),
        "a copy request did not send the selection text: {output}"
    );
    let output = serve_copy(None).await;
    assert!(
        output.contains(r#""event":"copy""#) && output.contains(r#""copied":false"#),
        "a copy request without a selection did not report that nothing was copied: {output}"
    );
    assert!(!output.contains("Unknown operation: copy"), "{output}");
}

async fn serve_scroll(modes: Option<Modes>, requests: &str) -> (String, Vec<String>, Vec<Vec<u8>>) {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = format!(
        "{}\n{}\n{}",
        r#"{"surface":"s1","body":{"operation":"open","shell":"/bin/sh"}}"#,
        r#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}"#,
        requests
    );
    let reader = std::io::Cursor::new(input.into_bytes());
    let mut writer = Vec::new();
    let viewport = Arc::new(Mutex::new(Vec::new()));
    let engine_viewport = viewport.clone();
    let engine_factory = Arc::new(move || {
        let mut engine = match modes.clone() {
            Some(modes) => MockEngine::with_modes(modes),
            None => MockEngine::new(),
        };
        engine.viewport = engine_viewport.clone();
        Box::new(engine) as Box<dyn Engine>
    });
    let port_calls = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "scroll".to_string(),
            port_calls.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let writes = calls
        .lock()
        .unwrap()
        .writes
        .iter()
        .map(|(_, bytes)| bytes.clone())
        .collect();
    let viewport = viewport.lock().unwrap().clone();
    (String::from_utf8(writer).unwrap(), viewport, writes)
}

#[tokio::test]
async fn a_scroll_moves_the_primary_viewport_and_input_returns_it_to_the_newest_output() {
    let (output, viewport, writes) = serve_scroll(
        None,
        r#"{"surface":"s1","body":{"operation":"scroll","lines":3,"col":2,"row":1}}
{"surface":"s1","body":{"operation":"input","bytes":"aGk="}}
"#,
    )
    .await;
    assert_eq!(
        viewport,
        vec!["viewport 3".to_string(), "newest".to_string()],
        "{output}"
    );
    assert!(
        output.contains(r#""scrollback""#),
        "the screen event after a scroll carries scrollback: {output}"
    );
    assert_eq!(
        writes,
        vec![b"hi".to_vec()],
        "a primary-screen scroll writes nothing to the shell"
    );
}

#[tokio::test]
async fn a_scroll_with_mouse_reporting_writes_wheel_buttons_at_the_pointer_cell() {
    let modes = Modes {
        mouse_report: true,
        sgr_mouse: true,
        ..Modes::default()
    };
    let (output, viewport, writes) = serve_scroll(
        Some(modes),
        r#"{"surface":"s1","body":{"operation":"scroll","lines":2,"col":4,"row":6}}
{"surface":"s1","body":{"operation":"scroll","lines":-1,"col":4,"row":6}}
"#,
    )
    .await;
    assert!(
        viewport.iter().all(|call| !call.starts_with("viewport")),
        "{viewport:?}"
    );
    assert_eq!(
        writes,
        vec![
            b"\x1b[<64;5;7M\x1b[<64;5;7M".to_vec(),
            b"\x1b[<65;5;7M".to_vec()
        ],
        "{output}"
    );
}

#[tokio::test]
async fn a_scroll_on_the_alternate_screen_writes_cursor_keys() {
    let modes = Modes {
        alt_screen: true,
        alternate_scroll: true,
        ..Modes::default()
    };
    let (output, viewport, writes) = serve_scroll(
        Some(modes),
        r#"{"surface":"s1","body":{"operation":"scroll","lines":2,"col":0,"row":0}}
{"surface":"s1","body":{"operation":"scroll","lines":-1,"col":0,"row":0}}
"#,
    )
    .await;
    assert!(
        viewport.iter().all(|call| !call.starts_with("viewport")),
        "{viewport:?}"
    );
    assert_eq!(
        writes,
        vec![b"\x1b[A\x1b[A".to_vec(), b"\x1b[B".to_vec()],
        "{output}"
    );
}

#[tokio::test]
async fn an_invalid_scroll_is_rejected() {
    let (output, viewport, writes) = serve_scroll(
        None,
        r#"{"surface":"s1","body":{"operation":"scroll","lines":0,"col":0,"row":0}}
{"surface":"s1","body":{"operation":"scroll","lines":1.5,"col":0,"row":0}}
"#,
    )
    .await;
    assert_eq!(output.matches("invalidParams").count(), 2, "{output}");
    assert!(viewport.is_empty() && writes.is_empty());
}

#[tokio::test]
async fn test_selection_release_emits_one_user_copy_event() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","body":{"operation":"open","shell":"/bin/sh"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"selection.start","x":1.0,"y":1.0}}
{"surface":"s1","body":{"operation":"selection.update","x":25.0,"y":1.0}}
{"surface":"s1","body":{"operation":"selection.end"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "unused".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let output = String::from_utf8(writer).unwrap();
    assert!(
        output.contains("selection.copy"),
        "selection release must emit a copy event: {output}"
    );
    assert!(!output.contains("Unknown operation: selection.start"));
    assert!(!output.contains("Unknown operation: selection.update"));
    assert!(!output.contains("Unknown operation: selection.end"));
}

/// A point in the region past the last full row or column selects the nearest cell; a point outside the region is an error.
#[tokio::test]
async fn test_selection_in_the_region_padding_selects_the_nearest_cell() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    // 801 x 383 픽셀은 칸 크기의 배수가 아니므로 마지막 완전한 행과 열 뒤에 여백이 남는다.
    let input = r#"{"surface":"s1","body":{"operation":"open","shell":"/bin/sh"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":801,"height":383,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"selection.start","x":1.0,"y":1.0}}
{"surface":"s1","body":{"operation":"selection.update","x":800.5,"y":382.5}}
{"surface":"s1","body":{"operation":"selection.update","x":1.0,"y":383.0}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let cells = Arc::new(Mutex::new(Vec::new()));
    let recorded = cells.clone();
    let engine_factory = Arc::new(move || {
        let mut engine = MockEngine::new();
        engine.selected_cells = recorded.clone();
        Box::new(engine) as Box<dyn Engine>
    });
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "unused".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let output = String::from_utf8(writer).unwrap();
    let state = output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|message| message["body"]["event"] == "state")
        .last()
        .expect("a state event");
    let cols = state["body"]["cols"].as_u64().unwrap() as u16;
    let rows = state["body"]["rows"].as_u64().unwrap() as u16;
    let cell_width = state["body"]["cellWidth"].as_f64().unwrap();
    let cell_height = state["body"]["cellHeight"].as_f64().unwrap();
    assert!(
        f64::from(cols) * cell_width < 800.5 && f64::from(rows) * cell_height < 382.5,
        "the region must leave padding past the grid: {cols}x{rows} cells of {cell_width}x{cell_height}"
    );
    assert_eq!(
        *cells.lock().unwrap(),
        vec![(0, 0), (cols - 1, rows - 1)],
        "the padding point selects the last cell: {output}"
    );
    let errors: Vec<&str> = output
        .lines()
        .filter(|line| line.contains("outside the terminal region"))
        .collect();
    assert_eq!(
        errors.len(),
        1,
        "only the point below the region is an error: {output}"
    );
}

/// A release over blank cells reports the end of the gesture without an error or a copy.
#[tokio::test]
async fn test_blank_selection_release_reports_end_without_copy() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","body":{"operation":"open","shell":"/bin/sh"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"selection.start","x":700.0,"y":300.0}}
{"surface":"s1","body":{"operation":"selection.update","x":760.0,"y":300.0}}
{"surface":"s1","body":{"operation":"selection.end"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| {
        let mut engine = MockEngine::new();
        engine.selection = None;
        Box::new(engine) as Box<dyn Engine>
    });
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "unused".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });
    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let output = String::from_utf8(writer).unwrap();
    let ends: Vec<serde_json::Value> = output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|message| message["body"]["event"] == "selection.end")
        .collect();
    assert_eq!(ends.len(), 1, "one selection.end event: {output}");
    assert_eq!(ends[0]["body"]["copied"], serde_json::Value::Bool(false));
    assert!(
        !output.contains("selection.copy"),
        "nothing is copied: {output}"
    );
    assert!(
        !output.contains("\"error\""),
        "the release is not an error: {output}"
    );
}

/// Test A-7: close op ends the session (calls close, not detach)
#[tokio::test]
async fn test_a7_close_op_ends_the_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"close"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    // Verify that close was called and detach was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.closes.len(), 1, "close not called exactly once");
    assert_eq!(
        calls_lock.closes[0], fake_session_id,
        "close session_id mismatch"
    );
    assert!(
        calls_lock.detaches.is_empty(),
        "detach should not be called for close op"
    );
}

/// Test A-8: closed:true flag closes the terminal session
#[tokio::test]
async fn test_a8_closed_surface_closes_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","closed":true}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    // Verify that close was called and detach was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.closes.len(), 1, "close not called exactly once");
    assert_eq!(
        calls_lock.closes[0], fake_session_id,
        "close session_id mismatch"
    );
    assert!(
        calls_lock.detaches.is_empty(),
        "detach should not be called for closed:true flag"
    );
}

#[tokio::test]
async fn test_input_not_fed_to_engine() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","bytes":"aGVsbG8="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "test-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let result = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_stdin_eof_terminates_quickly() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "test-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    // 서비스는 시작할 때 글꼴을 먼저 읽는다. 이 검사는 EOF 뒤의 종료 시간만 재므로 같은 순서로 글꼴을 먼저 읽는다.
    // 새 프로세스의 첫 CoreText 호출은 2초 넘게 걸릴 수 있다(V5-7).
    soksak_sidecar_vt_core::platform::darwin::frame::load_default_font()
        .expect("the system fixed-pitch font");
    let start = std::time::Instant::now();
    let result = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let elapsed = start.elapsed();

    assert!(result.is_ok());
    assert!(
        elapsed < std::time::Duration::from_millis(1500),
        "stdin EOF took too long: {}ms",
        elapsed.as_millis()
    );
}

#[tokio::test]
async fn test_open_and_close_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","closed":true}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "test-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
}

#[tokio::test]
async fn test_repeated_image_open_resets_native_frame_without_closing_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"reconnect"}}
{"surface":"s1","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":2,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","bytes":"Yg=="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "test-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls = calls.lock().unwrap();
    assert_eq!(
        calls.opens.len(),
        1,
        "repeated image open must preserve the PTY session"
    );
    assert_eq!(
        calls.writes.len(),
        1,
        "input must still reach the preserved session"
    );
    let output = String::from_utf8(writer).unwrap();
    assert_eq!(
        output.matches("\"event\":\"session\"").count(),
        1,
        "the replacement page must receive the preserved session identity exactly once"
    );
    assert_eq!(
        output.matches("\"image\"").count(),
        2,
        "each image open must wait for a fresh configured raster: {output}"
    );
}

#[tokio::test]
async fn test_resize() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":1}}}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":2,"width":1600,"height":768,"scale":1.0}}}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "test-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
}

#[tokio::test]
async fn test_close_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","closed":true}
{"surface":"s1","body":{"operation":"input","bytes":"aGk="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            "test-session".to_string(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
}

#[tokio::test]
async fn test_wide_chars() {
    let mut engine = MockEngine::new();
    engine.feed("안".as_bytes());

    let screen = engine.screen();
    assert_eq!(screen.lines.len(), 1);
    assert_eq!(screen.lines[0][0].width, 2);
}

/// Test A-2: Pushed output reaches screen
#[tokio::test]
async fn test_a2_pushed_output_reaches_screen() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-a2".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    // Use tokio::io::duplex for stdin/stdout
    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open command
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    // Wait for state response (should contain sessionId)
    let state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for state")
        .expect("failed to read state line")
        .expect("state line is empty");

    let state_json: serde_json::Value =
        serde_json::from_str(&state_line).expect("failed to parse state JSON");
    assert_eq!(state_json["body"]["event"], "state", "expected state event");

    // Push output event with "hi\r\n"
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"hi\r\n".to_vec(),
        sequence: 0,
        truncated: false,
    });

    // Wait for screen event (should contain "hi")
    let mut found_hi = false;
    loop {
        let screen_line =
            tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
                .await
                .expect("timeout waiting for screen")
                .expect("failed to read screen line")
                .expect("screen line is empty");

        let screen_json: serde_json::Value =
            serde_json::from_str(&screen_line).expect("failed to parse screen JSON");

        if let Some(event) = screen_json.get("body").and_then(|b| b.get("event")) {
            if event == "screen" {
                // Found screen event, check if any line contains "hi"
                if let Some(lines_arr) = screen_json.get("body").and_then(|b| b.get("lines")) {
                    if let Some(lines_vec) = lines_arr.as_array() {
                        for line in lines_vec {
                            if let Some(cells) = line.as_array() {
                                let mut line_text = String::new();
                                for cell in cells {
                                    if let Some(ch) = cell.get("ch").and_then(|c| c.as_str()) {
                                        line_text.push_str(ch);
                                    }
                                }
                                let trimmed = line_text.trim_end();
                                if trimmed == "hi" {
                                    found_hi = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                break; // Exit after first screen event
            }
        }
    }

    assert!(found_hi, "Output 'hi' did not appear in screen event");

    // Close stdin to terminate serve
    drop(to_serve);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_inline_image_event_is_explicit_and_base64_encoded() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-inline-image".to_string();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let port = Arc::new(FakeSessionPort::new(fake_session_id.clone(), calls.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);
    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve
        .write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#)
        .await
        .unwrap();
    let _state = lines.next_line().await.unwrap().unwrap();
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id,
        data: b"\x1b]1337;File=name=ZmlsZS5wbmc=;size=5;inline=1;width=2px:aGVsbG8=\x07".to_vec(),
        sequence: 0,
        truncated: false,
    });

    let mut found = false;
    for _ in 0..4 {
        let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
            .await
            .expect("timeout waiting for inline image event")
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        if value["body"]["event"] == "image.inline" {
            assert_eq!(value["body"]["command"], "display");
            assert_eq!(value["body"]["name"], "file.png");
            assert_eq!(value["body"]["data"], "aGVsbG8=");
            assert_eq!(value["body"]["width"], "2px");
            found = true;
            break;
        }
    }
    assert!(found, "inline image event was not emitted");
    to_serve
        .write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"image.inline.delete","name":"file.png"}}
"#)
        .await
        .unwrap();
    let mut deleted = false;
    for _ in 0..4 {
        let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
            .await
            .expect("timeout waiting for inline image deletion")
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        if value["body"]["event"] == "image.inline.deleted" {
            assert_eq!(value["body"]["name"], "file.png");
            deleted = true;
            break;
        }
    }
    assert!(deleted, "owned inline image was not deleted");
    drop(to_serve);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_inline_image_delete_is_explicit_for_unowned_names() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let port = Arc::new(FakeSessionPort::new("delete-session".into(), calls));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);
    let (mut to_serve, serve_in) = tokio::io::duplex(16 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(16 * 1024);
    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();
    to_serve
        .write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"image.inline.delete","name":"missing.png"}}
"#)
        .await
        .unwrap();
    let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for explicit delete error")
        .unwrap()
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["body"]["error"], "imageNotConfigured");
    drop(to_serve);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_a5_screen_read_returns_current_screen() {
    let input = r#"
{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","bytes":"aGk="}}
{"surface":"s1","body":{"operation":"screen.read"}}
"#;

    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> =
        Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
    let session_port_for_factory = session_port.clone();
    let factory = Arc::new(move || session_port_for_factory.clone());

    let result = serve(engine_factory, reader, &mut writer, factory).await;
    assert!(result.is_ok());

    let output = String::from_utf8(writer).unwrap();
    let lines: Vec<&str> = output.lines().collect();

    // Should have: open response, input ack, screen.read screen response
    // First line is open response
    let open_json: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(open_json["body"]["event"], "state");

    // Find screen event with "hi" (from screen.read)
    let mut found_screen_read = false;
    for line in lines.iter().skip(1) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(event) = json.get("body").and_then(|b| b.get("event")) {
                if event == "screen" {
                    found_screen_read = true;
                    break;
                }
            }
        }
    }
    assert!(
        found_screen_read,
        "screen.read should return a screen event"
    );
}

#[tokio::test]
async fn test_a6_unknown_op_returns_error() {
    let input = r#"
{"surface":"s1","body":{"operation":"unknown_operation"}}
"#;

    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> =
        Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
    let session_port_for_factory = session_port.clone();
    let factory = Arc::new(move || session_port_for_factory.clone());

    let result = serve(engine_factory, reader, &mut writer, factory).await;
    assert!(result.is_ok());

    let output = String::from_utf8(writer).unwrap();
    let lines: Vec<&str> = output.lines().collect();
    assert!(!lines.is_empty());

    let json: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert!(json["body"]["error"]
        .as_str()
        .unwrap()
        .contains("Unknown operation"));
}

#[tokio::test]
async fn test_theme_rejects_unknown_mode_without_fallback() {
    let input = r#"
{"surface":"s1","body":{"operation":"theme","mode":"light"}}
{"surface":"s1","body":{"operation":"theme","mode":"sepia"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> =
        Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
    let session_port_for_factory = session_port.clone();
    let factory = Arc::new(move || session_port_for_factory.clone());

    serve(engine_factory, reader, &mut writer, factory)
        .await
        .expect("theme contract");
    let output = String::from_utf8(writer).expect("utf8 output");
    let outputs = output
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(outputs
        .iter()
        .any(|value| value["body"]["event"] == "theme"));
    assert!(outputs.iter().any(|value| {
        value["body"]["error"] == "invalidParams"
            && value["body"]["reason"] == "theme.mode must be dark or light"
    }));
}

#[tokio::test]
async fn test_cursor_policy_rejects_invalid_values_without_fallback() {
    let input = r#"
{"surface":"s1","body":{"operation":"cursor","shape":"beam","blink":"Always","interval":750,"idleTimeout":5000,"unfocused":"hollow"}}
{"surface":"s1","body":{"operation":"cursor","blink":"Sometimes"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> =
        Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
    let session_port_for_factory = session_port.clone();
    let factory = Arc::new(move || session_port_for_factory.clone());

    serve(engine_factory, reader, &mut writer, factory)
        .await
        .expect("cursor policy contract");
    let outputs = String::from_utf8(writer)
        .expect("utf8 output")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(outputs
        .iter()
        .any(|value| { value["body"]["event"] == "cursor" && value["body"]["blink"] == "Always" }));
    assert!(outputs.iter().any(|value| {
        value["body"]["error"] == "invalidParams"
            && value["body"]["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("cursor.blink"))
    }));
}

/// Test K1: Keys encoded without app_cursor mode
#[tokio::test]
async fn test_k1_keys_up_without_app_cursor() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","keys":[{"key":"Up"}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 1, "should have exactly one write");
    assert_eq!(
        calls_lock.writes[0].1, b"\x1b[A",
        "Up key without app_cursor should be ESC[A"
    );
}

/// Test K2: Keys encoded with app_cursor mode
#[tokio::test]
async fn test_k2_keys_up_with_app_cursor() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","keys":[{"key":"Up"}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let modes = Modes {
        app_cursor: true,
        ..Default::default()
    };
    let engine_factory =
        Arc::new(move || Box::new(MockEngine::with_modes(modes.clone())) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 1, "should have exactly one write");
    assert_eq!(
        calls_lock.writes[0].1, b"\x1bOA",
        "Up key with app_cursor should be ESC O A"
    );
}

/// Test K3: Char key encoding with ctrl and UTF-8
#[tokio::test]
async fn test_k3_char_key_encoding() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    // native 물리 키 매핑 뒤 Ctrl+C는 0x03, Ctrl+U는 0x15를 기록한다.
    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","keys":[{"key":"Char","text":"c","ctrl":true}]}}
{"surface":"s1","body":{"operation":"input","keys":[{"key":"Char","text":"u","ctrl":true}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 2);
    assert_eq!(calls_lock.writes[0].1, vec![0x03], "ctrl+c should be 0x03");
    assert_eq!(calls_lock.writes[1].1, vec![0x15], "ctrl+u should be 0x15");

    // Test UTF-8 encoding (한)
    drop(calls_lock);

    let calls2 = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id2 = "test-session-2".to_string();

    let input2 = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","keys":[{"key":"Char","text":"한"}]}}
"#;
    let reader2 = std::io::Cursor::new(input2.as_bytes());
    let mut writer2 = Vec::new();

    let engine_factory2 = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory2 = calls2.clone();
    let session_id_for_factory2 = fake_session_id2.clone();
    let session_port_factory2 = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory2.clone(),
            calls_for_factory2.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(
        engine_factory2,
        reader2,
        &mut writer2,
        session_port_factory2,
    )
    .await;

    let calls_lock2 = calls2.lock().unwrap();
    assert_eq!(calls_lock2.writes.len(), 1);
    assert_eq!(
        calls_lock2.writes[0].1,
        "한".as_bytes(),
        "Char with UTF-8 should encode as UTF-8 bytes"
    );
}

/// Test K4: Unknown key returns error, no write
#[tokio::test]
async fn test_k4_unknown_key_returns_error() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
{"surface":"s1","body":{"operation":"input","keys":[{"key":"Nope"}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.writes.len(),
        0,
        "should not call write for unknown key"
    );

    let output = String::from_utf8(writer).unwrap();
    let lines: Vec<&str> = output.lines().collect();

    let mut found_error = false;
    for line in lines {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(error) = json.get("body").and_then(|b| b.get("error")) {
                if error.as_str().unwrap().contains("unknown key: Nope") {
                    found_error = true;
                    break;
                }
            }
        }
    }
    assert!(found_error, "should return error for unknown key");
}

/// Open is inert until the host supplies an exact native raster configuration.
#[tokio::test]
async fn test_open_waits_for_host_raster_configuration() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i4".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve
        .write_all(
            br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
"#,
        )
        .await
        .unwrap();

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line())
            .await
            .is_err(),
        "open produced output before the host configured a raster"
    );
    assert!(calls.lock().unwrap().opens.is_empty());

    to_serve
        .write_all(br#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#)
        .await
        .unwrap();
    let state = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&state).unwrap();
    assert_eq!(json["body"]["event"], "state");
    assert_eq!(calls.lock().unwrap().opens.len(), 1);

    drop(to_serve);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_headless_open_creates_one_session_before_configuration() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let port = Arc::new(FakeSessionPort::new("headless".into(), calls.clone()));
    let factory_port = port.clone();
    let factory = Arc::new(move || factory_port.clone() as Arc<dyn SessionPort>);
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let (mut input, serve_input) = tokio::io::duplex(64 * 1024);
    let (serve_output, output) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(serve(engine_factory, serve_input, serve_output, factory));
    let mut lines = tokio::io::BufReader::new(output).lines();
    input
        .write_all(
            b"{\"surface\":\"hidden\",\"root\":\"/tmp\",\"body\":{\"operation\":\"open\",\"shell\":\"/bin/sh\"}}\n",
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line())
            .await
            .is_err()
    );
    assert_eq!(calls.lock().unwrap().opens, vec![(80, 24)]);
    input.write_all(b"{\"surface\":\"hidden\",\"body\":{\"image\":{\"configure\":{\"name\":\"view\",\"generation\":1,\"raster\":1,\"width\":800,\"height\":384,\"scale\":1.0}}}}\n").await.unwrap();
    let state = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&state).unwrap()["body"]["event"],
        "state"
    );
    assert_eq!(calls.lock().unwrap().opens.len(), 1);
    drop(input);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_legacy_op_field_is_rejected_without_fallback() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let port = Arc::new(FakeSessionPort::new("legacy-op".into(), calls.clone()));
    let factory_port = port.clone();
    let factory = Arc::new(move || factory_port.clone() as Arc<dyn SessionPort>);
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let (mut input, serve_input) = tokio::io::duplex(64 * 1024);
    let (serve_output, output) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(serve(engine_factory, serve_input, serve_output, factory));
    let mut lines = tokio::io::BufReader::new(output).lines();

    input
        .write_all(
            br#"{"surface":"legacy","root":"/tmp","body":{"op":"open"}}
"#,
        )
        .await
        .unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert_eq!(json["body"]["error"], "unknown operation");
    assert!(
        calls.lock().unwrap().opens.is_empty(),
        "legacy op must not open a session"
    );

    drop(input);
    task.await.unwrap().unwrap();
}

/// Test I1: Image envelope sent after output when open has image field
#[tokio::test]
async fn test_i1_image_envelope_on_output() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i1".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITH image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    // Wait for state response
    let state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for state")
        .expect("failed to read state line")
        .expect("state line is empty");

    let state_json: serde_json::Value =
        serde_json::from_str(&state_line).expect("failed to parse state JSON");
    assert_eq!(state_json["body"]["event"], "state", "expected state event");

    // Push output event
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"hi\r\n".to_vec(),
        sequence: 0,
        truncated: false,
    });

    // Wait for image envelope
    let image_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for image envelope")
        .expect("failed to read image line")
        .expect("image line is empty");

    let image_json: serde_json::Value =
        serde_json::from_str(&image_line).expect("failed to parse image JSON");

    // Verify image envelope structure
    let image_obj = image_json
        .get("body")
        .and_then(|b| b.get("image"))
        .expect("should have image envelope");

    assert_eq!(image_obj["name"], "view", "image name should be 'view'");
    assert_eq!(image_obj["sequence"], 1, "initial sequence should be 1");
    assert_eq!(image_obj["format"], "bgra8", "format should be bgra8");

    let token = image_obj.get("token").expect("should have token");
    assert_eq!(
        token["kind"], "iosurface-global",
        "token kind should be iosurface-global"
    );

    let nonce_b64 = token["nonce"].as_str().expect("nonce should be string");
    let nonce_bytes = base64_decode_test(nonce_b64).expect("nonce should be valid base64");
    assert_eq!(nonce_bytes.len(), 16, "nonce should be 16 bytes");

    assert!(
        image_obj["width"].as_u64().unwrap_or(0) > 0,
        "width should be > 0"
    );
    assert!(
        image_obj["height"].as_u64().unwrap_or(0) > 0,
        "height should be > 0"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test I2: No second image envelope until the host responds, including a stale response
#[tokio::test]
async fn test_i2_no_image_envelope_until_consumed() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i2".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITH image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();

    // Push first output
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test1\r\n".to_vec(),
        sequence: 0,
        truncated: false,
    });

    // Wait for first image envelope
    let _image_line1 =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .expect("timeout on first image envelope")
            .expect("failed to read first image line")
            .expect("first image line is empty");

    // Push second output WITHOUT release
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test2\r\n".to_vec(),
        sequence: 1,
        truncated: false,
    });

    // Wait for screen event instead (should NOT get image envelope within 300ms)
    let result =
        tokio::time::timeout(std::time::Duration::from_millis(300), lines.next_line()).await;

    // Should timeout or get a screen event, NOT an image envelope
    if let Ok(Ok(Some(line))) = result {
        let json: serde_json::Value = serde_json::from_str(&line).expect("failed to parse JSON");
        // If we got an image envelope, that's wrong
        assert!(
            json.get("body").and_then(|b| b.get("image")).is_none(),
            "should NOT have image envelope before release"
        );
    }

    // A layout replacement can make the in-flight response stale before the sidecar sees it.
    // It must still release the serialized transfer so the dirty screen can be sent.
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"error":"stale","name":"view","generation":2,"raster":9,"sequence":7}}}
"#).await.unwrap();

    // Wait for second image envelope (sequence 2) within 2 seconds
    let mut found_sequence_2 = false;
    for _ in 0..20 {
        if let Ok(Ok(Some(line))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await
        {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(img) = json.get("body").and_then(|b| b.get("image")) {
                    if img["sequence"] == 2 {
                        found_sequence_2 = true;
                        break;
                    }
                }
            }
        }
    }

    assert!(
        found_sequence_2,
        "should get image envelope with sequence 2 after release"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test I3: Host image response (consumed/error) is handled, no error returned
#[tokio::test]
async fn test_i3_image_response_no_error() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i3".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITH image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();

    // Push output
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test\r\n".to_vec(),
        sequence: 0,
        truncated: false,
    });

    // Wait for image envelope
    let _image_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();

    // Test 1: Send consumed response (no "error")
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":1}}}}
"#).await.unwrap();

    // Should NOT get error response, just screen or image envelope
    let mut found_error_response = false;
    for _ in 0..10 {
        if let Ok(Ok(Some(line))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await
        {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(error) = json.get("body").and_then(|b| b.get("error")) {
                    if error
                        .as_str()
                        .map(|e| e.contains("unknown operation"))
                        .unwrap_or(false)
                    {
                        found_error_response = true;
                        break;
                    }
                }
            }
        }
    }
    assert!(
        !found_error_response,
        "should NOT return 'unknown operation' error for consumed response"
    );

    // Test 2: Send error response
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"error":"forbidden","name":"view","generation":1,"raster":1,"sequence":1}}}
"#).await.unwrap();

    // Should NOT get error response about unknown operation
    found_error_response = false;
    for _ in 0..10 {
        if let Ok(Ok(Some(line))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await
        {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(error) = json.get("body").and_then(|b| b.get("error")) {
                    if error
                        .as_str()
                        .map(|e| e.contains("unknown operation"))
                        .unwrap_or(false)
                    {
                        found_error_response = true;
                        break;
                    }
                }
            }
        }
    }
    assert!(
        !found_error_response,
        "should NOT return 'unknown operation' error for error response"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: open with image field is a request, not a host response
#[tokio::test]
async fn test_open_with_image_is_a_request() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-open-image".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(
            session_id_for_factory.clone(),
            calls_for_factory.clone(),
        )) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.opens.len(), 1, "should have called open exactly once - open with image was misclassified as host response!");
    assert!(
        calls_lock.opens[0].0 > 0 && calls_lock.opens[0].1 > 0,
        "should have valid cols and rows"
    );

    let output = String::from_utf8(writer).unwrap();
    let lines: Vec<&str> = output.lines().collect();
    assert!(!lines.is_empty(), "should have output");

    // Check that we got a state response (not an error)
    let first_json: serde_json::Value =
        serde_json::from_str(lines[0]).expect("failed to parse first output as JSON");
    assert_eq!(
        first_json["body"]["event"], "state",
        "expected state event after open with image"
    );
}

fn base64_decode_test(s: &str) -> Result<Vec<u8>, String> {
    use soksak_sidecar_vt_core::protocol::base64_decode;
    base64_decode(s)
}

/// A host raster configuration with a non-numeric width is rejected.
#[tokio::test]
async fn test_configure_with_invalid_width_type() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-invalid-width".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":"800","height":384,"scale":1.0}}}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    assert!(
        error_json["body"]["error"] == "invalidParams",
        "should return invalidParams error"
    );
    assert_eq!(reason, "invalid image configure");

    // Crucially, daemon should NOT have been called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.opens.len(),
        0,
        "daemon open should not be called for an invalid raster"
    );

    drop(calls_lock);
    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: input without bytes or keys is rejected
#[tokio::test]
async fn test_input_without_bytes_or_keys_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-input-empty".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    let _initial_image = next_image_envelope(&mut lines).await;

    // Send input with neither bytes nor keys
    to_serve
        .write_all(
            br#"{"surface":"s1","body":{"operation":"input"}}
"#,
        )
        .await
        .unwrap();

    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    // Should get error about missing field
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    let error_code = error_json["body"]["error"].as_str().unwrap_or("");
    assert!(
        error_code.contains("invalidParams") && reason.contains("bytes or keys"),
        "should report that bytes or keys is required, got error={} reason={}",
        error_code,
        reason
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: input with non-string bytes is rejected
#[tokio::test]
async fn test_input_with_non_string_bytes_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-bytes-type".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    let _initial_image = next_image_envelope(&mut lines).await;

    // Send input with bytes as number instead of string
    to_serve
        .write_all(
            br#"{"surface":"s1","body":{"operation":"input","bytes":123}}
"#,
        )
        .await
        .unwrap();

    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    // Should get error about bytes type
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    let error_code = error_json["body"]["error"].as_str().unwrap_or("");
    assert!(
        error_code.contains("invalidParams") && reason.contains("bytes must be a string"),
        "should report that bytes must be a string, got error={} reason={}",
        error_code,
        reason
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: input with non-array keys is rejected
#[tokio::test]
async fn test_input_with_non_array_keys_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-keys-type".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    let _initial_image = next_image_envelope(&mut lines).await;

    // Send input with keys as object instead of array
    to_serve
        .write_all(
            br#"{"surface":"s1","body":{"operation":"input","keys":{"key":"Up"}}}
"#,
        )
        .await
        .unwrap();

    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    // Should get error about keys type
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    let error_code = error_json["body"]["error"].as_str().unwrap_or("");
    assert!(
        error_code.contains("invalidParams") && reason.contains("keys must be an array"),
        "should report that keys must be an array, got error={} reason={}",
        error_code,
        reason
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// A replacement raster with a missing height is rejected.
#[tokio::test]
async fn test_replacement_raster_with_missing_height_is_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-missing".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line =
        tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();

    let _initial_image = next_image_envelope(&mut lines).await;

    // Send a new raster without height.
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":2,"width":1024,"scale":1.0}}}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    assert_eq!(
        error_json["body"]["error"], "invalidParams",
        "should return invalidParams"
    );
    assert_eq!(error_json["body"]["reason"], "invalid image configure");

    // Verify daemon resize was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.resizes.len(),
        0,
        "daemon resize should not be called for an incomplete raster"
    );

    drop(calls_lock);
    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: cellWidth/cellHeight are calculated from metrics, not hardcoded
#[tokio::test]
async fn test_cell_dimensions_from_metrics() {
    use soksak_sidecar_vt_core::platform::metrics;

    // Test with scale=2.0
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-metrics".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    let scale = 2.0f32;
    let width_px = 800u32;
    let height_px = 384u32;

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":2.0}}}}
"#).await.unwrap();

    let state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for state")
        .expect("failed to read state line")
        .expect("state line is empty");

    let state_json: serde_json::Value =
        serde_json::from_str(&state_line).expect("failed to parse state JSON");

    // Get actual metrics from platform
    let m = metrics(13.0, scale);

    // cellWidth and cellHeight should be CSS pixels = device_pixels / scale
    let expected_cell_width = m.cell_width as f64 / scale as f64;
    let expected_cell_height = m.cell_height as f64 / scale as f64;

    let cell_width = state_json["body"]["cellWidth"]
        .as_f64()
        .expect("cellWidth should be present and numeric");
    let cell_height = state_json["body"]["cellHeight"]
        .as_f64()
        .expect("cellHeight should be present and numeric");

    // Must match metrics exactly (within floating point tolerance)
    assert!(
        (cell_width - expected_cell_width).abs() < 0.1,
        "cellWidth at scale 2.0: expected {}, got {}",
        expected_cell_width,
        cell_width
    );
    assert!(
        (cell_height - expected_cell_height).abs() < 0.1,
        "cellHeight at scale 2.0: expected {}, got {}",
        expected_cell_height,
        cell_height
    );

    // Verify cols/rows calculation: cols = width_px / cell_width
    // (both width_px and cell_width are in device pixels, scale already accounted for in metrics)
    let cols = state_json["body"]["cols"]
        .as_u64()
        .expect("cols should be present") as u16;
    let rows = state_json["body"]["rows"]
        .as_u64()
        .expect("rows should be present") as u16;

    let expected_cols = (width_px as f32 / m.cell_width) as u16;
    let expected_rows = (height_px as f32 / m.cell_height) as u16;

    assert_eq!(
        cols, expected_cols,
        "cols should match metrics at scale 2.0: expected {}, got {}",
        expected_cols, cols
    );
    assert_eq!(
        rows, expected_rows,
        "rows should match metrics at scale 2.0: expected {}, got {}",
        expected_rows, rows
    );

    drop(to_serve);
    task.await.unwrap().unwrap();

    // Test with scale=1.0 to verify it works at different scales
    let calls2 = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id2 = "test-session-metrics-scale1".to_string();

    let engine_factory2 = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory2 = calls2.clone();
    let session_id_for_factory2 = fake_session_id2.clone();

    let port2 = Arc::new(FakeSessionPort::new(
        session_id_for_factory2.clone(),
        calls_for_factory2.clone(),
    ));
    let port_for_factory2 = port2.clone();
    let factory2 = Arc::new(move || port_for_factory2.clone() as Arc<dyn SessionPort>);

    let (mut to_serve2, serve_in2) = tokio::io::duplex(64 * 1024);
    let (serve_out2, from_serve2) = tokio::io::duplex(64 * 1024);

    let task2 = tokio::spawn(serve(engine_factory2, serve_in2, serve_out2, factory2));
    let mut lines2 = tokio::io::BufReader::new(from_serve2).lines();

    let scale2 = 1.0f32;

    to_serve2.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let state_line2 = tokio::time::timeout(std::time::Duration::from_secs(2), lines2.next_line())
        .await
        .expect("timeout waiting for state")
        .expect("failed to read state line")
        .expect("state line is empty");

    let state_json2: serde_json::Value =
        serde_json::from_str(&state_line2).expect("failed to parse state JSON");

    let m2 = metrics(13.0, scale2);
    let expected_cell_width2 = m2.cell_width as f64 / scale2 as f64;
    let expected_cell_height2 = m2.cell_height as f64 / scale2 as f64;

    let cell_width2 = state_json2["body"]["cellWidth"]
        .as_f64()
        .expect("cellWidth should be present");
    let cell_height2 = state_json2["body"]["cellHeight"]
        .as_f64()
        .expect("cellHeight should be present");

    assert!(
        (cell_width2 - expected_cell_width2).abs() < 0.1,
        "cellWidth at scale 1.0: expected {}, got {}",
        expected_cell_width2,
        cell_width2
    );
    assert!(
        (cell_height2 - expected_cell_height2).abs() < 0.1,
        "cellHeight at scale 1.0: expected {}, got {}",
        expected_cell_height2,
        cell_height2
    );

    drop(to_serve2);
    task2.await.unwrap().unwrap();
}

/// A zero-sized host raster is rejected and a later valid raster opens the session.
#[tokio::test]
async fn test_zero_sized_configuration_is_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-zero".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":0,"height":0,"scale":1.0}}}}
"#).await.unwrap();

    // Should receive error response
    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    assert_eq!(
        error_json["body"]["error"], "invalidParams",
        "expected invalidParams error"
    );
    assert_eq!(error_json["body"]["reason"], "invalid image configure");

    // Verify daemon was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.opens.len(),
        0,
        "daemon open should not be called for invalid params"
    );
    drop(calls_lock);

    // The original open request remains pending until a valid host raster arrives.
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":2,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for state")
        .expect("failed to read state line")
        .expect("state line is empty");

    let state_json: serde_json::Value =
        serde_json::from_str(&state_line).expect("failed to parse state JSON");

    assert_eq!(
        state_json["body"]["event"], "state",
        "valid open should produce state event"
    );

    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.opens.len(),
        1,
        "daemon open should be called for valid params"
    );

    drop(calls_lock);
    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// A zero-sized replacement raster is rejected.
#[tokio::test]
async fn test_replacement_raster_with_zero_size_is_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-zero".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open with normal size
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    // Read state response
    let _state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let _initial_image = next_image_envelope(&mut lines).await;

    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":2,"width":0,"height":0,"scale":1.0}}}}
"#).await.unwrap();

    // Read response - should be error
    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error response");

    assert_eq!(
        error_json["body"]["error"], "invalidParams",
        "zero raster should return invalidParams"
    );

    // Verify daemon resize was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.resizes.len(),
        0,
        "daemon resize should not be called for an invalid raster"
    );
    drop(calls_lock);

    // Send screen.read to verify task is still alive
    to_serve
        .write_all(
            br#"{"surface":"s1","body":{"operation":"screen.read"}}
"#,
        )
        .await
        .unwrap();

    let screen_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let screen_json: serde_json::Value =
        serde_json::from_str(&screen_line).expect("failed to parse screen response");

    assert_eq!(
        screen_json["body"]["event"], "screen",
        "task should still be alive and respond to screen.read"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: too small size (results in 0 cols/rows) is rejected
#[tokio::test]
async fn test_too_small_size_is_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-small".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // This raster is positive but too small to contain one terminal cell.
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":3,"height":3,"scale":1.0}}}}
"#).await.unwrap();

    // Should receive error response
    let error_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .expect("timeout waiting for error")
        .expect("failed to read error line")
        .expect("error line is empty");

    let error_json: serde_json::Value =
        serde_json::from_str(&error_line).expect("failed to parse error JSON");

    assert_eq!(
        error_json["body"]["error"], "invalidParams",
        "too small size should return invalidParams"
    );

    // Verify daemon was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(
        calls_lock.opens.len(),
        0,
        "daemon open should not be called"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: panicking engine reports error through surface event
#[tokio::test]
async fn test_panicking_surface_reports_error() {
    struct PanicEngine {
        cols: u16,
        rows: u16,
        panic_on_resize: bool,
    }

    impl PanicEngine {
        fn new() -> Self {
            Self {
                cols: 80,
                rows: 24,
                panic_on_resize: false,
            }
        }

        fn with_panic() -> Self {
            Self {
                cols: 80,
                rows: 24,
                panic_on_resize: true,
            }
        }
    }

    impl Engine for PanicEngine {
        fn set_theme(&mut self, _theme: soksak_sidecar_vt_core::TerminalTheme) {}

        fn resize(&mut self, cols: u16, rows: u16) {
            if self.panic_on_resize {
                panic!(
                    "test panic from engine: requested resize to {}x{}",
                    cols, rows
                );
            }
            self.cols = cols;
            self.rows = rows;
        }

        fn set_cell_metrics(&mut self, width: u16, height: u16) -> Result<(), String> {
            if width == 0 || height == 0 {
                return Err("terminal cell metrics must be positive".to_string());
            }
            Ok(())
        }

        fn feed(&mut self, _bytes: &[u8]) {}

        fn drain_events(&mut self) -> Vec<EngineEvent> {
            Vec::new()
        }

        fn resolve_clipboard(&mut self, request_id: u64, _text: &str) -> Result<(), String> {
            Err(format!("unknown clipboard request {request_id}"))
        }

        fn reject_clipboard(&mut self, request_id: u64, _reason: &str) -> Result<(), String> {
            Err(format!("unknown clipboard request {request_id}"))
        }

        fn selection_start(&mut self, _col: u16, _row: u16) -> Result<(), String> {
            Ok(())
        }
        fn selection_update(&mut self, _col: u16, _row: u16) -> Result<(), String> {
            Ok(())
        }
        fn selection_end(&mut self) -> Result<Option<String>, String> {
            Ok(Some("selected".to_string()))
        }
        fn selection_text(&self) -> Option<String> {
            Some("selected".to_string())
        }
        fn scroll_viewport(&mut self, _lines: i32) {}
        fn scroll_to_newest(&mut self) -> bool {
            false
        }

        fn cursor(&self) -> Cursor {
            Cursor {
                col: 0,
                row: 0,
                shape: CursorShape::Block,
                visible: true,
                blinking: false,
                blink_visible: true,
                focused: false,
                preedit: None,
            }
        }

        fn screen(&mut self) -> Screen {
            Screen {
                cols: self.cols,
                rows: self.rows,
                cursor: Cursor {
                    col: 0,
                    row: 0,
                    shape: CursorShape::Block,
                    visible: true,
                    blinking: false,
                    blink_visible: true,
                    focused: false,
                    preedit: None,
                },
                scrollback: Default::default(),
                lines: Vec::new(),
            }
        }

        fn modes(&self) -> Modes {
            Modes::default()
        }

        fn reset(&mut self) {}
    }

    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-panic".to_string();

    let panic_engine_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let panic_engine_flag_for_factory = panic_engine_flag.clone();

    let engine_factory = Arc::new(move || {
        if panic_engine_flag_for_factory.load(std::sync::atomic::Ordering::Relaxed) {
            Box::new(PanicEngine::with_panic()) as Box<dyn Engine>
        } else {
            Box::new(PanicEngine::new()) as Box<dyn Engine>
        }
    });

    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Enable panic in engine
    panic_engine_flag.store(true, std::sync::atomic::Ordering::Relaxed);

    // Send open - this should trigger panic in resize
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    // Wait for error event
    let mut found_error = false;
    for _ in 0..10 {
        match tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let json: serde_json::Value =
                    serde_json::from_str(&line).expect("failed to parse JSON");

                if let Some(event) = json.get("body").and_then(|b| b.get("event")) {
                    if event == "error" {
                        found_error = true;
                        if let Some(reason) = json.get("body").and_then(|b| b.get("reason")) {
                            assert!(
                                reason.as_str().unwrap().contains("surface task ended"),
                                "error reason should mention surface task ended"
                            );
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    assert!(
        found_error,
        "should receive error event when surface task panics"
    );

    drop(to_serve);
    let shutdown = task.await.unwrap();
    assert!(
        shutdown.is_err(),
        "surface shutdown failure must remain observable"
    );
}

/// 이미지 봉투가 나올 때까지 출력 줄을 읽는다. screen 이벤트 줄은 건너뛴다.
async fn next_image_envelope(
    lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::io::DuplexStream>>,
) -> serde_json::Value {
    for _ in 0..20 {
        let line = tokio::time::timeout(std::time::Duration::from_millis(500), lines.next_line())
            .await
            .expect("timeout waiting for an image envelope")
            .expect("failed to read an output line")
            .expect("output ended");
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            if json["body"]["image"].is_object() {
                return json;
            }
        }
    }
    panic!("no image envelope arrived");
}

// 호스트처럼 이미지 봉투에 consumed 로 답한다. 답하기 전까지 사이드카는 다음 raster 구성을 적용하지 않는다.
async fn acknowledge_image(to_serve: &mut tokio::io::DuplexStream, envelope: &serde_json::Value) {
    let image = &envelope["body"]["image"];
    let consumed = serde_json::json!({"surface": envelope["surface"], "body": {"image": {"consumed": {
        "name": image["name"], "generation": image["generation"],
        "raster": image["raster"], "sequence": image["sequence"]}}}});
    to_serve
        .write_all(format!("{consumed}\n").as_bytes())
        .await
        .unwrap();
}

// 지정한 raster 의 이미지 봉투를 기다린다. 커서 틱처럼 이전 raster 로 그린 이미지는 답하고 넘긴다.
async fn next_image_of_raster(
    lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::io::DuplexStream>>,
    to_serve: &mut tokio::io::DuplexStream,
    raster: u64,
) -> serde_json::Value {
    for _ in 0..20 {
        let envelope = next_image_envelope(lines).await;
        if envelope["body"]["image"]["raster"].as_u64() == Some(raster) {
            return envelope;
        }
        acknowledge_image(to_serve, &envelope).await;
    }
    panic!("no image envelope for raster {raster} arrived");
}

/// A replacement raster is not used until the prior transfer is acknowledged.
#[tokio::test]
async fn test_replacement_raster_waits_for_prior_transfer() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-image".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open with image at 800x384
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let image1 = next_image_envelope(&mut lines).await;
    let image1_obj = image1["body"]["image"]
        .as_object()
        .expect("first image envelope");
    assert_eq!(
        image1_obj["width"].as_u64(),
        Some(800),
        "first image width should be 800"
    );
    assert_eq!(
        image1_obj["height"].as_u64(),
        Some(384),
        "first image height should be 384"
    );

    // The host acknowledges the immutable snapshot before replacing its raster.
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":1}}}}
"#).await.unwrap();
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":2,"width":1600,"height":768,"scale":1.0}}}}
"#).await.unwrap();

    let image2 = next_image_of_raster(&mut lines, &mut to_serve, 2).await;
    let image2_obj = image2["body"]["image"]
        .as_object()
        .expect("image envelope after resize");
    assert_eq!(
        image2_obj["width"].as_u64(),
        Some(1600),
        "image width after resize should be 1600, got {}",
        image2_obj["width"]
    );
    assert_eq!(
        image2_obj["height"].as_u64(),
        Some(768),
        "image height after resize should be 768, got {}",
        image2_obj["height"]
    );
    assert_eq!(image2_obj["raster"].as_u64(), Some(2));
    assert_eq!(
        image2_obj["sequence"].as_u64(),
        Some(1),
        "a new raster starts a new sequence"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: after a release cycle, output while an image is outstanding does not present again
#[tokio::test]
async fn test_no_image_envelope_while_outstanding_after_release() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-outstanding".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    // First image
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"one\r\n".to_vec(),
        sequence: 0,
        truncated: false,
    });
    let first = next_image_envelope(&mut lines).await;
    assert_eq!(
        first["body"]["image"]["sequence"].as_u64(),
        Some(1),
        "first image envelope sequence"
    );

    // Release sequence 1
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":1}}}}
"#).await.unwrap();

    // Second image after the release (frame was free again)
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"two\r\n".to_vec(),
        sequence: 1,
        truncated: false,
    });
    let second = next_image_envelope(&mut lines).await;
    assert_eq!(
        second["body"]["image"]["sequence"].as_u64(),
        Some(2),
        "second image envelope sequence"
    );

    // Output while sequence 2 is outstanding must not present again before its release
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"three\r\n".to_vec(),
        sequence: 2,
        truncated: false,
    });

    let result =
        tokio::time::timeout(std::time::Duration::from_millis(300), lines.next_line()).await;
    if let Ok(Ok(Some(line))) = result {
        let json: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert!(
            json["body"]["image"].is_null(),
            "must not present an image while the previous one is outstanding, got: {}",
            line
        );
    }

    // Releasing sequence 2 presents the content that arrived meanwhile
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":2}}}}
"#).await.unwrap();

    let mut caught_up = false;
    for _ in 0..20 {
        if let Ok(Ok(Some(line))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await
        {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json["body"]["image"]["sequence"].as_u64() == Some(3) {
                    caught_up = true;
                    break;
                }
            }
        }
    }
    assert!(
        caught_up,
        "release of sequence 2 should present the caught-up image"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: an error response re-enables drawing on the next output
#[tokio::test]
async fn test_image_error_response_reenables_drawing() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-image-error".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"one\r\n".to_vec(),
        sequence: 0,
        truncated: false,
    });
    let first = next_image_envelope(&mut lines).await;
    assert_eq!(
        first["body"]["image"]["sequence"].as_u64(),
        Some(1),
        "first image envelope sequence"
    );

    // Host rejects the image
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"error":"scale","name":"view","generation":1,"raster":1,"sequence":1}}}
"#).await.unwrap();

    // The next output must draw again
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"two\r\n".to_vec(),
        sequence: 1,
        truncated: false,
    });

    let mut drew_again = false;
    for _ in 0..20 {
        if let Ok(Ok(Some(line))) =
            tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await
        {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json["body"]["image"]["sequence"].as_u64() == Some(2) {
                    drew_again = true;
                    break;
                }
            }
        }
    }
    assert!(
        drew_again,
        "output after an image error must present a new image envelope"
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// The state event after a replacement raster carries the full session fields.
#[tokio::test]
async fn test_replacement_raster_state_has_cell_dimensions() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-state".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(
        session_id_for_factory.clone(),
        calls_for_factory.clone(),
    ));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();

    let _open_state = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let _initial_image = next_image_envelope(&mut lines).await;
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"consumed":{"name":"view","generation":1,"raster":1,"sequence":1}}}}
"#).await.unwrap();

    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":2,"width":1600,"height":768,"scale":1.0}}}}
"#).await.unwrap();

    // resize 의 state 이벤트까지 읽는다. 커서 틱이 만든 이미지가 먼저 올 수 있으며, 호스트처럼 각 이미지에
    // consumed 로 답해야 대기 중인 raster 2 구성이 적용된다.
    let mut state_json: Option<serde_json::Value> = None;
    for _ in 0..10 {
        let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
            .await
            .expect("timeout waiting for resize response")
            .unwrap()
            .unwrap();

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            if json["body"]["event"].as_str() == Some("state") {
                state_json = Some(json);
                break;
            }
            if json["body"]["image"].is_object() {
                acknowledge_image(&mut to_serve, &json).await;
            }
        }
    }

    let state = state_json.expect("resize should answer with a state event");
    assert!(
        state["body"]["sessionId"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "resize state event should carry sessionId"
    );
    let cell_width = state["body"]["cellWidth"]
        .as_f64()
        .expect("resize state event should carry cellWidth");
    let cell_height = state["body"]["cellHeight"]
        .as_f64()
        .expect("resize state event should carry cellHeight");
    assert!(
        cell_width > 0.0,
        "cellWidth should be positive, got {}",
        cell_width
    );
    assert!(
        cell_height > 0.0,
        "cellHeight should be positive, got {}",
        cell_height
    );

    drop(to_serve);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_font_applies_the_first_installed_family_of_a_list() {
    let input = r#"
{"surface":"s1","body":{"operation":"font","family":"No Such Terminal Font Family;Menlo","size":13}}
{"surface":"s1","body":{"operation":"font","family":"Courier","size":13}}
{"surface":"s1","body":{"operation":"font","family":"No Such Terminal Font Family","size":13}}
{"surface":"s1","body":{"operation":"font","family":" ; ","size":13}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> =
        Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
    let session_port_for_factory = session_port.clone();
    let factory = Arc::new(move || session_port_for_factory.clone());

    serve(engine_factory, reader, &mut writer, factory)
        .await
        .expect("font contract");
    let outputs = String::from_utf8(writer)
        .expect("utf8 output")
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let applied = outputs
        .iter()
        .filter(|value| value["body"]["event"] == "font")
        .map(|value| value["body"]["family"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(applied.len(), 3);
    assert_eq!(applied[..2], ["Menlo".to_string(), "Courier".to_string()]);
    let system = outputs
        .iter()
        .filter(|value| value["body"]["event"] == "font")
        .map(|value| value["body"]["system"].as_bool().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        system,
        vec![false, false, true],
        "only a list without installed families uses the system font"
    );
    let skipped = outputs
        .iter()
        .filter(|value| value["body"]["event"] == "font")
        .map(|value| value["body"]["skipped"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        skipped,
        vec![
            serde_json::json!(["No Such Terminal Font Family"]),
            serde_json::json!([]),
            serde_json::json!(["No Such Terminal Font Family"]),
        ],
        "each answer names the families it skipped"
    );
    let errors = outputs
        .iter()
        .filter(|value| value["body"]["error"] == "invalidParams")
        .map(|value| value["body"]["reason"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        errors,
        vec!["font.family must name at least one family".to_string()]
    );
}

/// state 이벤트나 오류 응답이 올 때까지 줄을 읽는다.
async fn next_state(
    lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::io::DuplexStream>>,
    expect: &str,
) -> serde_json::Value {
    loop {
        let line = tokio::time::timeout(std::time::Duration::from_secs(2), lines.next_line())
            .await
            .expect(expect)
            .unwrap()
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&line).unwrap();
        if json["body"]["event"] == "state" || json["body"]["error"].is_string() {
            return json;
        }
    }
}

/// 글꼴 크기는 칸 크기를 정한다(docs/spec/text-size.md). 크기가 두 배면 칸 높이도 두 배이고, 잘못된 크기는 오류다.
#[tokio::test]
async fn test_font_size_sets_the_cell_size() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let port = Arc::new(FakeSessionPort::new(
        "test-session-font-size".to_string(),
        calls.clone(),
    ));
    let factory = Arc::new(move || port.clone() as Arc<dyn SessionPort>);
    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"operation":"open","shell":"/bin/sh","image":"view"}}
{"surface":"s1","body":{"image":{"configure":{"name":"view","generation":1,"raster":1,"width":800,"height":384,"scale":1.0}}}}
"#).await.unwrap();
    let initial = next_state(&mut lines, "the open state").await;
    let base = initial["body"]["cellHeight"].as_f64().unwrap();
    to_serve
        .write_all(
            br#"{"surface":"s1","body":{"operation":"font","family":"Menlo","size":26}}
"#,
        )
        .await
        .unwrap();
    let larger = next_state(&mut lines, "the state after a font size change").await;
    let height = larger["body"]["cellHeight"].as_f64().unwrap();
    assert!(
        (height / base - 2.0).abs() < 0.1,
        "a font twice as large doubles the cell height: {base} -> {height}"
    );
    to_serve
        .write_all(
            br#"{"surface":"s1","body":{"operation":"font","family":"Menlo","size":0}}
{"surface":"s1","body":{"operation":"font","family":"Menlo"}}
"#,
        )
        .await
        .unwrap();
    let invalid = next_state(&mut lines, "the invalid size error").await;
    assert_eq!(invalid["body"]["error"], "invalidParams");
    assert!(
        invalid["body"]["reason"]
            .as_str()
            .unwrap()
            .contains("font.size"),
        "{invalid}"
    );
    let missing = next_state(&mut lines, "the missing size error").await;
    assert!(
        missing["body"]["reason"]
            .as_str()
            .unwrap()
            .contains("font.size"),
        "{missing}"
    );
    drop(to_serve);
    let _ = task.await;
}
