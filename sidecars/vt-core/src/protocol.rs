use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use async_trait::async_trait;
use crate::daemon::{DaemonClient, DaemonRequest, DaemonIdentity};
use std::time::Duration;
use crate::encoding::{self, Key};


/// 엔진이 구현할 트레이트. VT 처리 엔진의 계약.
pub trait Engine: Send + 'static {
    fn resize(&mut self, cols: u16, rows: u16);
    fn feed(&mut self, bytes: &[u8]);
    fn screen(&mut self) -> Screen;
    fn modes(&self) -> Modes;
    fn reset(&mut self);
}

/// 셀 하나의 속성
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Cell {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ch: Option<String>,
    pub width: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub inverse: bool,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            ch: None,
            width: 1,
            fg: None,
            bg: None,
            bold: false,
            italic: false,
            underline: false,
            inverse: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub col: u16,
    pub row: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Modes {
    #[serde(default)]
    pub app_cursor: bool,
    #[serde(default)]
    pub app_keypad: bool,
    #[serde(default)]
    pub bracketed_paste: bool,
    #[serde(default)]
    pub mouse_report: bool,
    #[serde(default)]
    pub alt_screen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Screen {
    pub cols: u16,
    pub rows: u16,
    pub cursor: Cursor,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<Vec<Cell>>,
}

/// 데몬에서 받는 이벤트
#[derive(Debug, Clone)]
pub enum DaemonEvent {
    Output {
        session_id: String,
        data: Vec<u8>,
        truncated: bool,
    },
    Exit {
        session_id: String,
    },
}

/// 세션 포트: 데몬과 통신하는 추상 인터페이스
#[async_trait]
pub trait SessionPort: Send + Sync {
    async fn open(&self, program: &str, cols: u16, rows: u16, hint: Option<&str>) -> Result<String, String>;
    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String>;
    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String>;
    async fn detach(&self, session_id: &str) -> Result<(), String>;
    async fn close(&self, session_id: &str) -> Result<(), String>;
    async fn get_events(&self) -> mpsc::Receiver<DaemonEvent>;
}

/// 호스트에서 받은 메시지 봉투
#[derive(Debug, Deserialize)]
struct Envelope {
    surface: String,
    #[allow(dead_code)]
    root: Option<String>,
    body: Option<Value>,
    closed: Option<bool>,
}

/// 표면 작업으로 보낼 명령
#[derive(Debug, Clone)]
enum SurfaceCommand {
    Open { width: u32, height: u32, scale: f32, image: Option<String> },
    Input { bytes: Vec<u8> },
    InputKeys { keys: Vec<InputKey> },
    Resize { width: u32, height: u32, scale: f32 },
    ScreenRead,
    Close,
    SessionClose,
    ImageResponse { body: Value },
}

/// 입력 키 정보
#[derive(Debug, Clone, Deserialize)]
struct InputKey {
    key: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    ctrl: bool,
}

const CELL_WIDTH: f32 = 8.0;
const CELL_HEIGHT: f32 = 16.0;

fn pixels_to_cells(pixels: u32, cell_size: f32, scale: f32) -> u16 {
    (pixels as f32 / (cell_size * scale)) as u16
}

/// 키 입력을 바이트로 인코딩한다
fn encode_keys(keys: &[InputKey], modes: &Modes) -> Result<Vec<u8>, String> {
    let mut all_bytes = Vec::new();

    for input_key in keys {
        let key_name = &input_key.key;
        let text = &input_key.text;

        // 수식자 비트 계산: shift=1, alt=2, ctrl=4
        let mut modifiers = 0u8;
        if input_key.shift {
            modifiers |= 1;
        }
        if input_key.alt {
            modifiers |= 2;
        }
        if input_key.ctrl {
            modifiers |= 4;
        }

        // key 이름을 Key 열거형으로 변환
        let key = match key_name.as_str() {
            "Up" => Key::Up,
            "Down" => Key::Down,
            "Left" => Key::Left,
            "Right" => Key::Right,
            "Home" => Key::Home,
            "End" => Key::End,
            "Insert" => Key::Insert,
            "Delete" => Key::Delete,
            "PageUp" => Key::PageUp,
            "PageDown" => Key::PageDown,
            "F1" => Key::F1,
            "F2" => Key::F2,
            "F3" => Key::F3,
            "F4" => Key::F4,
            "F5" => Key::F5,
            "F6" => Key::F6,
            "F7" => Key::F7,
            "F8" => Key::F8,
            "F9" => Key::F9,
            "F10" => Key::F10,
            "F11" => Key::F11,
            "F12" => Key::F12,
            "Enter" => Key::Enter,
            "Tab" => Key::Tab,
            "Backspace" => Key::Backspace,
            "Escape" => Key::Escape,
            "Char" => {
                // "Char" 특수 처리
                if text.is_empty() {
                    return Err(format!("unknown key: Char with empty text"));
                }
                let ch = text.chars().next().unwrap();
                let encoded_bytes = if modifiers & 4 != 0 {
                    // ctrl 비트가 설정됨
                    encoding::encode_ctrl_char(ch).map_err(|e| format!("unknown key: Char with ctrl: {:?}", e))?
                } else if modifiers & 2 != 0 {
                    // alt 비트가 설정됨
                    encoding::encode_alt_char(ch)
                } else {
                    // 일반 텍스트
                    encoding::encode_text(text)
                };
                all_bytes.extend_from_slice(&encoded_bytes);
                continue;
            }
            _ => {
                return Err(format!("unknown key: {}", key_name));
            }
        };

        // 표준 키를 인코딩
        let encoded_bytes = encoding::encode_key(key, modifiers, modes)
            .map_err(|e| format!("unknown key: {} ({:?})", key_name, e))?;
        all_bytes.extend_from_slice(&encoded_bytes);
    }

    Ok(all_bytes)
}

pub use crate::platform::ImageState;

/// 표면별 비동기 작업. 엔진과 데몬 연결을 소유하며 명령을 처리한다.
async fn surface_task(
    surface_id: String,
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    session_port: Arc<dyn SessionPort>,
    mut cmd_rx: mpsc::Receiver<SurfaceCommand>,
    output_tx: mpsc::Sender<String>,
) {
    let mut engine = engine_factory();
    let mut session_id: Option<String> = None;
    let mut daemon_events_rx = session_port.get_events().await;
    let mut image_state: Option<ImageState> = None;

    loop {
        tokio::select! {
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    SurfaceCommand::Open { width, height, scale, image } => {
                        let cols = pixels_to_cells(width, CELL_WIDTH, scale);
                        let rows = pixels_to_cells(height, CELL_HEIGHT, scale);
                        engine.resize(cols, rows);

                        if let Some(ref image_name) = image {
                            image_state = ImageState::new(image_name.clone(), width, height);
                        }

                        match session_port.open("/bin/sh", cols, rows, None).await {
                            Ok(sid) => {
                                session_id = Some(sid.clone());
                                let mut state_body = json!({
                                    "event": "state",
                                    "sessionId": sid,
                                    "cols": cols,
                                    "rows": rows,
                                    "cursor": {"col": 0, "row": 0}
                                });

                                if let Some(ref _img_state) = image_state {
                                    state_body["cellWidth"] = json!(CELL_WIDTH);
                                    state_body["cellHeight"] = json!(CELL_HEIGHT);
                                }

                                let response = json!({
                                    "surface": surface_id,
                                    "body": state_body
                                });
                                let _ = output_tx.send(response.to_string()).await;
                            }
                            Err(e) => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": format!("Failed to open: {}", e)}
                                });
                                let _ = output_tx.send(response.to_string()).await;
                            }
                        }
                    }
                    SurfaceCommand::Input { bytes } => {
                        if let Some(ref sid) = session_id {
                            match session_port.write(sid, &bytes).await {
                                Ok(()) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"ack": true}
                                    });
                                    let _ = output_tx.send(response.to_string()).await;
                                }
                                Err(e) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": format!("Write failed: {}", e)}
                                    });
                                    let _ = output_tx.send(response.to_string()).await;
                                }
                            }
                        } else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "Session not open"}
                            });
                            let _ = output_tx.send(response.to_string()).await;
                        }
                    }
                    SurfaceCommand::InputKeys { keys } => {
                        if let Some(ref sid) = session_id {
                            let modes = engine.modes();
                            match encode_keys(&keys, &modes) {
                                Ok(bytes) => {
                                    if !bytes.is_empty() {
                                        match session_port.write(sid, &bytes).await {
                                            Ok(()) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"ack": true}
                                                });
                                                let _ = output_tx.send(response.to_string()).await;
                                            }
                                            Err(e) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"error": format!("Write failed: {}", e)}
                                                });
                                                let _ = output_tx.send(response.to_string()).await;
                                            }
                                        }
                                    } else {
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": {"ack": true}
                                        });
                                        let _ = output_tx.send(response.to_string()).await;
                                    }
                                }
                                Err(e) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": e}
                                    });
                                    let _ = output_tx.send(response.to_string()).await;
                                }
                            }
                        } else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "Session not open"}
                            });
                            let _ = output_tx.send(response.to_string()).await;
                        }
                    }
                    SurfaceCommand::Resize { width, height, scale } => {
                        let cols = pixels_to_cells(width, CELL_WIDTH, scale);
                        let rows = pixels_to_cells(height, CELL_HEIGHT, scale);
                        engine.resize(cols, rows);

                        if let Some(ref sid) = session_id {
                            if let Err(e) = session_port.resize(sid, cols, rows).await {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": format!("Resize failed: {}", e)}
                                });
                                let _ = output_tx.send(response.to_string()).await;
                            } else {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {
                                        "event": "state",
                                        "cols": cols,
                                        "rows": rows,
                                        "cursor": {"col": 0, "row": 0}
                                    }
                                });
                                let _ = output_tx.send(response.to_string()).await;
                            }
                        }
                    }
                    SurfaceCommand::ScreenRead => {
                        let screen = engine.screen();
                        let response = json!({
                            "surface": surface_id,
                            "body": {
                                "event": "screen",
                                "cols": screen.cols,
                                "rows": screen.rows,
                                "cursor": screen.cursor,
                                "lines": screen.lines
                            }
                        });
                        let _ = output_tx.send(response.to_string()).await;
                    }
                    SurfaceCommand::SessionClose => {
                        if let Some(ref sid) = session_id {
                            let _ = session_port.close(sid).await;
                        }
                        let response = json!({
                            "surface": surface_id,
                            "body": {}
                        });
                        let _ = output_tx.send(response.to_string()).await;
                        break;
                    }
                    SurfaceCommand::Close => {
                        if let Some(ref sid) = session_id {
                            let _ = session_port.detach(sid).await;
                        }
                        break;
                    }
                    SurfaceCommand::ImageResponse { body } => {
                        if let Some(ref mut img_state) = image_state {
                            if let Some(image_obj) = body.get("image") {
                                if image_obj.get("released").is_some() {
                                    // Surface was released, can draw again
                                    if img_state.pending_draw {
                                        // Redraw immediately
                                        let screen = engine.screen();
                                        if img_state.frame.draw(&screen, &img_state.metrics).is_ok() {
                                            img_state.sequence += 1;
                                            let nonce = img_state.frame.nonce();
                                            let nonce_b64 = base64_encode(&nonce);
                                            let image_envelope = json!({
                                                "surface": surface_id,
                                                "body": {
                                                    "image": {
                                                        "name": img_state.name,
                                                        "token": {
                                                            "kind": "iosurface-global",
                                                            "id": img_state.frame.id(),
                                                            "nonce": nonce_b64
                                                        },
                                                        "width": img_state.width_px,
                                                        "height": img_state.height_px,
                                                        "scale": 1.0,
                                                        "format": "bgra8",
                                                        "sequence": img_state.sequence
                                                    }
                                                }
                                            });
                                            let _ = output_tx.send(image_envelope.to_string()).await;
                                            img_state.pending_draw = false;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Some(event) = daemon_events_rx.recv() => {
                match event {
                    DaemonEvent::Output { session_id: ref recv_sid, data, truncated } => {
                        if let Some(ref sid) = session_id {
                            if recv_sid == sid {
                                if truncated {
                                    engine.reset();
                                }
                                engine.feed(&data);
                                let screen = engine.screen();

                                if let Some(ref mut img_state) = image_state {
                                    // Draw to the frame if not pending a return
                                    if !img_state.pending_draw {
                                        if img_state.frame.draw(&screen, &img_state.metrics).is_ok() {
                                            img_state.sequence += 1;
                                            img_state.pending_draw = true;
                                            let nonce = img_state.frame.nonce();
                                            let nonce_b64 = base64_encode(&nonce);
                                            let image_envelope = json!({
                                                "surface": surface_id,
                                                "body": {
                                                    "image": {
                                                        "name": img_state.name,
                                                        "token": {
                                                            "kind": "iosurface-global",
                                                            "id": img_state.frame.id(),
                                                            "nonce": nonce_b64
                                                        },
                                                        "width": img_state.width_px,
                                                        "height": img_state.height_px,
                                                        "scale": 1.0,
                                                        "format": "bgra8",
                                                        "sequence": img_state.sequence
                                                    }
                                                }
                                            });
                                            let _ = output_tx.send(image_envelope.to_string()).await;
                                        }
                                    }
                                }

                                let response = json!({
                                    "surface": surface_id,
                                    "body": {
                                        "event": "screen",
                                        "cols": screen.cols,
                                        "rows": screen.rows,
                                        "cursor": screen.cursor,
                                        "lines": screen.lines
                                    }
                                });
                                let _ = output_tx.send(response.to_string()).await;
                            }
                        }
                    }
                    DaemonEvent::Exit { session_id: ref recv_sid } => {
                        if let Some(ref sid) = session_id {
                            if recv_sid == sid {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"event": "exit"}
                                });
                                let _ = output_tx.send(response.to_string()).await;
                                break;
                            }
                        }
                    }
                }
            }
            else => break,
        }
    }
}

