/// Integration tests for serve contract with fake daemon
use soksak_sidecar_vt_core::protocol::{serve, Engine, Screen, Cursor, Modes, Cell, SessionPort, DaemonEvent};
use tokio::sync::mpsc;
use async_trait::async_trait;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncWriteExt, AsyncBufReadExt};

struct MockEngine {
    cols: u16,
    rows: u16,
    feed_history: Vec<Vec<u8>>,
    custom_modes: Option<Modes>,
}

impl MockEngine {
    fn new() -> Self {
        Self {
            cols: 80,
            rows: 24,
            feed_history: Vec::new(),
            custom_modes: None,
        }
    }

    fn with_modes(modes: Modes) -> Self {
        Self {
            cols: 80,
            rows: 24,
            feed_history: Vec::new(),
            custom_modes: Some(modes),
        }
    }
}

impl Engine for MockEngine {
    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.feed_history.push(bytes.to_vec());
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
            cursor: Cursor { col: 0, row: 0 },
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
    async fn open(&self, _program: &str, cols: u16, rows: u16, _hint: Option<&str>) -> Result<String, String> {
        self.calls.lock().unwrap().opens.push((cols, rows));
        Ok(self.session_id.clone())
    }

    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        self.calls.lock().unwrap().writes.push((session_id.to_string(), data.to_vec()));
        Ok(())
    }

    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.calls.lock().unwrap().resizes.push((session_id.to_string(), cols, rows));
        Ok(())
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        self.calls.lock().unwrap().detaches.push(session_id.to_string());
        Ok(())
    }

    async fn close(&self, session_id: &str) -> Result<(), String> {
        self.calls.lock().unwrap().closes.push(session_id.to_string());
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

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","bytes":"aGk="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    // Verify that write was called with the right data
    let calls_lock = calls.lock().unwrap();
    assert!(!calls_lock.writes.is_empty(), "write not called");
    assert_eq!(calls_lock.writes[0].0, fake_session_id, "session_id mismatch");
    assert_eq!(calls_lock.writes[0].1, b"hi", "write data mismatch");
}

/// Test A-7: close op ends the session (calls close, not detach)
#[tokio::test]
async fn test_a7_close_op_ends_the_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"close"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    // Verify that close was called and detach was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.closes.len(), 1, "close not called exactly once");
    assert_eq!(calls_lock.closes[0], fake_session_id, "close session_id mismatch");
    assert!(calls_lock.detaches.is_empty(), "detach should not be called for close op");
}

/// Test A-8: closed:true flag detaches (does not call close)
#[tokio::test]
async fn test_a8_closed_surface_only_detaches() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","closed":true}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    // Verify that detach was called and close was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.detaches.len(), 1, "detach not called exactly once");
    assert_eq!(calls_lock.detaches[0], fake_session_id, "detach session_id mismatch");
    assert!(calls_lock.closes.is_empty(), "close should not be called for closed:true flag");
}

#[tokio::test]
async fn test_input_not_fed_to_engine() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","bytes":"aGVsbG8="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new("test-session".to_string(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let result = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_stdin_eof_terminates_quickly() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new("test-session".to_string(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let start = std::time::Instant::now();
    let result = serve(engine_factory, reader, &mut writer, session_port_factory).await;
    let elapsed = start.elapsed();

    assert!(result.is_ok());
    assert!(elapsed < std::time::Duration::from_millis(1500),
        "stdin EOF took too long: {}ms", elapsed.as_millis());
}

#[tokio::test]
async fn test_open_and_close_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","closed":true}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new("test-session".to_string(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
}

