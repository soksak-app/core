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

fn pixels_to_cells(pixels: u32, cell_size: f32) -> u16 {
    (pixels as f32 / cell_size) as u16
}

/// Validate and calculate terminal size. Returns error if width/height invalid or result is 0.
fn calculate_terminal_size(width: u32, height: u32, scale: f32) -> Result<(u16, u16), String> {
    if scale <= 0.0 {
        return Err("scale must be a positive number".to_string());
    }
    if width == 0 || height == 0 {
        return Err("width and height must be positive".to_string());
    }

    let metrics = crate::platform::metrics(13.0, scale);
    let cols = pixels_to_cells(width, metrics.cell_width);
    let rows = pixels_to_cells(height, metrics.cell_height);

    if cols == 0 || rows == 0 {
        return Err("width and height must be positive".to_string());
    }

    Ok((cols, rows))
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

/// 화면을 그림에 그려 봉투를 보내고 그림을 호스트에 넘긴다.
/// 그리기에 실패하면 오류 이벤트를 보내고 true 를 반환한다. 출력 통로가 닫혔으면 false 를 반환한다.
async fn present_screen(
    surface_id: &str,
    screen: &Screen,
    state: &mut ImageState,
    output_tx: &mpsc::Sender<String>,
) -> bool {
    if let Err(reason) = state.frame.draw(screen, &state.metrics) {
        let response = json!({
            "surface": surface_id,
            "body": {"event": "error", "reason": reason}
        });
        return output_tx.send(response.to_string()).await.is_ok();
    }
    state.sequence += 1;
    state.pending_draw = true;
    state.dirty = false;
    let nonce = state.frame.nonce();
    let nonce_b64 = base64_encode(&nonce);
    let image_envelope = json!({
        "surface": surface_id,
        "body": {
            "image": {
                "name": state.name.clone(),
                "token": {
                    "kind": "iosurface-global",
                    "id": state.frame.id(),
                    "nonce": nonce_b64
                },
                "width": state.width_px,
                "height": state.height_px,
                "scale": state.scale,
                "format": "bgra8",
                "sequence": state.sequence
            }
        }
    });
    output_tx.send(image_envelope.to_string()).await.is_ok()
}

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
                        match calculate_terminal_size(width, height, scale) {
                            Ok((cols, rows)) => {
                                engine.resize(cols, rows);

                                if let Some(ref image_name) = image {
                                    match ImageState::new(image_name.clone(), width, height, scale) {
                                        Some(new_state) => image_state = Some(new_state),
                                        None => {
                                            let response = json!({
                                                "surface": surface_id,
                                                "body": {
                                                    "error": "image creation failed",
                                                    "reason": format!("IOSurface creation failed for {}x{}", width, height)
                                                }
                                            });
                                            if let Err(_) = output_tx.send(response.to_string()).await {
                                                return;
                                            }
                                        }
                                    }
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
                                            let metrics = crate::platform::metrics(13.0, scale);
                                            // CSS pixels = device pixels / scale
                                            state_body["cellWidth"] = json!(metrics.cell_width / scale);
                                            state_body["cellHeight"] = json!(metrics.cell_height / scale);
                                        }

                                        let response = json!({
                                            "surface": surface_id,
                                            "body": state_body
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            // Output channel closed; serve() will end with error
                                            return;
                                        }
                                    }
                                    Err(e) => {
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": {"error": format!("Failed to open: {}", e)}
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            // Output channel closed; serve() will end with error
                                            return;
                                        }
                                    }
                                }
                            }
                            Err(reason) => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": "invalidParams", "reason": reason}
                                });
                                if let Err(_) = output_tx.send(response.to_string()).await {
                                    // Output channel closed; serve() will end with error
                                    return;
                                }
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
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        return;
                                    }
                                }
                                Err(e) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": format!("Write failed: {}", e)}
                                    });
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        return;
                                    }
                                }
                            }
                        } else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "Session not open"}
                            });
                            if let Err(_) = output_tx.send(response.to_string()).await {
                                return;
                            }
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
                                                if let Err(_) = output_tx.send(response.to_string()).await {
                                                    return;
                                                }
                                            }
                                            Err(e) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"error": format!("Write failed: {}", e)}
                                                });
                                                if let Err(_) = output_tx.send(response.to_string()).await {
                                                    return;
                                                }
                                            }
                                        }
                                    } else {
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": {"ack": true}
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            return;
                                        }
                                    }
                                }
                                Err(e) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": e}
                                    });
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        return;
                                    }
                                }
                            }
                        } else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "Session not open"}
                            });
                            if let Err(_) = output_tx.send(response.to_string()).await {
                                return;
                            }
                        }
                    }
                    SurfaceCommand::Resize { width, height, scale } => {
                        match calculate_terminal_size(width, height, scale) {
                            Ok((cols, rows)) => {
                                engine.resize(cols, rows);

                                // 그림 영역을 새 크기로 다시 만들어 즉시 그린다. 이전 그림을 버리므로 순번만 이어 받는다.
                                let held = image_state.as_ref().map(|st| (st.name.clone(), st.sequence));
                                if let Some((name, sequence)) = held {
                                    match ImageState::new(name, width, height, scale) {
                                        Some(mut new_state) => {
                                            new_state.sequence = sequence;
                                            image_state = Some(new_state);
                                            let screen = engine.screen();
                                            if let Some(ref mut img_state) = image_state {
                                                if !present_screen(&surface_id, &screen, img_state, &output_tx).await {
                                                    return;
                                                }
                                            }
                                        }
                                        None => {
                                            let response = json!({
                                                "surface": surface_id,
                                                "body": {
                                                    "error": "image creation failed",
                                                    "reason": format!("IOSurface creation failed for {}x{}", width, height)
                                                }
                                            });
                                            if let Err(_) = output_tx.send(response.to_string()).await {
                                                return;
                                            }
                                        }
                                    }
                                }

                                if let Some(ref sid) = session_id {
                                    if let Err(e) = session_port.resize(sid, cols, rows).await {
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": {"error": format!("Resize failed: {}", e)}
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            return;
                                        }
                                    } else {
                                        let mut state_body = json!({
                                            "event": "state",
                                            "sessionId": sid,
                                            "cols": cols,
                                            "rows": rows,
                                            "cursor": {"col": 0, "row": 0}
                                        });
                                        if image_state.is_some() {
                                            let metrics = crate::platform::metrics(13.0, scale);
                                            // CSS 픽셀 = 장치 픽셀 / scale
                                            state_body["cellWidth"] = json!(metrics.cell_width / scale);
                                            state_body["cellHeight"] = json!(metrics.cell_height / scale);
                                        }
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": state_body
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            return;
                                        }
                                    }
                                }
                            }
                            Err(reason) => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": "invalidParams", "reason": reason}
                                });
                                if let Err(_) = output_tx.send(response.to_string()).await {
                                    return;
                                }
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
                        if let Err(_) = output_tx.send(response.to_string()).await {
                            return;
                        }
                    }
                    SurfaceCommand::SessionClose => {
                        if let Some(ref sid) = session_id {
                            // Closing session; intentionally ignore close errors during cleanup (already disconnecting)
                            let _ = session_port.close(sid).await;
                        }
                        let response = json!({
                            "surface": surface_id,
                            "body": {}
                        });
                        if let Err(_) = output_tx.send(response.to_string()).await {
                            // Output channel closed, exit anyway
                        }
                        break;
                    }
                    SurfaceCommand::Close => {
                        if let Some(ref sid) = session_id {
                            // Surface detaching; intentionally ignore detach errors during cleanup (already disconnecting)
                            let _ = session_port.detach(sid).await;
                        }
                        break;
                    }
                    SurfaceCommand::ImageResponse { body } => {
                        let image_obj = body.get("image").and_then(|v| v.as_object());
                        let released = image_obj.and_then(|o| o.get("released")).and_then(|v| v.as_object());
                        let is_error = image_obj.map_or(false, |o| o.get("error").is_some());
                        // released 는 안쪽 객체에, 오류는 바깥에 이름과 순번을 실어 보낸다.
                        let name = image_obj
                            .and_then(|o| o.get("name"))
                            .and_then(|v| v.as_str())
                            .or_else(|| released.and_then(|r| r.get("name")).and_then(|v| v.as_str()));
                        let response_sequence = released
                            .and_then(|r| r.get("sequence"))
                            .and_then(|v| v.as_u64())
                            .or_else(|| image_obj.and_then(|o| o.get("sequence")).and_then(|v| v.as_u64()));
                        if let Some(ref mut img_state) = image_state {
                            if Some(img_state.name.as_str()) == name
                                && response_sequence == Some(img_state.sequence as u64)
                            {
                                if released.is_some() || is_error {
                                    // 돌아온 그림과 표시에 실패한 그림은 호스트에 남지 않는다.
                                    img_state.pending_draw = false;
                                    if img_state.dirty {
                                        let screen = engine.screen();
                                        if !present_screen(&surface_id, &screen, img_state, &output_tx).await {
                                            return;
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
                                    // 그림이 호스트에 있으면 돌려받을 때까지 그리지 않고 변경 사실만 남긴다.
                                    if img_state.pending_draw {
                                        img_state.dirty = true;
                                    } else if !present_screen(&surface_id, &screen, img_state, &output_tx).await {
                                        return;
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
                                if let Err(_) = output_tx.send(response.to_string()).await {
                                    return;
                                }
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
                                if let Err(_) = output_tx.send(response.to_string()).await {
                                    // Output channel closed, exit anyway
                                }
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
            // stdin EOF - intentionally ignore send errors during cleanup
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
                        // Surface is closed; tell the task to close
                        if let Err(_) = tx.send(SurfaceCommand::Close).await {
                            // Command channel closed, surface task already exiting
                        }
                    }
                    let response = json!({"surface": surface_id, "body": {}});
                    if let Err(_) = output_tx.send(response.to_string()).await {
                        // Output channel closed; end serve
                        break;
                    }
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
                        let sid_for_monitor = sid.clone();

                        // Spawn the actual surface task in a separate handle
                        let surface_handle = tokio::spawn(async move {
                            surface_task(sid, factory, session_port, cmd_rx, out_tx).await;
                        });

                        // Spawn a monitor task to watch for panics
                        let out_tx_monitor = output_tx.clone();
                        tasks.spawn(async move {
                            match surface_handle.await {
                                Ok(_) => {},
                                Err(join_err) if join_err.is_panic() => {
                                    // Task panicked; send error event
                                    let panic_msg = if let Ok(panic_obj) = join_err.try_into_panic() {
                                        if let Some(s) = panic_obj.downcast_ref::<String>() {
                                            s.clone()
                                        } else if let Some(&s) = panic_obj.downcast_ref::<&str>() {
                                            s.to_string()
                                        } else {
                                            "unknown".to_string()
                                        }
                                    } else {
                                        "unknown".to_string()
                                    };
                                    let response = json!({
                                        "surface": sid_for_monitor,
                                        "body": {"event": "error", "reason": format!("surface task ended: {}", panic_msg)}
                                    });
                                    // Intentionally ignore output send error; if output channel closed, serve() will detect it
                                    let _ = out_tx_monitor.send(response.to_string()).await;
                                }
                                Err(_) => {
                                    // Task cancelled
                                }
                            }
                        });

                        surface_txs.insert(surface_id.clone(), cmd_tx.clone());
                        cmd_tx
                    };

                    // Check for op field first (it's a request)
                    if let Some(op) = body.get("op").and_then(|v| v.as_str()) {
                        match op {
                            "open" => {
                                // Validate required fields: width, height, scale. image is optional.
                                let width_opt = body.get("width").and_then(|v| v.as_u64()).map(|v| v as u32);
                                let height_opt = body.get("height").and_then(|v| v.as_u64()).map(|v| v as u32);
                                let scale_opt = body.get("scale").and_then(|v| v.as_f64()).map(|v| v as f32);

                                if width_opt.is_none() || height_opt.is_none() || scale_opt.is_none() {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": "open requires width, height, and scale fields (non-null, numbers)"}
                                    });
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        break;
                                    }
                                } else {
                                    let width = width_opt.unwrap();
                                    let height = height_opt.unwrap();
                                    let scale = scale_opt.unwrap();
                                    let image = body.get("image").and_then(|v| v.as_str()).map(|s| s.to_string());
                                    if let Err(_) = tx.send(SurfaceCommand::Open { width, height, scale, image }).await {
                                        break;
                                    }
                                }
                            }
                            "input" => {
                                // Either bytes or keys or both must be present
                                let has_bytes = body.get("bytes").is_some();
                                let has_keys = body.get("keys").is_some();

                                if !has_bytes && !has_keys {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": "input requires bytes or keys field"}
                                    });
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        break;
                                    }
                                } else {
                                    // Process bytes first (if present)
                                    if let Some(bytes_b64) = body.get("bytes").and_then(|v| v.as_str()) {
                                        match base64_decode(bytes_b64) {
                                            Ok(bytes) => {
                                                if let Err(_) = tx.send(SurfaceCommand::Input { bytes }).await {
                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"error": format!("Base64 error: {}", e)}
                                                });
                                                if let Err(_) = output_tx.send(response.to_string()).await {
                                                    break;
                                                }
                                            }
                                        }
                                    } else if has_bytes {
                                        // bytes field present but not a string
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": {"error": "invalidParams", "reason": "bytes must be a string"}
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            break;
                                        }
                                    }

                                    // Then process keys (if present)
                                    if let Some(keys_arr) = body.get("keys").and_then(|v| v.as_array()) {
                                        match serde_json::from_value::<Vec<InputKey>>(Value::Array(keys_arr.clone())) {
                                            Ok(keys) => {
                                                if let Err(_) = tx.send(SurfaceCommand::InputKeys { keys }).await {
                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"error": format!("Keys parse error: {}", e)}
                                                });
                                                if let Err(_) = output_tx.send(response.to_string()).await {
                                                    break;
                                                }
                                            }
                                        }
                                    } else if has_keys {
                                        // keys field present but not an array
                                        let response = json!({
                                            "surface": surface_id,
                                            "body": {"error": "invalidParams", "reason": "keys must be an array"}
                                        });
                                        if let Err(_) = output_tx.send(response.to_string()).await {
                                            break;
                                        }
                                    }
                                }
                            }
                            "resize" => {
                                // Validate required fields: width, height, scale.
                                let width_opt = body.get("width").and_then(|v| v.as_u64()).map(|v| v as u32);
                                let height_opt = body.get("height").and_then(|v| v.as_u64()).map(|v| v as u32);
                                let scale_opt = body.get("scale").and_then(|v| v.as_f64()).map(|v| v as f32);

                                if width_opt.is_none() || height_opt.is_none() || scale_opt.is_none() {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": "resize requires width, height, and scale fields (non-null, numbers)"}
                                    });
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        break;
                                    }
                                } else {
                                    let width = width_opt.unwrap();
                                    let height = height_opt.unwrap();
                                    let scale = scale_opt.unwrap();
                                    if let Err(_) = tx.send(SurfaceCommand::Resize { width, height, scale }).await {
                                        break;
                                    }
                                }
                            }
                            "screen.read" => {
                                if let Err(_) = tx.send(SurfaceCommand::ScreenRead).await {
                                    break;
                                }
                            }
                            "close" => {
                                if let Err(_) = tx.send(SurfaceCommand::SessionClose).await {
                                    break;
                                }
                            }
                            _ => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": format!("Unknown op: {}", op)}
                                });
                                if let Err(_) = output_tx.send(response.to_string()).await {
                                    break;
                                }
                            }
                        }
                    } else if body.get("image").and_then(|v| v.as_object()).is_some() {
                        // It's a host image response (image field is an object)
                        if let Err(_) = tx.send(SurfaceCommand::ImageResponse { body: body.clone() }).await {
                            break;
                        }
                    } else {
                        // No op and no image object - unknown message
                        let response = json!({
                            "surface": surface_id,
                            "body": {"error": "unknown op"}
                        });
                        if let Err(_) = output_tx.send(response.to_string()).await {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                let response = json!({
                    "surface": "",
                    "body": {"error": format!("Parse error: {}", e)}
                });
                if let Err(_) = output_tx.send(response.to_string()).await {
                    // Output channel closed; end serve
                    break;
                }
            }
        }
    }

    // Clean up all surfaces
    for (_, tx) in surface_txs.iter() {
        // Best effort close; intentionally ignore send errors (surface task may already be exiting)
        let _ = tx.send(SurfaceCommand::Close).await;
    }

    // Wait for all monitor tasks to complete
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
        let msg = tokio::time::timeout(Duration::from_secs(5), client.read_message())
            .await
            .map_err(|_| "Timeout waiting for open response".to_string())?
            .map_err(|e| format!("Failed to read response: {}", e))?
            .ok_or_else(|| "No response from daemon".to_string())?;

        let session_id = match msg {
            crate::daemon::DaemonMessage::Open(reply) => {
                if let Some(error) = reply.error {
                    return Err(format!("Daemon error: {}", error));
                }
                reply.session_id.ok_or_else(|| "No sessionId in response".to_string())?
            }
            _ => return Err("Expected open response, got different message".to_string()),
        };

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
                match reader.read_message().await {
                    Ok(Some(msg)) => {
                        match msg {
                            crate::daemon::DaemonMessage::Output { session_id, output, truncated, .. } => {
                                let data = match base64_decode(&output) {
                                    Ok(d) => d,
                                    Err(_) => output.into_bytes(),
                                };
                                // Intentionally ignore send error; receiver dropped means serve() is shutting down
                                let _ = events_tx.send(DaemonEvent::Output {
                                    session_id,
                                    data,
                                    truncated,
                                });
                            }
                            crate::daemon::DaemonMessage::Resized { .. } => {
                                // For now, just ignore resize messages from the daemon
                                // Resize is typically a request from client to daemon, not the other way
                            }
                            crate::daemon::DaemonMessage::Exit { session_id, .. } => {
                                // Intentionally ignore send error; receiver dropped means serve() is shutting down
                                let _ = events_tx.send(DaemonEvent::Exit { session_id });
                                break;
                            }
                            crate::daemon::DaemonMessage::Write(reply) | crate::daemon::DaemonMessage::Detach(reply) => {
                                // Discard responses for write, detach
                                if let Some(error) = reply.error {
                                    eprintln!("Daemon error for session {}: {}", sid, error);
                                }
                            }
                            crate::daemon::DaemonMessage::Open(reply) | crate::daemon::DaemonMessage::Attach(reply) |
                            crate::daemon::DaemonMessage::Resize(reply) | crate::daemon::DaemonMessage::Signal(reply) |
                            crate::daemon::DaemonMessage::Close(reply) | crate::daemon::DaemonMessage::List(reply) |
                            crate::daemon::DaemonMessage::Purge(reply) => {
                                // Discard other responses
                                if let Some(error) = reply.error {
                                    eprintln!("Daemon error for session {}: {}", sid, error);
                                }
                            }
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
                    // Intentionally ignore send error; receiver dropped means consumer is disconnected
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