/// 서비스 루프. stdin에서 JSON을 읽고 stdout으로 응답을 씀.
pub async fn serve<R, W>(
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    reader: R,
    writer: W,
    session_port_factory: Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync>,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let buf_reader = BufReader::new(reader);
    let (output_tx, output_rx) = mpsc::channel::<String>(100);

    let input_task = run_input_loop(buf_reader, engine_factory, session_port_factory, output_tx);
    let output_task = run_output_loop(writer, output_rx);

    tokio::try_join!(input_task, output_task)?;
    Ok(())
}

async fn run_input_loop<R>(
    mut buf_reader: BufReader<R>,
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    session_port_factory: Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync>,
    output_tx: mpsc::Sender<String>,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut surface_txs: HashMap<String, mpsc::Sender<SurfaceCommand>> = HashMap::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut line = String::new();

    loop {
        line.clear();
        let n = buf_reader.read_line(&mut line).await?;

        if n == 0 {
            // stdin EOF
            for (_, tx) in surface_txs.iter() {
                let _ = tx.send(SurfaceCommand::Close).await;
            }
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<Envelope>(trimmed) {
            Ok(env) => {
                let surface_id = env.surface.clone();

                if env.closed == Some(true) {
                    if let Some(tx) = surface_txs.remove(&surface_id) {
                        let _ = tx.send(SurfaceCommand::Close).await;
                    }
                    let response = json!({"surface": surface_id, "body": {}});
                    let _ = output_tx.send(response.to_string()).await;
                } else if let Some(body) = env.body {
                    let tx = if let Some(tx) = surface_txs.get(&surface_id) {
                        tx.clone()
                    } else {
                        // 새 표면: 작업 생성
                        let (cmd_tx, cmd_rx) = mpsc::channel(10);
                        let session_port = session_port_factory();
                        let factory = engine_factory.clone();
                        let out_tx = output_tx.clone();
                        let sid = surface_id.clone();
                        tasks.spawn(async move {
                            surface_task(sid, factory, session_port, cmd_rx, out_tx).await;
                        });
                        surface_txs.insert(surface_id.clone(), cmd_tx.clone());
                        cmd_tx
                    };

                    // Check for op field first (it's a request)
                    if let Some(op) = body.get("op").and_then(|v| v.as_str()) {
                        match op {
                            "open" => {
                                let width = body.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                let height = body.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                let scale = body.get("scale").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;
                                let image = body.get("image").and_then(|v| v.as_str()).map(|s| s.to_string());
                                let _ = tx.send(SurfaceCommand::Open { width, height, scale, image }).await;
                            }
                            "input" => {
                                // bytes를 먼저 보냄 (둘 다 있으면 bytes 먼저)
                                if let Some(bytes_b64) = body.get("bytes").and_then(|v| v.as_str()) {
                                    match base64_decode(bytes_b64) {
                                        Ok(bytes) => {
                                            let _ = tx.send(SurfaceCommand::Input { bytes }).await;
                                        }
                                        Err(e) => {
                                            let response = json!({
                                                "surface": surface_id,
                                                "body": {"error": format!("Base64 error: {}", e)}
                                            });
                                            let _ = output_tx.send(response.to_string()).await;
                                        }
                                    }
                                }

                                // 그 다음 keys를 처리
                                if let Some(keys_arr) = body.get("keys").and_then(|v| v.as_array()) {
                                    match serde_json::from_value::<Vec<InputKey>>(Value::Array(keys_arr.clone())) {
                                        Ok(keys) => {
                                            let _ = tx.send(SurfaceCommand::InputKeys { keys }).await;
                                        }
                                        Err(e) => {
                                            let response = json!({
                                                "surface": surface_id,
                                                "body": {"error": format!("Keys parse error: {}", e)}
                                            });
                                            let _ = output_tx.send(response.to_string()).await;
                                        }
                                    }
                                }
                            }
                            "resize" => {
                                let width = body.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                let height = body.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                let scale = body.get("scale").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;
                                let _ = tx.send(SurfaceCommand::Resize { width, height, scale }).await;
                            }
                            "screen.read" => {
                                let _ = tx.send(SurfaceCommand::ScreenRead).await;
                            }
                            "close" => {
                                let _ = tx.send(SurfaceCommand::SessionClose).await;
                            }
                            _ => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": format!("Unknown op: {}", op)}
                                });
                                let _ = output_tx.send(response.to_string()).await;
                            }
                        }
                    } else if body.get("image").and_then(|v| v.as_object()).is_some() {
                        // It's a host image response (image field is an object)
                        let _ = tx.send(SurfaceCommand::ImageResponse { body: body.clone() }).await;
                    } else {
                        // No op and no image object - unknown message
                        let response = json!({
                            "surface": surface_id,
                            "body": {"error": "unknown op"}
                        });
                        let _ = output_tx.send(response.to_string()).await;
                    }
                }
            }
            Err(e) => {
                let response = json!({
                    "surface": "",
                    "body": {"error": format!("Parse error: {}", e)}
                });
                let _ = output_tx.send(response.to_string()).await;
            }
        }
    }

    // 모든 작업이 끝날 때까지 기다림
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn run_output_loop<W>(
    mut writer: W,
    mut output_rx: mpsc::Receiver<String>,
) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    while let Some(output) = output_rx.recv().await {
        writer.write_all(output.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
    }
    Ok(())
}

pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let b1 = bytes[i];
        if b1 == b'=' {
            break;
        }

        let idx1 = ALPHABET.iter().position(|&x| x == b1)
            .ok_or_else(|| "Invalid Base64".to_string())?;

        if i + 1 >= bytes.len() {
            return Err("Incomplete Base64".to_string());
        }

        let b2 = bytes[i + 1];
        let idx2 = ALPHABET.iter().position(|&x| x == b2)
            .ok_or_else(|| "Invalid Base64".to_string())?;

        result.push((((idx1 << 2) | (idx2 >> 4)) & 0xFF) as u8);

        if i + 2 < bytes.len() && bytes[i + 2] != b'=' {
            let b3 = bytes[i + 2];
            let idx3 = ALPHABET.iter().position(|&x| x == b3)
                .ok_or_else(|| "Invalid Base64".to_string())?;

            result.push((((idx2 << 4) | (idx3 >> 2)) & 0xFF) as u8);

            if i + 3 < bytes.len() && bytes[i + 3] != b'=' {
                let b4 = bytes[i + 3];
                let idx4 = ALPHABET.iter().position(|&x| x == b4)
                    .ok_or_else(|| "Invalid Base64".to_string())?;

                result.push((((idx3 << 6) | idx4) & 0xFF) as u8);
                i += 4;
            } else {
                i += 3;
            }
        } else {
            i += 2;
        }
    }

    Ok(result)
}