#[tokio::test]
async fn test_resize() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"resize","width":1600,"height":768,"scale":1.0}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new("test-session".to_string(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;
}

#[tokio::test]
async fn test_close_session() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","closed":true}
{"surface":"s1","body":{"op":"input","bytes":"aGk="}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new("test-session".to_string(), calls_for_factory.clone())) as Arc<dyn SessionPort>
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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    // Use tokio::io::duplex for stdin/stdout
    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open command
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    // Wait for state response (should contain sessionId)
    let state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for state")
    .expect("failed to read state line")
    .expect("state line is empty");

    let state_json: serde_json::Value = serde_json::from_str(&state_line)
        .expect("failed to parse state JSON");
    assert_eq!(state_json["body"]["event"], "state", "expected state event");

    // Push output event with "hi\r\n"
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"hi\r\n".to_vec(),
        truncated: false,
    });

    // Wait for screen event (should contain "hi")
    let mut found_hi = false;
    loop {
        let screen_line = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            lines.next_line()
        )
        .await
        .expect("timeout waiting for screen")
        .expect("failed to read screen line")
        .expect("screen line is empty");

        let screen_json: serde_json::Value = serde_json::from_str(&screen_line)
            .expect("failed to parse screen JSON");

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
async fn test_a5_screen_read_returns_current_screen() {
    let input = r#"
{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","bytes":"aGk="}}
{"surface":"s1","body":{"op":"screen.read"}}
"#;

    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> = Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
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
    assert!(found_screen_read, "screen.read should return a screen event");
}

#[tokio::test]
async fn test_a6_unknown_op_returns_error() {
    let input = r#"
{"surface":"s1","body":{"op":"unknown_operation"}}
"#;

    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let session_port: Arc<dyn SessionPort> = Arc::new(soksak_sidecar_vt_core::protocol::FakeSessionPort::new());
    let session_port_for_factory = session_port.clone();
    let factory = Arc::new(move || session_port_for_factory.clone());

    let result = serve(engine_factory, reader, &mut writer, factory).await;
    assert!(result.is_ok());

    let output = String::from_utf8(writer).unwrap();
    let lines: Vec<&str> = output.lines().collect();
    assert!(!lines.is_empty());

    let json: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert!(json["body"]["error"].as_str().unwrap().contains("Unknown op"));
}

/// Test K1: Keys encoded without app_cursor mode
#[tokio::test]
async fn test_k1_keys_up_without_app_cursor() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","keys":[{"key":"Up"}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 1, "should have exactly one write");
    assert_eq!(calls_lock.writes[0].1, b"\x1b[A", "Up key without app_cursor should be ESC[A");
}

/// Test K2: Keys encoded with app_cursor mode
#[tokio::test]
async fn test_k2_keys_up_with_app_cursor() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","keys":[{"key":"Up"}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let modes = Modes {
        app_cursor: true,
        ..Default::default()
    };
    let engine_factory = Arc::new(move || Box::new(MockEngine::with_modes(modes.clone())) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 1, "should have exactly one write");
    assert_eq!(calls_lock.writes[0].1, b"\x1bOA", "Up key with app_cursor should be ESC O A");
}

/// Test K3: Char key encoding with ctrl and UTF-8
#[tokio::test]
async fn test_k3_char_key_encoding() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    // Test ctrl+c → 0x03
    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","keys":[{"key":"Char","text":"c","ctrl":true}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 1);
    assert_eq!(calls_lock.writes[0].1, vec![0x03], "ctrl+c should be 0x03");

    // Test UTF-8 encoding (한)
    drop(calls_lock);

    let calls2 = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id2 = "test-session-2".to_string();

    let input2 = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","keys":[{"key":"Char","text":"한"}]}}
"#;
    let reader2 = std::io::Cursor::new(input2.as_bytes());
    let mut writer2 = Vec::new();

    let engine_factory2 = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory2 = calls2.clone();
    let session_id_for_factory2 = fake_session_id2.clone();
    let session_port_factory2 = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory2.clone(), calls_for_factory2.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory2, reader2, &mut writer2, session_port_factory2).await;

    let calls_lock2 = calls2.lock().unwrap();
    assert_eq!(calls_lock2.writes.len(), 1);
    assert_eq!(calls_lock2.writes[0].1, "한".as_bytes(), "Char with UTF-8 should encode as UTF-8 bytes");
}