#[cfg(test)]
pub struct FakeEngine {
    cols: u16,
    rows: u16,
    content: String,
}

#[cfg(test)]
impl FakeEngine {
    pub fn new() -> Self {
        Self {
            cols: 80,
            rows: 24,
            content: String::new(),
        }
    }
}

#[cfg(test)]
impl Engine for FakeEngine {
    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
    }

    fn feed(&mut self, bytes: &[u8]) {
        if let Ok(s) = std::str::from_utf8(bytes) {
            self.content.push_str(s);
        }
    }

    fn screen(&mut self) -> Screen {
        let mut lines = Vec::new();
        for line in self.content.lines() {
            let mut row = Vec::new();
            for ch in line.chars() {
                let width = if (ch as u32) > 127 { 2 } else { 1 };
                let cell = Cell {
                    ch: Some(ch.to_string()),
                    width,
                    ..Default::default()
                };
                row.push(cell);
            }
            lines.push(row);
        }
        Screen {
            cols: self.cols,
            rows: self.rows,
            cursor: Cursor { col: 0, row: 0 },
            lines,
        }
    }

    fn modes(&self) -> Modes {
        Modes::default()
    }

    fn reset(&mut self) {
        self.content.clear();
    }
}

/// 기본 SessionPort 팩토리를 만든다 (DaemonFinder를 사용)
pub fn make_default_session_port_factory() -> Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync> {
    Arc::new(|| {
        Arc::new(DaemonSessionPort::new()) as Arc<dyn SessionPort>
    })
}