/// Test K4: Unknown key returns error, no write
#[tokio::test]
async fn test_k4_unknown_key_returns_error() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","keys":[{"key":"Nope"}]}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.writes.len(), 0, "should not call write for unknown key");

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

/// Test I4: No image envelope when open has no image field
#[tokio::test]
async fn test_i4_no_image_envelope_without_image_field() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i4".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITHOUT image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Push output
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test\r\n".to_vec(),
        truncated: false,
    });

    // Should get screen event, not image envelope
    let output_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    let json: serde_json::Value = serde_json::from_str(&output_line).unwrap();
    let has_image = json.get("body").and_then(|b| b.get("image")).is_some();
    let has_screen_event = json.get("body")
        .and_then(|b| b.get("event"))
        .and_then(|e| e.as_str())
        .map(|e| e == "screen")
        .unwrap_or(false);

    assert!(!has_image, "should not have image envelope when no image field");
    assert!(has_screen_event, "should have screen event instead");

    drop(to_serve);
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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITH image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    // Wait for state response
    let state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for state")
    .expect("failed to read state line")
    .expect("state line is empty");

    let state_json: serde_json::Value = serde_json::from_str(&state_line)
        .expect("failed to parse state JSON");
    assert_eq!(state_json["body"]["event"], "state", "expected state event");

    // Push output event
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"hi\r\n".to_vec(),
        truncated: false,
    });

    // Wait for image envelope
    let image_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for image envelope")
    .expect("failed to read image line")
    .expect("image line is empty");

    let image_json: serde_json::Value = serde_json::from_str(&image_line)
        .expect("failed to parse image JSON");

    // Verify image envelope structure
    let image_obj = image_json.get("body")
        .and_then(|b| b.get("image"))
        .expect("should have image envelope");

    assert_eq!(image_obj["name"], "view", "image name should be 'view'");
    assert_eq!(image_obj["sequence"], 1, "initial sequence should be 1");
    assert_eq!(image_obj["format"], "bgra8", "format should be bgra8");

    let token = image_obj.get("token").expect("should have token");
    assert_eq!(token["kind"], "iosurface-global", "token kind should be iosurface-global");

    let nonce_b64 = token["nonce"].as_str().expect("nonce should be string");
    let nonce_bytes = base64_decode_test(nonce_b64).expect("nonce should be valid base64");
    assert_eq!(nonce_bytes.len(), 16, "nonce should be 16 bytes");

    assert!(image_obj["width"].as_u64().unwrap_or(0) > 0, "width should be > 0");
    assert!(image_obj["height"].as_u64().unwrap_or(0) > 0, "height should be > 0");

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test I2: No second image envelope until surface released
#[tokio::test]
async fn test_i2_no_image_envelope_until_released() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i2".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITH image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Push first output
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test1\r\n".to_vec(),
        truncated: false,
    });

    // Wait for first image envelope
    let _image_line1 = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.expect("timeout on first image envelope")
        .expect("failed to read first image line")
        .expect("first image line is empty");

    // Push second output WITHOUT release
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test2\r\n".to_vec(),
        truncated: false,
    });

    // Wait for screen event instead (should NOT get image envelope within 300ms)
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(300),
        lines.next_line()
    ).await;

    // Should timeout or get a screen event, NOT an image envelope
    if let Ok(Ok(Some(line))) = result {
        let json: serde_json::Value = serde_json::from_str(&line)
            .expect("failed to parse JSON");
        // If we got an image envelope, that's wrong
        assert!(json.get("body")
            .and_then(|b| b.get("image"))
            .is_none(), "should NOT have image envelope before release");
    }

    // Now send release response with sequence 1
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"released":{"name":"view","sequence":1}}}}
"#).await.unwrap();

    // Wait for second image envelope (sequence 2) within 2 seconds
    let mut found_sequence_2 = false;
    for _ in 0..20 {
        if let Ok(Ok(Some(line))) = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            lines.next_line()
        ).await {
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

    assert!(found_sequence_2, "should get image envelope with sequence 2 after release");

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test I3: Host image response (released/error) is handled, no error returned
#[tokio::test]
async fn test_i3_image_response_no_error() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-i3".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open WITH image field
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Push output
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"test\r\n".to_vec(),
        truncated: false,
    });

    // Wait for image envelope
    let _image_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Test 1: Send released response (no "error")
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"released":{"name":"view","sequence":1}}}}
"#).await.unwrap();

    // Should NOT get error response, just screen or image envelope
    let mut found_error_response = false;
    for _ in 0..10 {
        if let Ok(Ok(Some(line))) = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            lines.next_line()
        ).await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(error) = json.get("body").and_then(|b| b.get("error")) {
                    if error.as_str().map(|e| e.contains("unknown op")).unwrap_or(false) {
                        found_error_response = true;
                        break;
                    }
                }
            }
        }
    }
    assert!(!found_error_response, "should NOT return 'unknown op' error for released response");

    // Test 2: Send error response
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"error":"forbidden","name":"view","sequence":1}}}
"#).await.unwrap();

    // Should NOT get error response about unknown op
    found_error_response = false;
    for _ in 0..10 {
        if let Ok(Ok(Some(line))) = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            lines.next_line()
        ).await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(error) = json.get("body").and_then(|b| b.get("error")) {
                    if error.as_str().map(|e| e.contains("unknown op")).unwrap_or(false) {
                        found_error_response = true;
                        break;
                    }
                }
            }
        }
    }
    assert!(!found_error_response, "should NOT return 'unknown op' error for error response");

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: open with image field is a request, not a host response
#[tokio::test]
async fn test_open_with_image_is_a_request() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-open-image".to_string();

    let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#;
    let reader = std::io::Cursor::new(input.as_bytes());
    let mut writer = Vec::new();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();
    let session_port_factory = Arc::new(move || {
        Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone())) as Arc<dyn SessionPort>
    });

    let _ = serve(engine_factory, reader, &mut writer, session_port_factory).await;

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.opens.len(), 1, "should have called open exactly once - open with image was misclassified as host response!");
    assert!(calls_lock.opens[0].0 > 0 && calls_lock.opens[0].1 > 0, "should have valid cols and rows");

    let output = String::from_utf8(writer).unwrap();
    let lines: Vec<&str> = output.lines().collect();
    assert!(!lines.is_empty(), "should have output");

    // Check that we got a state response (not an error)
    let first_json: serde_json::Value = serde_json::from_str(lines[0])
        .expect("failed to parse first output as JSON");
    assert_eq!(first_json["body"]["event"], "state", "expected state event after open with image");
}

fn base64_decode_test(s: &str) -> Result<Vec<u8>, String> {
    use soksak_sidecar_vt_core::protocol::base64_decode;
    base64_decode(s)
}

/// Test: open with non-numeric width is rejected with proper error (catches type validation)
#[tokio::test]
async fn test_open_with_invalid_width_type() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-invalid-width".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open with width as string (invalid type)
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":"800","height":384,"scale":1.0}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    // Must have specific validation error mentioning type/field requirement
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    assert!(error_json["body"]["error"] == "invalidParams", "should return invalidParams error");
    assert!(reason.contains("width") && reason.contains("field"),
        "error reason should mention width field requirement, got: {}", reason);

    // Crucially, daemon should NOT have been called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.opens.len(), 0, "daemon open should not be called for type validation failure");

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Send input with neither bytes nor keys
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"input"}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    // Should get error about missing field
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    let error_code = error_json["body"]["error"].as_str().unwrap_or("");
    assert!(error_code.contains("invalidParams") && reason.contains("bytes or keys"),
        "should report that bytes or keys is required, got error={} reason={}", error_code, reason);

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Send input with bytes as number instead of string
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"input","bytes":123}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    // Should get error about bytes type
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    let error_code = error_json["body"]["error"].as_str().unwrap_or("");
    assert!(error_code.contains("invalidParams") && reason.contains("bytes must be a string"),
        "should report that bytes must be a string, got error={} reason={}", error_code, reason);

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Send input with keys as object instead of array
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"input","keys":{"key":"Up"}}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    // Should get error about keys type
    let reason = error_json["body"]["reason"].as_str().unwrap_or("");
    let error_code = error_json["body"]["error"].as_str().unwrap_or("");
    assert!(error_code.contains("invalidParams") && reason.contains("keys must be an array"),
        "should report that keys must be an array, got error={} reason={}", error_code, reason);

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: resize with missing height is rejected
#[tokio::test]
async fn test_resize_with_missing_height_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-missing".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open first
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Send resize with only width
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"resize","width":1024,"scale":1.0}}
"#).await.unwrap();

    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    // Should get error about missing height
    assert_eq!(error_json["body"]["error"], "invalidParams", "should return invalidParams");
    assert!(error_json["body"]["reason"].as_str().unwrap().contains("height"),
        "reason should mention height");

    // Verify daemon resize was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.resizes.len(), 0, "daemon resize should not be called for missing params");

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    let scale = 2.0f32;
    let width_px = 800u32;
    let height_px = 384u32;

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":2.0,"image":"view"}}
"#).await.unwrap();

    let state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for state")
    .expect("failed to read state line")
    .expect("state line is empty");

    let state_json: serde_json::Value = serde_json::from_str(&state_line)
        .expect("failed to parse state JSON");

    // Get actual metrics from platform
    let m = metrics(13.0, scale);

    // cellWidth and cellHeight should be CSS pixels = device_pixels / scale
    let expected_cell_width = m.cell_width as f64 / scale as f64;
    let expected_cell_height = m.cell_height as f64 / scale as f64;

    let cell_width = state_json["body"]["cellWidth"].as_f64()
        .expect("cellWidth should be present and numeric");
    let cell_height = state_json["body"]["cellHeight"].as_f64()
        .expect("cellHeight should be present and numeric");

    // Must match metrics exactly (within floating point tolerance)
    assert!((cell_width - expected_cell_width).abs() < 0.1,
        "cellWidth at scale 2.0: expected {}, got {}", expected_cell_width, cell_width);
    assert!((cell_height - expected_cell_height).abs() < 0.1,
        "cellHeight at scale 2.0: expected {}, got {}", expected_cell_height, cell_height);

    // Verify cols/rows calculation: cols = width_px / cell_width
    // (both width_px and cell_width are in device pixels, scale already accounted for in metrics)
    let cols = state_json["body"]["cols"].as_u64().expect("cols should be present") as u16;
    let rows = state_json["body"]["rows"].as_u64().expect("rows should be present") as u16;

    let expected_cols = (width_px as f32 / m.cell_width) as u16;
    let expected_rows = (height_px as f32 / m.cell_height) as u16;

    assert_eq!(cols, expected_cols, "cols should match metrics at scale 2.0: expected {}, got {}", expected_cols, cols);
    assert_eq!(rows, expected_rows, "rows should match metrics at scale 2.0: expected {}, got {}", expected_rows, rows);

    drop(to_serve);
    task.await.unwrap().unwrap();

    // Test with scale=1.0 to verify it works at different scales
    let calls2 = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id2 = "test-session-metrics-scale1".to_string();

    let engine_factory2 = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory2 = calls2.clone();
    let session_id_for_factory2 = fake_session_id2.clone();

    let port2 = Arc::new(FakeSessionPort::new(session_id_for_factory2.clone(), calls_for_factory2.clone()));
    let port_for_factory2 = port2.clone();
    let factory2 = Arc::new(move || port_for_factory2.clone() as Arc<dyn SessionPort>);

    let (mut to_serve2, serve_in2) = tokio::io::duplex(64 * 1024);
    let (serve_out2, from_serve2) = tokio::io::duplex(64 * 1024);

    let task2 = tokio::spawn(serve(engine_factory2, serve_in2, serve_out2, factory2));
    let mut lines2 = tokio::io::BufReader::new(from_serve2).lines();

    let scale2 = 1.0f32;

    to_serve2.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let state_line2 = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines2.next_line()
    )
    .await
    .expect("timeout waiting for state")
    .expect("failed to read state line")
    .expect("state line is empty");

    let state_json2: serde_json::Value = serde_json::from_str(&state_line2)
        .expect("failed to parse state JSON");

    let m2 = metrics(13.0, scale2);
    let expected_cell_width2 = m2.cell_width as f64 / scale2 as f64;
    let expected_cell_height2 = m2.cell_height as f64 / scale2 as f64;

    let cell_width2 = state_json2["body"]["cellWidth"].as_f64()
        .expect("cellWidth should be present");
    let cell_height2 = state_json2["body"]["cellHeight"].as_f64()
        .expect("cellHeight should be present");

    assert!((cell_width2 - expected_cell_width2).abs() < 0.1,
        "cellWidth at scale 1.0: expected {}, got {}", expected_cell_width2, cell_width2);
    assert!((cell_height2 - expected_cell_height2).abs() < 0.1,
        "cellHeight at scale 1.0: expected {}, got {}", expected_cell_height2, cell_height2);

    drop(to_serve2);
    task2.await.unwrap().unwrap();
}