/// 실제 데몬 연결을 관리하는 SessionPort 구현
pub struct DaemonSessionPort {
    writers: Arc<tokio::sync::Mutex<HashMap<String, crate::daemon::DaemonWriter>>>,
    events_tx: mpsc::UnboundedSender<DaemonEvent>,
    events_rx: Arc<tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<DaemonEvent>>>>,
    finder: Box<dyn crate::daemon::DaemonFinder>,
}

impl DaemonSessionPort {
    fn new() -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            writers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            events_tx,
            events_rx: Arc::new(tokio::sync::Mutex::new(Some(events_rx))),
            finder: crate::platform::get_daemon_finder(),
        }
    }

    pub fn with_finder(finder: Box<dyn crate::daemon::DaemonFinder>) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            writers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            events_tx,
            events_rx: Arc::new(tokio::sync::Mutex::new(Some(events_rx))),
            finder,
        }
    }

    async fn connect_and_open(&self, program: &str, cols: u16, rows: u16, hint: Option<&str>) -> Result<String, String> {
        let build_kind = std::env::var("SOKSAK_PROFILE")
            .unwrap_or_else(|_| "debug".to_string());
        let identity = DaemonIdentity {
            protocol: "ptyd".to_string(),
            build_kind,
        };
        let socket_path = self.finder.find_or_start(&identity)?;
        let mut client = DaemonClient::connect(&socket_path).await?;

        let req = DaemonRequest {
            command: "open".to_string(),
            program: Some(program.to_string()),
            cols: Some(cols as i32),
            rows: Some(rows as i32),
            hint: hint.map(|h| h.to_string()),
            args: None,
            env: None,
            cwd: None,
            session_id: None,
            data: None,
            from: None,
        };

        client.send_request(&req).await?;

        // Read open response directly from this connection with 5 second timeout
        let resp = tokio::time::timeout(Duration::from_secs(5), client.read_response())
            .await
            .map_err(|_| "Timeout waiting for open response".to_string())?
            .map_err(|e| format!("Failed to read response: {}", e))?
            .ok_or_else(|| "No response from daemon".to_string())?;

        if let Some(error) = resp.error {
            return Err(format!("Daemon error: {}", error));
        }

        let session_id = resp.session_id.ok_or_else(|| "No sessionId in response".to_string())?;

        // Split connection: writer for sending commands, reader for background reading
        let (writer, reader) = client.into_split();

        // Store writer for this session
        self.writers.lock().await.insert(session_id.clone(), writer);

        // Start background reader task for this session
        let events_tx = self.events_tx.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut reader = reader;
            loop {
                match reader.read_response().await {
                    Ok(Some(resp)) => {
                        if let Some(command) = resp.command {
                            match command.as_str() {
                                "output" => {
                                    if let (Some(session_id), Some(output)) = (resp.session_id, resp.output) {
                                        let data = match base64_decode(&output) {
                                            Ok(d) => d,
                                            Err(_) => output.into_bytes(),
                                        };
                                        let truncated = resp.truncated.unwrap_or(false);
                                        let _ = events_tx.send(DaemonEvent::Output {
                                            session_id,
                                            data,
                                            truncated,
                                        });
                                    }
                                }
                                "exit" => {
                                    if let Some(session_id) = resp.session_id {
                                        let _ = events_tx.send(DaemonEvent::Exit { session_id });
                                    }
                                    break;
                                }
                                // Discard responses for write, resize, detach
                                "write" | "resize" | "detach" => {}
                                _ => {}
                            }
                        }
                        if let Some(error) = resp.error {
                            eprintln!("Daemon error for session {}: {}", sid, error);
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });

        Ok(session_id)
    }
}

#[async_trait]
impl SessionPort for DaemonSessionPort {
    async fn open(&self, program: &str, cols: u16, rows: u16, hint: Option<&str>) -> Result<String, String> {
        self.connect_and_open(program, cols, rows, hint).await
    }

    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut writers = self.writers.lock().await;
        let writer = writers.get_mut(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;

        let data_b64 = base64_encode(data);
        let req = DaemonRequest {
            command: "write".to_string(),
            session_id: Some(session_id.to_string()),
            data: Some(data_b64),
            hint: None,
            program: None,
            args: None,
            env: None,
            cwd: None,
            cols: None,
            rows: None,
            from: None,
        };

        writer.send_request(&req).await?;
        Ok(())
    }

    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut writers = self.writers.lock().await;
        let writer = writers.get_mut(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;

        let req = DaemonRequest {
            command: "resize".to_string(),
            session_id: Some(session_id.to_string()),
            cols: Some(cols as i32),
            rows: Some(rows as i32),
            hint: None,
            program: None,
            args: None,
            env: None,
            cwd: None,
            data: None,
            from: None,
        };

        writer.send_request(&req).await?;
        Ok(())
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        let mut writers = self.writers.lock().await;
        let mut writer = writers.remove(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;

        let req = DaemonRequest {
            command: "detach".to_string(),
            session_id: Some(session_id.to_string()),
            hint: None,
            program: None,
            args: None,
            env: None,
            cwd: None,
            cols: None,
            rows: None,
            data: None,
            from: None,
        };

        writer.send_request(&req).await?;
        Ok(())
    }

    async fn close(&self, session_id: &str) -> Result<(), String> {
        let mut writers = self.writers.lock().await;
        let mut writer = writers.remove(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;

        let req = DaemonRequest {
            command: "close".to_string(),
            session_id: Some(session_id.to_string()),
            hint: None,
            program: None,
            args: None,
            env: None,
            cwd: None,
            cols: None,
            rows: None,
            data: None,
            from: None,
        };

        writer.send_request(&req).await?;
        Ok(())
    }

    async fn get_events(&self) -> mpsc::Receiver<DaemonEvent> {
        let (tx, rx) = mpsc::channel(10);
        let mut rx_guard = self.events_rx.lock().await;
        if let Some(mut unbounded_rx) = rx_guard.take() {
            // Forward events from unbounded to bounded channel
            tokio::spawn(async move {
                while let Some(event) = unbounded_rx.recv().await {
                    let _ = tx.send(event).await;
                }
            });
        }
        rx
    }
}

/// Base64 encode
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let mut i = 0;

    while i < data.len() {
        let b1 = data[i];
        let b2 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b3 = if i + 2 < data.len() { data[i + 2] } else { 0 };

        let idx1 = ((b1 >> 2) & 0x3F) as usize;
        let idx2 = (((b1 & 0x03) << 4) | ((b2 >> 4) & 0x0F)) as usize;
        let idx3 = (((b2 & 0x0F) << 2) | ((b3 >> 6) & 0x03)) as usize;
        let idx4 = (b3 & 0x3F) as usize;

        result.push(ALPHABET[idx1] as char);
        result.push(ALPHABET[idx2] as char);

        if i + 1 < data.len() {
            result.push(ALPHABET[idx3] as char);
        } else {
            result.push('=');
        }

        if i + 2 < data.len() {
            result.push(ALPHABET[idx4] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }

    result
}

pub struct FakeSessionPort {
    pub calls: Arc<tokio::sync::Mutex<CallTracker>>,
}

pub struct CallTracker {
    pub opens: Vec<String>,
    pub writes: Vec<(String, Vec<u8>)>,
    pub resizes: Vec<(String, u16, u16)>,
    pub detaches: Vec<String>,
    pub closes: Vec<String>,
}

impl FakeSessionPort {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(tokio::sync::Mutex::new(CallTracker {
                opens: Vec::new(),
                writes: Vec::new(),
                resizes: Vec::new(),
                detaches: Vec::new(),
                closes: Vec::new(),
            })),
        }
    }
}

#[async_trait]
impl SessionPort for FakeSessionPort {
    async fn open(&self, program: &str, _cols: u16, _rows: u16, _hint: Option<&str>) -> Result<String, String> {
        let mut calls = self.calls.lock().await;
        let session_id = format!("session-{}", calls.opens.len());
        calls.opens.push(program.to_string());
        Ok(session_id)
    }

    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut calls = self.calls.lock().await;
        calls.writes.push((session_id.to_string(), data.to_vec()));
        Ok(())
    }

    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut calls = self.calls.lock().await;
        calls.resizes.push((session_id.to_string(), cols, rows));
        Ok(())
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        let mut calls = self.calls.lock().await;
        calls.detaches.push(session_id.to_string());
        Ok(())
    }

    async fn close(&self, session_id: &str) -> Result<(), String> {
        let mut calls = self.calls.lock().await;
        calls.closes.push(session_id.to_string());
        Ok(())
    }

    async fn get_events(&self) -> mpsc::Receiver<DaemonEvent> {
        let (_tx, rx) = mpsc::channel(10);
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_decode() {
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
    }
}