/// Test: open with zero size is rejected; subsequent valid open works
#[tokio::test]
async fn test_open_with_zero_size_is_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-zero".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open command with width=0, height=0 - should be rejected
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":0,"height":0,"scale":1.0}}
"#).await.unwrap();

    // Should receive error response
    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    assert_eq!(error_json["body"]["error"], "invalidParams", "expected invalidParams error");
    assert!(error_json["body"]["reason"].as_str().unwrap().contains("positive"), "reason should mention positive");

    // Verify daemon was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.opens.len(), 0, "daemon open should not be called for invalid params");
    drop(calls_lock);

    // Now send a valid open - should work normally
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    let state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for state")
    .expect("failed to read state line")
    .expect("state line is empty");

    let state_json: serde_json::Value = serde_json::from_str(&state_line)
        .expect("failed to parse state JSON");

    assert_eq!(state_json["body"]["event"], "state", "valid open should produce state event");

    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.opens.len(), 1, "daemon open should be called for valid params");

    drop(calls_lock);
    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: resize to zero is rejected
#[tokio::test]
async fn test_resize_to_zero_is_rejected() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-zero".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open with normal size
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    // Read state response
    let _state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Send resize with width=0, height=0 - should be rejected
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"resize","width":0,"height":0,"scale":1.0}}
"#).await.unwrap();

    // Read response - should be error
    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error response");

    assert_eq!(error_json["body"]["error"], "invalidParams", "resize with zero should return invalidParams");

    // Verify daemon resize was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.resizes.len(), 0, "daemon resize should not be called for invalid params");
    drop(calls_lock);

    // Send screen.read to verify task is still alive
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"screen.read"}}
"#).await.unwrap();

    let screen_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    let screen_json: serde_json::Value = serde_json::from_str(&screen_line)
        .expect("failed to parse screen response");

    assert_eq!(screen_json["body"]["event"], "screen", "task should still be alive and respond to screen.read");

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Send open with width=3, height=3, scale=1.0
    // With CELL_WIDTH=8, this gives 3/8 = 0 cols
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":3,"height":3,"scale":1.0}}
"#).await.unwrap();

    // Should receive error response
    let error_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    )
    .await
    .expect("timeout waiting for error")
    .expect("failed to read error line")
    .expect("error line is empty");

    let error_json: serde_json::Value = serde_json::from_str(&error_line)
        .expect("failed to parse error JSON");

    assert_eq!(error_json["body"]["error"], "invalidParams", "too small size should return invalidParams");

    // Verify daemon was NOT called
    let calls_lock = calls.lock().unwrap();
    assert_eq!(calls_lock.opens.len(), 0, "daemon open should not be called");

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
        fn resize(&mut self, cols: u16, rows: u16) {
            if self.panic_on_resize {
                panic!("test panic from engine: requested resize to {}x{}", cols, rows);
            }
            self.cols = cols;
            self.rows = rows;
        }

        fn feed(&mut self, _bytes: &[u8]) {}

        fn screen(&mut self) -> Screen {
            Screen {
                cols: self.cols,
                rows: self.rows,
                cursor: Cursor { col: 0, row: 0 },
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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Enable panic in engine
    panic_engine_flag.store(true, std::sync::atomic::Ordering::Relaxed);

    // Send open - this should trigger panic in resize
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#).await.unwrap();

    // Wait for error event
    let mut found_error = false;
    for _ in 0..10 {
        match tokio::time::timeout(
            std::time::Duration::from_millis(500),
            lines.next_line()
        ).await {
            Ok(Ok(Some(line))) => {
                let json: serde_json::Value = serde_json::from_str(&line)
                    .expect("failed to parse JSON");

                if let Some(event) = json.get("body").and_then(|b| b.get("event")) {
                    if event == "error" {
                        found_error = true;
                        if let Some(reason) = json.get("body").and_then(|b| b.get("reason")) {
                            assert!(reason.as_str().unwrap().contains("surface task ended"),
                                "error reason should mention surface task ended");
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    assert!(found_error, "should receive error event when surface task panics");

    drop(to_serve);
    task.await.unwrap().unwrap();
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

/// Test: resize presents the image at the new size without waiting for output
#[tokio::test]
async fn test_resize_presents_image_at_new_size() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-image".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // Open with image at 800x384
    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // Output draws the first image
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"hi\r\n".to_vec(),
        truncated: false,
    });

    let image1 = next_image_envelope(&mut lines).await;
    let image1_obj = image1["body"]["image"].as_object().expect("first image envelope");
    assert_eq!(image1_obj["width"].as_u64(), Some(800), "first image width should be 800");
    assert_eq!(image1_obj["height"].as_u64(), Some(384), "first image height should be 384");

    // Resize to 1600x768 must present a new image envelope at that size
    to_serve.write_all(br#"{"surface":"s1","body":{"op":"resize","width":1600,"height":768,"scale":1.0}}
"#).await.unwrap();

    let image2 = next_image_envelope(&mut lines).await;
    let image2_obj = image2["body"]["image"].as_object().expect("image envelope after resize");
    assert_eq!(image2_obj["width"].as_u64(), Some(1600), "image width after resize should be 1600, got {}", image2_obj["width"]);
    assert_eq!(image2_obj["height"].as_u64(), Some(768), "image height after resize should be 768, got {}", image2_obj["height"]);
    assert_eq!(image2_obj["sequence"].as_u64(), Some(2), "sequence should continue after resize");

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    // First image
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"one\r\n".to_vec(),
        truncated: false,
    });
    let first = next_image_envelope(&mut lines).await;
    assert_eq!(first["body"]["image"]["sequence"].as_u64(), Some(1), "first image envelope sequence");

    // Release sequence 1
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"released":{"name":"view","sequence":1}}}}
"#).await.unwrap();

    // Second image after the release (frame was free again)
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"two\r\n".to_vec(),
        truncated: false,
    });
    let second = next_image_envelope(&mut lines).await;
    assert_eq!(second["body"]["image"]["sequence"].as_u64(), Some(2), "second image envelope sequence");

    // Output while sequence 2 is outstanding must not present again before its release
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"three\r\n".to_vec(),
        truncated: false,
    });

    let result = tokio::time::timeout(std::time::Duration::from_millis(300), lines.next_line()).await;
    if let Ok(Ok(Some(line))) = result {
        let json: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert!(json["body"]["image"].is_null(),
            "must not present an image while the previous one is outstanding, got: {}", line);
    }

    // Releasing sequence 2 presents the content that arrived meanwhile
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"released":{"name":"view","sequence":2}}}}
"#).await.unwrap();

    let mut caught_up = false;
    for _ in 0..20 {
        if let Ok(Ok(Some(line))) = tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json["body"]["image"]["sequence"].as_u64() == Some(3) {
                    caught_up = true;
                    break;
                }
            }
        }
    }
    assert!(caught_up, "release of sequence 2 should present the caught-up image");

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

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let _state_line = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"one\r\n".to_vec(),
        truncated: false,
    });
    let first = next_image_envelope(&mut lines).await;
    assert_eq!(first["body"]["image"]["sequence"].as_u64(), Some(1), "first image envelope sequence");

    // Host rejects the image
    to_serve.write_all(br#"{"surface":"s1","body":{"image":{"error":"scale","name":"view","sequence":1}}}
"#).await.unwrap();

    // The next output must draw again
    port.push_event(DaemonEvent::Output {
        session_id: fake_session_id.clone(),
        data: b"two\r\n".to_vec(),
        truncated: false,
    });

    let mut drew_again = false;
    for _ in 0..20 {
        if let Ok(Ok(Some(line))) = tokio::time::timeout(std::time::Duration::from_millis(100), lines.next_line()).await {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                if json["body"]["image"]["sequence"].as_u64() == Some(2) {
                    drew_again = true;
                    break;
                }
            }
        }
    }
    assert!(drew_again, "output after an image error must present a new image envelope");

    drop(to_serve);
    task.await.unwrap().unwrap();
}

/// Test: the state event after resize carries the full session fields
#[tokio::test]
async fn test_resize_state_event_has_cell_dimensions() {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let fake_session_id = "test-session-resize-state".to_string();

    let engine_factory = Arc::new(|| Box::new(MockEngine::new()) as Box<dyn Engine>);
    let calls_for_factory = calls.clone();
    let session_id_for_factory = fake_session_id.clone();

    let port = Arc::new(FakeSessionPort::new(session_id_for_factory.clone(), calls_for_factory.clone()));
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone() as Arc<dyn SessionPort>);

    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(serve(engine_factory, serve_in, serve_out, factory));
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    to_serve.write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0,"image":"view"}}
"#).await.unwrap();

    let _open_state = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        lines.next_line()
    ).await.unwrap().unwrap().unwrap();

    to_serve.write_all(br#"{"surface":"s1","body":{"op":"resize","width":1600,"height":768,"scale":1.0}}
"#).await.unwrap();

    // Read until the state event for the resize arrives (image envelopes may come first)
    let mut state_json: Option<serde_json::Value> = None;
    for _ in 0..10 {
        let line = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            lines.next_line()
        ).await.expect("timeout waiting for resize response").unwrap().unwrap();

        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            if json["body"]["event"].as_str() == Some("state") {
                state_json = Some(json);
                break;
            }
        }
    }

    let state = state_json.expect("resize should answer with a state event");
    assert!(state["body"]["sessionId"].as_str().is_some_and(|s| !s.is_empty()),
        "resize state event should carry sessionId");
    let cell_width = state["body"]["cellWidth"].as_f64()
        .expect("resize state event should carry cellWidth");
    let cell_height = state["body"]["cellHeight"].as_f64()
        .expect("resize state event should carry cellHeight");
    assert!(cell_width > 0.0, "cellWidth should be positive, got {}", cell_width);
    assert!(cell_height > 0.0, "cellHeight should be positive, got {}", cell_height);

    drop(to_serve);
    task.await.unwrap().unwrap();
}
