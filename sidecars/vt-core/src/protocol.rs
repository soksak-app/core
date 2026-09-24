use crate::encoding::{self, Key};
use crate::inline_image::{Dimension, InlineImageCommand};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant, MissedTickBehavior};

#[derive(Clone)]
struct OutputSink {
    sender: Arc<tokio::sync::Mutex<Option<mpsc::Sender<String>>>>,
}

impl OutputSink {
    fn direct(sender: mpsc::Sender<String>) -> Self {
        Self {
            sender: Arc::new(tokio::sync::Mutex::new(Some(sender))),
        }
    }

    async fn send(&self, message: String) -> Result<(), ()> {
        let sender = self.sender.lock().await.clone();
        match sender {
            Some(sender) => sender.send(message).await.map_err(|_| ()),
            None => Ok(()),
        }
    }

    async fn sender(&self) -> Option<mpsc::Sender<String>> {
        self.sender.lock().await.clone()
    }

    async fn replace_sender(&self, sender: Option<mpsc::Sender<String>>) {
        *self.sender.lock().await = sender;
    }
}

struct PersistentEntry {
    tx: mpsc::Sender<SurfaceCommand>,
    output: OutputSink,
    actor: tokio::task::JoinHandle<()>,
    epoch: u64,
    owner: String,
}

pub struct PersistentRegistry {
    entries: tokio::sync::Mutex<HashMap<String, PersistentEntry>>,
    next_epoch: std::sync::atomic::AtomicU64,
    shutdown: AtomicBool,
}

const SURFACE_ACTOR_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

async fn await_surface_actor(actor: tokio::task::JoinHandle<()>) -> Result<(), String> {
    match tokio::time::timeout(SURFACE_ACTOR_CLOSE_TIMEOUT, actor).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("surface actor join failed: {error}")),
        Err(_) => Err(format!(
            "surface actor close exceeded {:?}",
            SURFACE_ACTOR_CLOSE_TIMEOUT
        )),
    }
}

impl PersistentRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: tokio::sync::Mutex::new(HashMap::new()),
            next_epoch: std::sync::atomic::AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
        })
    }

    fn request_shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
    }

    pub(crate) fn shutdown_requested(&self) -> bool {
        self.shutdown.load(Ordering::Acquire)
    }

    async fn close_surface(&self, key: &str, owner: &str) -> Result<(), String> {
        let entry = {
            let mut entries = self.entries.lock().await;
            let Some(entry) = entries.get(key) else {
                return Ok(());
            };
            if entry.owner != owner {
                return Err("stale attachment".to_string());
            }
            entries.remove(key).expect("registry entry disappeared")
        };
        entry
            .tx
            .send(SurfaceCommand::SessionClose)
            .await
            .map_err(|_| "surface actor closed before close".to_string())?;
        let key = key.to_string();
        tokio::spawn(async move {
            if let Err(error) = await_surface_actor(entry.actor).await {
                eprintln!("persistent surface actor close failed for {key}: {error}");
            }
        });
        Ok(())
    }

    async fn close_owner(&self, owner: &str) -> Result<(), String> {
        let entries = {
            let mut registry = self.entries.lock().await;
            let keys = registry
                .iter()
                .filter_map(|(key, entry)| (entry.owner == owner).then_some(key.clone()))
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| registry.remove(&key))
                .collect::<Vec<_>>()
        };
        for entry in entries {
            entry
                .tx
                .send(SurfaceCommand::SessionClose)
                .await
                .map_err(|_| "surface actor closed before owner close".to_string())?;
            await_surface_actor(entry.actor).await?;
        }
        Ok(())
    }

    /// 이 소유자의 세션 가운데 keep 에 없는 세션을 닫고 닫은 수를 반환한다. 앱이 다시 시작한 뒤, 어떤
    /// 레이아웃에도 없는 표면의 세션은 다시 붙을 곳이 없다(docs/spec/terminal-runtime.md).
    async fn retain(
        &self,
        owner: &str,
        keep: &std::collections::HashSet<String>,
    ) -> Result<usize, String> {
        let entries = {
            let mut registry = self.entries.lock().await;
            let keys = registry
                .iter()
                .filter_map(|(key, entry)| {
                    (entry.owner == owner && !keep.contains(key)).then_some(key.clone())
                })
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| registry.remove(&key))
                .collect::<Vec<_>>()
        };
        let count = entries.len();
        for entry in entries {
            entry
                .tx
                .send(SurfaceCommand::SessionClose)
                .await
                .map_err(|_| "surface actor closed before retain".to_string())?;
            await_surface_actor(entry.actor).await?;
        }
        Ok(count)
    }

    async fn current_epoch(&self, key: &str, owner: &str) -> Option<u64> {
        let entries = self.entries.lock().await;
        entries
            .get(key)
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.epoch)
    }

    async fn contains(&self, key: &str) -> bool {
        self.entries.lock().await.contains_key(key)
    }

    async fn attach(
        &self,
        key: &str,
        owner: &str,
        output: &OutputSink,
    ) -> Result<(mpsc::Sender<SurfaceCommand>, u64), String> {
        let mut entries = self.entries.lock().await;
        let entry = entries
            .get_mut(key)
            .ok_or_else(|| "session surface not found".to_string())?;
        if entry.owner != owner {
            return Err("stale attachment".to_string());
        }
        entry.epoch = self
            .next_epoch
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        entry.output.replace_sender(output.sender().await).await;
        Ok((entry.tx.clone(), entry.epoch))
    }

    async fn insert(
        &self,
        key: String,
        owner: String,
        tx: mpsc::Sender<SurfaceCommand>,
        output: OutputSink,
        actor: tokio::task::JoinHandle<()>,
    ) -> Result<u64, String> {
        let mut entries = self.entries.lock().await;
        if entries.contains_key(&key) {
            tx.send(SurfaceCommand::SessionClose)
                .await
                .map_err(|error| format!("close duplicate surface: {error}"))?;
            await_surface_actor(actor)
                .await
                .map_err(|error| format!("join duplicate surface actor: {error}"))?;
            return Err("session surface already exists".to_string());
        }
        let epoch = self
            .next_epoch
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        entries.insert(
            key,
            PersistentEntry {
                tx,
                output,
                actor,
                epoch,
                owner,
            },
        );
        Ok(epoch)
    }
}

/// 엔진이 구현할 트레이트. VT 처리 엔진의 계약.
pub trait Engine: Send + 'static {
    fn resize(&mut self, cols: u16, rows: u16);
    fn set_theme(&mut self, theme: crate::palette::TerminalTheme);
    fn set_cell_metrics(&mut self, width: u16, height: u16) -> Result<(), String>;
    fn feed(&mut self, bytes: &[u8]);
    fn drain_events(&mut self) -> Vec<EngineEvent>;
    fn resolve_clipboard(&mut self, request_id: u64, text: &str) -> Result<(), String>;
    fn reject_clipboard(&mut self, request_id: u64, reason: &str) -> Result<(), String>;
    fn selection_start(&mut self, col: u16, row: u16) -> Result<(), String>;
    fn selection_update(&mut self, col: u16, row: u16) -> Result<(), String>;
    /// Ends the selection and returns its text. A selection that covers no text is cleared
    /// and returns `None`; that is a normal gesture, not an error.
    fn selection_end(&mut self) -> Result<Option<String>, String>;
    /// 현재 선택의 텍스트. 선택이 없거나 글자를 담지 않으면 `None` 이다.
    fn selection_text(&self) -> Option<String>;
    /// 기본 화면의 뷰포트를 lines 만큼 움직인다. 양수는 오래된 출력 쪽이다.
    fn scroll_viewport(&mut self, lines: i32);
    /// 뷰포트를 가장 새 출력으로 되돌리고, 움직였으면 true 를 반환한다.
    fn scroll_to_newest(&mut self) -> bool;
    fn cursor(&self) -> Cursor;
    fn screen(&mut self) -> Screen;
    fn scroll_generation(&self) -> i64 {
        0
    }
    /// 뷰포트가 가장 새 출력보다 위에 있는 줄 수. 스크롤백이 없는 엔진은 0 이다.
    fn viewport_offset(&self) -> u32 {
        0
    }
    fn modes(&self) -> Modes;
    fn reset(&mut self);
}

/// 엔진과 서비스 사이에서 전달하는 중립 이벤트.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineEvent {
    InlineImage(InlineImageCommand),
    Title(String),
    ResetTitle,
    Directory {
        uri: String,
        /// 이 컴퓨터의 디렉터리이면 그 경로, 다른 컴퓨터의 디렉터리이면 None.
        path: Option<String>,
    },
    Hyperlink {
        id: String,
        uri: Option<String>,
    },
    Notification {
        message: String,
    },
    ShellState {
        marker: ShellMarker,
        params: Vec<String>,
    },
    ClipboardStore {
        selection: ClipboardSelection,
        text: String,
    },
    ClipboardQuery {
        request_id: u64,
        selection: ClipboardSelection,
    },
    PtyWrite(Vec<u8>),
    CursorBlinkingChange,
    Wakeup,
    Bell,
    Exit,
    ChildExit {
        success: bool,
        code: Option<i32>,
    },
    MouseCursorDirty,
    Error(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellMarker {
    PromptStart,
    PromptEnd,
    CommandStart,
    CommandFinished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardSelection {
    Clipboard,
    Selection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CursorShape {
    Block,
    Underline,
    Beam,
    HollowBlock,
    Hidden,
}

impl Default for CursorShape {
    fn default() -> Self {
        Self::Block
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CursorBlinkPolicy {
    Never,
    Off,
    On,
    Always,
}

impl Default for CursorBlinkPolicy {
    fn default() -> Self {
        Self::Off
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnfocusedCursor {
    Hollow,
    Solid,
    Underline,
    Beam,
    Unchanged,
}

impl Default for UnfocusedCursor {
    fn default() -> Self {
        Self::Hollow
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorPolicy {
    pub shape: CursorShape,
    pub blink: CursorBlinkPolicy,
    pub interval_ms: u64,
    pub idle_timeout_ms: u64,
    pub unfocused: UnfocusedCursor,
}

impl Default for CursorPolicy {
    fn default() -> Self {
        Self {
            shape: CursorShape::Block,
            blink: CursorBlinkPolicy::Off,
            interval_ms: 750,
            idle_timeout_ms: 5000,
            unfocused: UnfocusedCursor::Hollow,
        }
    }
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
    #[serde(default)]
    pub shape: CursorShape,
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default)]
    pub blinking: bool,
    #[serde(rename = "blinkVisible", default = "default_blink_visible")]
    pub blink_visible: bool,
    #[serde(default)]
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preedit: Option<Preedit>,
}

fn default_visible() -> bool {
    true
}

fn default_blink_visible() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct JsonRange {
    pub location: usize,
    pub length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Preedit {
    pub text: String,
    #[serde(
        rename = "selectedRange",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub selected_range: Option<JsonRange>,
    #[serde(
        rename = "replacementRange",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub replacement_range: Option<JsonRange>,
    #[serde(default)]
    pub attributed: bool,
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
    pub focus_in_out: bool,
    #[serde(default)]
    pub utf8_mouse: bool,
    #[serde(default)]
    pub sgr_mouse: bool,
    #[serde(default)]
    pub alternate_scroll: bool,
    #[serde(default)]
    pub alt_screen: bool,
}

/// 뷰포트가 가장 새 출력보다 위에 있는 줄 수와 보관된 기록 줄 수.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Scrollback {
    pub offset: u32,
    pub history: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Screen {
    pub cols: u16,
    pub rows: u16,
    pub cursor: Cursor,
    #[serde(default)]
    pub scrollback: Scrollback,
    /// 현재 기본 배경색(`#rrggbb`). 프로그램이 OSC 11 로 바꾼 값을 포함한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<Vec<Cell>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineImagePlacement {
    pub name: String,
    pub data: Vec<u8>,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub preserve_aspect_ratio: bool,
    pub anchor_row: i32,
    pub anchor_scroll: i64,
    pub visible: bool,
}

/// 데몬에서 받는 이벤트
#[derive(Debug, Clone)]
pub enum DaemonEvent {
    Output {
        session_id: String,
        data: Vec<u8>,
        sequence: i64,
        truncated: bool,
    },
    Exit {
        session_id: String,
    },
    Error {
        session_id: String,
        error: String,
    },
}

/// 세션 포트: 데몬과 통신하는 추상 인터페이스
/// 세션을 여는 요청의 셸과 시작 디렉터리.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellRequest {
    /// 터미널 설정 shell 의 값. `login` 이거나 셸의 절대 경로다.
    pub shell: String,
    /// 셸이 시작할 디렉터리의 절대 경로. 없으면 계정의 홈 디렉터리다.
    pub directory: Option<String>,
}

#[async_trait]
pub trait SessionPort: Send + Sync {
    async fn open(&self, request: &ShellRequest, cols: u16, rows: u16) -> Result<String, String>;
    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String>;
    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String>;
    async fn detach(&self, session_id: &str) -> Result<(), String>;
    async fn close(&self, session_id: &str) -> Result<(), String>;
    /// Attach a new view to an existing session and replay retained output.
    async fn attach(&self, _session_id: &str, _from: i64) -> Result<String, String> {
        Err("session attach is not supported".to_string())
    }
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
    Open {
        image: Option<String>,
        request: ShellRequest,
    },
    Reconnect,
    Configure(ImageConfiguration),
    Input {
        bytes: Vec<u8>,
    },
    InputKeys {
        keys: Vec<InputKey>,
    },
    Paste {
        text: String,
    },
    Compose {
        preedit: Option<Preedit>,
    },
    Focus {
        focused: bool,
    },
    Theme {
        theme: crate::palette::TerminalTheme,
    },
    Font {
        font: std::sync::Arc<crate::platform::TerminalFont>,
        system: bool,
        skipped: Vec<String>,
        /// 글꼴 크기(포인트).
        size: f32,
    },
    Cursor {
        policy: CursorPolicy,
    },
    Command {
        selector: String,
    },
    ScreenRead,
    SessionClose,
    SessionDetach,
    ImageResponse {
        body: Value,
    },
    ClipboardResolve {
        request_id: u64,
        text: String,
    },
    ClipboardReject {
        request_id: u64,
        reason: String,
    },
    InlineImageDelete {
        name: String,
    },
    SelectionStart {
        x: f64,
        y: f64,
    },
    SelectionUpdate {
        x: f64,
        y: f64,
    },
    SelectionEnd,
    /// 사용자의 복사 명령. 현재 선택의 텍스트를 copy 이벤트로 보낸다.
    Copy,
    /// 휠 스크롤. lines 는 0 이 아니며 양수는 오래된 출력 쪽이다. col, row 는 포인터 칸이다.
    Scroll {
        lines: i32,
        col: u16,
        row: u16,
    },
    /// 스크롤바 끌기. 기본 뷰포트를 이 오프셋으로 옮기며 프로그램에는 쓰지 않는다.
    Viewport {
        offset: u32,
    },
}

#[derive(Debug, Clone)]
struct ImageConfiguration {
    name: String,
    generation: u64,
    raster: u64,
    width: u32,
    height: u32,
    scale: f32,
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

fn decorate_screen(
    mut screen: Screen,
    focused: bool,
    preedit: &Option<Preedit>,
    policy: &CursorPolicy,
    elapsed_ms: u64,
) -> Screen {
    let program_shape = screen.cursor.shape;
    if program_shape == CursorShape::Block {
        screen.cursor.shape = policy.shape;
    }
    screen.cursor.focused = focused;
    screen.cursor.blink_visible = crate::platform::darwin::frame::cursor_blink_visible(
        policy.blink,
        screen.cursor.blinking,
        focused,
        elapsed_ms,
        policy.interval_ms,
        policy.idle_timeout_ms,
    );
    if !focused {
        screen.cursor.shape = crate::platform::darwin::frame::effective_cursor_shape(
            screen.cursor.shape,
            false,
            policy.unfocused,
        );
    }
    screen.cursor.preedit = preedit.clone();
    screen
}

fn parse_cursor_policy(body: &Value) -> Result<CursorPolicy, String> {
    let defaults = CursorPolicy::default();
    let shape = match body.get("shape").and_then(Value::as_str) {
        None => defaults.shape,
        Some("block") => CursorShape::Block,
        Some("underline") => CursorShape::Underline,
        Some("beam") => CursorShape::Beam,
        Some(value) => {
            return Err(format!(
                "cursor.shape must be block, underline, or beam: {value}"
            ))
        }
    };
    let blink = match body.get("blink").and_then(Value::as_str) {
        None => defaults.blink,
        Some("Never") => CursorBlinkPolicy::Never,
        Some("Off") => CursorBlinkPolicy::Off,
        Some("On") => CursorBlinkPolicy::On,
        Some("Always") => CursorBlinkPolicy::Always,
        Some(value) => {
            return Err(format!(
                "cursor.blink must be Never, Off, On, or Always: {value}"
            ))
        }
    };
    let interval_ms = match body.get("interval") {
        None => defaults.interval_ms,
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or_else(|| "cursor.interval must be a positive integer".to_string())?,
    };
    let idle_timeout_ms = match body.get("idleTimeout") {
        None => defaults.idle_timeout_ms,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| "cursor.idleTimeout must be a nonnegative integer".to_string())?,
    };
    let unfocused = match body.get("unfocused").and_then(Value::as_str) {
        None => defaults.unfocused,
        Some("hollow") => UnfocusedCursor::Hollow,
        Some("solid") => UnfocusedCursor::Solid,
        Some("underline") => UnfocusedCursor::Underline,
        Some("beam") => UnfocusedCursor::Beam,
        Some("unchanged") => UnfocusedCursor::Unchanged,
        Some(value) => return Err(format!("cursor.unfocused is invalid: {value}")),
    };
    Ok(CursorPolicy {
        shape,
        blink,
        interval_ms,
        idle_timeout_ms,
        unfocused,
    })
}

fn pixels_to_cells(pixels: u32, cell_size: f32) -> u16 {
    (pixels as f32 / cell_size) as u16
}

fn set_engine_metrics(engine: &mut Box<dyn Engine>, state: &ImageState) -> Result<(), String> {
    let width = (state.metrics.cell_width / state.scale).round() as u16;
    let height = (state.metrics.cell_height / state.scale).round() as u16;
    engine.set_cell_metrics(width, height)
}

/// Validate and calculate terminal size. Returns error if width/height invalid or result is 0.
fn calculate_terminal_size(
    width: u32,
    height: u32,
    metrics: &crate::platform::platform::Metrics,
) -> Result<(u16, u16), String> {
    if width == 0 || height == 0 {
        return Err("width and height must be positive".to_string());
    }

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
                    encoding::encode_ctrl_char(ch).map_err(|error| {
                        format!(
                            "unknown key: Char with ctrl: {:?} (text {:?}, U+{:04X})",
                            error, ch, ch as u32
                        )
                    })?
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
/// 글꼴 크기의 기본값과 범위(포인트). 기본 크기에 프레임과 카드의 글자 배율(각각 최대 3)을 곱한 값이 범위 안에
/// 든다(docs/spec/text-size.md).
const DEFAULT_FONT_SIZE: f32 = 13.0;
const FONT_SIZE_MIN: f64 = 4.0;
const FONT_SIZE_MAX: f64 = 128.0;

/// 화면 이벤트 본문. 뷰포트의 줄, 커서, 스크롤백 상태를 담는다.
fn screen_event(surface_id: &str, screen: &Screen) -> Value {
    json!({
        "surface": surface_id,
        "body": {
            "event": "screen",
            "cols": screen.cols,
            "rows": screen.rows,
            "cursor": screen.cursor,
            "lines": screen.lines,
            "scrollback": screen.scrollback,
            "background": screen.background
        }
    })
}

async fn present_screen(
    surface_id: &str,
    screen: &Screen,
    state: &mut ImageState,
    output_tx: &OutputSink,
) -> bool {
    // 호스트는 표시 요청의 래스터를 복사한 뒤 consumed 로 답한다. 답을 받기 전에 같은 래스터에 다시 그리면
    // 복사 중인 픽셀을 덮어 글자가 빠진 프레임이 표시된다. 그 동안의 화면은 dirty 로 남겨 답을 받은 뒤 그린다.
    if state.pending_draw {
        state.dirty = true;
        return true;
    }
    if let Err(reason) = state.frame.draw_with_theme_and_inline_images(
        screen,
        &state.metrics,
        crate::platform::darwin::frame::CursorRender::from_protocol(&screen.cursor),
        &state.theme,
        &state.inline_images,
    ) {
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
                "generation": state.generation,
                "raster": state.raster,
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

async fn send_state(
    surface_id: &str,
    session_id: &str,
    cols: u16,
    rows: u16,
    state: &ImageState,
    output_tx: &OutputSink,
) -> bool {
    let response = json!({
        "surface": surface_id,
        "body": {
            "event": "state", "sessionId": session_id, "cols": cols, "rows": rows,
            "cursor": {"col": 0, "row": 0},
            "cellWidth": state.metrics.cell_width / state.scale,
            "cellHeight": state.metrics.cell_height / state.scale
        }
    });
    output_tx.send(response.to_string()).await.is_ok()
}

fn clipboard_selection_name(selection: ClipboardSelection) -> &'static str {
    match selection {
        ClipboardSelection::Clipboard => "clipboard",
        ClipboardSelection::Selection => "selection",
    }
}

struct MultipartAssembly {
    name: String,
    data: Vec<u8>,
}

fn resolve_inline_dimension(dimension: &Dimension, cell_size: u32, frame_size: u32) -> u32 {
    match dimension {
        Dimension::Auto => 0,
        Dimension::Cells(value) => cell_size.saturating_mul(*value),
        Dimension::Pixels(value) => *value,
        Dimension::Percent(value) => frame_size.saturating_mul(u32::from(*value)) / 100,
    }
}

fn store_inline_display(
    command: InlineImageCommand,
    engine: &mut Box<dyn Engine>,
    image_state: &mut Option<ImageState>,
) -> Result<(), String> {
    let InlineImageCommand::Display {
        name,
        data,
        width,
        height,
        preserve_aspect_ratio,
    } = command
    else {
        return Err("inline image command is not a display record".to_string());
    };
    let Some(state) = image_state.as_mut() else {
        return Err("inline image received before the image region was configured".to_string());
    };
    let cursor = engine.screen().cursor;
    let scroll = engine.scroll_generation();
    let placement = InlineImagePlacement {
        name: name.clone(),
        data,
        x: u32::from(cursor.col).saturating_mul(state.metrics.cell_width.round() as u32),
        y: u32::from(cursor.row).saturating_mul(state.metrics.cell_height.round() as u32),
        width: resolve_inline_dimension(
            &width,
            state.metrics.cell_width.round() as u32,
            state.width_px,
        ),
        height: resolve_inline_dimension(
            &height,
            state.metrics.cell_height.round() as u32,
            state.height_px,
        ),
        preserve_aspect_ratio,
        anchor_row: i32::from(cursor.row),
        anchor_scroll: scroll,
        visible: true,
    };
    if let Some(existing) = state
        .inline_images
        .iter_mut()
        .find(|image| image.name == name)
    {
        *existing = placement;
    } else {
        state.inline_images.push(placement);
    }
    Ok(())
}

fn refresh_inline_image_positions(
    engine: &mut Box<dyn Engine>,
    image_state: &mut Option<ImageState>,
) {
    let Some(state) = image_state.as_mut() else {
        return;
    };
    let current_scroll = engine.scroll_generation();
    // 스크롤백을 보는 동안 뷰포트는 그만큼 아래로 내려간 행을 보인다.
    let offset = engine.viewport_offset() as i32;
    let cell_height = state.metrics.cell_height.round() as u32;
    for image in &mut state.inline_images {
        let row = image.anchor_row - (current_scroll - image.anchor_scroll) as i32 + offset;
        image.visible = row >= 0;
        image.y = if row >= 0 {
            (row as u32).saturating_mul(cell_height)
        } else {
            state.height_px
        };
    }
}

fn apply_inline_image_command(
    command: InlineImageCommand,
    engine: &mut Box<dyn Engine>,
    image_state: &mut Option<ImageState>,
    multipart: &mut Option<MultipartAssembly>,
) -> Result<(), String> {
    match command {
        InlineImageCommand::Display { .. } => store_inline_display(command, engine, image_state),
        InlineImageCommand::Transfer { .. } => Ok(()),
        InlineImageCommand::MultipartStart { name } => {
            if multipart.is_some() {
                return Err("inline image multipart transfer is already active".to_string());
            }
            *multipart = Some(MultipartAssembly {
                name,
                data: Vec::new(),
            });
            Ok(())
        }
        InlineImageCommand::MultipartPart(data) => {
            let Some(assembly) = multipart.as_mut() else {
                return Err("inline image multipart part has no active transfer".to_string());
            };
            if assembly.data.len().saturating_add(data.len()) > crate::inline_image::MAX_IMAGE_BYTES
            {
                return Err(format!(
                    "inline image multipart payload exceeds {} bytes",
                    crate::inline_image::MAX_IMAGE_BYTES
                ));
            }
            assembly.data.extend_from_slice(&data);
            Ok(())
        }
        InlineImageCommand::MultipartEnd => {
            let Some(assembly) = multipart.take() else {
                return Err("inline image multipart end has no active transfer".to_string());
            };
            if assembly.data.is_empty() {
                return Err("inline image multipart transfer has no data".to_string());
            }
            store_inline_display(
                InlineImageCommand::Display {
                    name: assembly.name,
                    data: assembly.data,
                    width: Dimension::Auto,
                    height: Dimension::Auto,
                    preserve_aspect_ratio: true,
                },
                engine,
                image_state,
            )
        }
    }
}

async fn send_engine_events(
    surface_id: &str,
    session_id: Option<&str>,
    engine: &mut Box<dyn Engine>,
    session_port: &Arc<dyn SessionPort>,
    output_tx: &OutputSink,
    emit_surface_events: bool,
    image_state: &mut Option<ImageState>,
    multipart: &mut Option<MultipartAssembly>,
) -> bool {
    for event in engine.drain_events() {
        match event {
            EngineEvent::InlineImage(command) => {
                let command_for_event = command.clone();
                if let Err(error) =
                    apply_inline_image_command(command, engine, image_state, multipart)
                {
                    if !emit_surface_events {
                        continue;
                    }
                    let response = json!({
                        "surface": surface_id,
                        "body": {"event": "error", "reason": error}
                    });
                    if output_tx.send(response.to_string()).await.is_err() {
                        return false;
                    }
                    continue;
                }
                if !emit_surface_events {
                    continue;
                }
                let body = match command_for_event {
                    InlineImageCommand::Display {
                        name,
                        data,
                        width,
                        height,
                        preserve_aspect_ratio,
                    } => json!({
                        "event": "image.inline",
                        "command": "display",
                        "name": name,
                        "data": base64_encode(&data),
                        "width": inline_dimension(&width),
                        "height": inline_dimension(&height),
                        "preserveAspectRatio": preserve_aspect_ratio,
                    }),
                    InlineImageCommand::Transfer { name, data } => json!({
                        "event": "image.inline",
                        "command": "transfer",
                        "name": name,
                        "data": base64_encode(&data),
                    }),
                    InlineImageCommand::MultipartStart { name } => json!({
                        "event": "image.inline",
                        "command": "multipart.start",
                        "name": name,
                    }),
                    InlineImageCommand::MultipartPart(data) => json!({
                        "event": "image.inline",
                        "command": "multipart.part",
                        "data": base64_encode(&data),
                    }),
                    InlineImageCommand::MultipartEnd => json!({
                        "event": "image.inline",
                        "command": "multipart.end",
                    }),
                };
                if output_tx
                    .send(json!({"surface": surface_id, "body": body}).to_string())
                    .await
                    .is_err()
                {
                    return false;
                }
            }
            EngineEvent::PtyWrite(bytes) => {
                let Some(session_id) = session_id else {
                    let response = json!({"surface": surface_id, "body": {"error": "engine response without session"}});
                    return output_tx.send(response.to_string()).await.is_ok();
                };
                if let Err(error) = session_port.write(session_id, &bytes).await {
                    let response = json!({"surface": surface_id, "body": {"error": "engine response write failed", "reason": error}});
                    return output_tx.send(response.to_string()).await.is_ok();
                }
            }
            EngineEvent::Title(title) => {
                if !emit_surface_events {
                    continue;
                }
                let response =
                    json!({"surface": surface_id, "body": {"event": "title", "title": title}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::ResetTitle => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "title.reset"}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Directory { uri, path } => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "directory", "uri": uri, "path": path}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Hyperlink { id, uri } => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "hyperlink", "id": id, "uri": uri}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Notification { message } => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "notification", "message": message}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::ShellState { marker, params } => {
                if !emit_surface_events {
                    continue;
                }
                let marker = match marker {
                    ShellMarker::PromptStart => "prompt.start",
                    ShellMarker::PromptEnd => "prompt.end",
                    ShellMarker::CommandStart => "command.start",
                    ShellMarker::CommandFinished => "command.finished",
                };
                let response = json!({"surface": surface_id, "body": {"event": "vendor.shell.state", "marker": marker, "params": params}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::ClipboardStore { selection, text } => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "clipboard.store", "selection": clipboard_selection_name(selection), "text": text}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::ClipboardQuery {
                request_id,
                selection,
            } => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "clipboard.query", "requestId": request_id, "selection": clipboard_selection_name(selection)}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::CursorBlinkingChange => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "cursor.blinking"}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Wakeup => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "wakeup"}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Bell => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "bell"}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Exit => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "exit"}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::ChildExit { success, code } => {
                if !emit_surface_events {
                    continue;
                }
                let response = json!({"surface": surface_id, "body": {"event": "child.exit", "success": success, "code": code}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::MouseCursorDirty => {
                if !emit_surface_events {
                    continue;
                }
                let response =
                    json!({"surface": surface_id, "body": {"event": "mouse.cursor.dirty"}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
            EngineEvent::Error(reason) => {
                if !emit_surface_events {
                    continue;
                }
                let response =
                    json!({"surface": surface_id, "body": {"event": "error", "reason": reason}});
                if output_tx.send(response.to_string()).await.is_err() {
                    return false;
                }
            }
        }
    }
    refresh_inline_image_positions(engine, image_state);
    true
}

fn inline_dimension(dimension: &Dimension) -> Value {
    match dimension {
        Dimension::Auto => Value::String("auto".to_string()),
        Dimension::Cells(value) => json!(value),
        Dimension::Pixels(value) => Value::String(format!("{value}px")),
        Dimension::Percent(value) => Value::String(format!("{value}%")),
    }
}

async fn open_headless(
    shell: &ShellRequest,
    session_id: &mut Option<String>,
    engine: &mut Box<dyn Engine>,
    session_port: &Arc<dyn SessionPort>,
    output_tx: &OutputSink,
) -> bool {
    if session_id.is_some() {
        return true;
    }
    engine.resize(80, 24);
    match session_port.open(shell, 80, 24).await {
        Ok(id) => {
            *session_id = Some(id);
            true
        }
        Err(error) => {
            let response =
                json!({"body": {"error": format!("Failed to open headless session: {error}")}});
            output_tx.send(response.to_string()).await.is_ok()
        }
    }
}

async fn open_if_configured(
    surface_id: &str,
    requested: bool,
    requested_image: &Option<String>,
    shell: &ShellRequest,
    session_id: &mut Option<String>,
    engine: &mut Box<dyn Engine>,
    image_state: &mut Option<ImageState>,
    session_port: &Arc<dyn SessionPort>,
    output_tx: &OutputSink,
) -> bool {
    if !requested || session_id.is_some() {
        return true;
    }
    let Some(state) = image_state.as_mut() else {
        return true;
    };
    if requested_image
        .as_ref()
        .is_some_and(|name| name != &state.name)
    {
        return true;
    }
    let (cols, rows) = match calculate_terminal_size(
        state.width_px,
        state.height_px,
        &state.metrics,
    ) {
        Ok(size) => size,
        Err(reason) => {
            let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": reason}});
            return output_tx.send(response.to_string()).await.is_ok();
        }
    };
    engine.resize(cols, rows);
    if let Err(error) = set_engine_metrics(engine, state) {
        let response = json!({"surface": surface_id, "body": {"error": "invalid renderer metrics", "reason": error}});
        return output_tx.send(response.to_string()).await.is_ok();
    }
    match session_port.open(shell, cols, rows).await {
        Ok(sid) => {
            *session_id = Some(sid.clone());
            if !send_state(surface_id, &sid, cols, rows, state, output_tx).await {
                return false;
            }
            let screen = engine.screen();
            present_screen(surface_id, &screen, state, output_tx).await
        }
        Err(error) => {
            let response = json!({"surface": surface_id, "body": {"error": format!("Failed to open: {error}")}});
            output_tx.send(response.to_string()).await.is_ok()
        }
    }
}

fn newer_configuration(configuration: &ImageConfiguration, state: &ImageState) -> bool {
    (configuration.generation, configuration.raster) > (state.generation, state.raster)
}

/// retain 요청의 surfaces 목록 `[{surface, root}]` 을 세션 키로 바꾼다. 형식이 틀리면 오류다.
fn retain_keys(value: &Value) -> Result<std::collections::HashSet<String>, String> {
    let surfaces = value
        .get("surfaces")
        .and_then(Value::as_array)
        .ok_or("retain requires a surfaces array")?;
    surfaces
        .iter()
        .map(|item| {
            let surface = item.get("surface").and_then(Value::as_str);
            let root = item.get("root").and_then(Value::as_str);
            match (surface, root) {
                (Some(surface), Some(root)) if !surface.is_empty() && !root.is_empty() => {
                    Ok(format!("{root}\0{surface}"))
                }
                _ => Err(format!("retain surface entry is invalid: {item}")),
            }
        })
        .collect()
}

fn local_surface_key(
    surface_txs: &HashMap<String, mpsc::Sender<SurfaceCommand>>,
    root: Option<&str>,
    surface: &str,
) -> String {
    if let Some(root) = root {
        return format!("{root}\0{surface}");
    }
    surface_txs
        .keys()
        .find(|key| key.ends_with(&format!("\0{surface}")))
        .cloned()
        .unwrap_or_else(|| format!("\0{surface}"))
}

/// 표면별 비동기 작업. 엔진과 데몬 연결을 소유하며 명령을 처리한다.
async fn surface_task(
    surface_id: String,
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    session_port: Arc<dyn SessionPort>,
    mut cmd_rx: mpsc::Receiver<SurfaceCommand>,
    output_tx: OutputSink,
) {
    let mut engine = engine_factory();
    let mut session_id: Option<String> = None;
    let mut daemon_events_rx = session_port.get_events().await;
    let mut image_state: Option<ImageState> = None;
    let mut preserved_inline_images = Vec::new();
    let mut multipart: Option<MultipartAssembly> = None;
    let mut open_requested = false;
    let mut requested_image: Option<String> = None;
    let mut requested_shell = ShellRequest::default();
    let mut headless = false;
    let mut pending_configuration: Option<ImageConfiguration> = None;
    let mut focused = false;
    let mut preedit: Option<Preedit> = None;
    let mut current_theme = crate::palette::TerminalTheme::dark();
    let mut cursor_policy = CursorPolicy::default();
    // 이 표면의 터미널 글꼴. font 요청 전까지 시스템 고정폭 글꼴이다.
    let mut terminal_font = crate::platform::default_font();
    // 글꼴 크기(포인트). font 연산이 정한다(docs/spec/text-size.md).
    let mut terminal_font_size = DEFAULT_FONT_SIZE;
    let mut cursor_activity = Instant::now();
    let mut cursor_tick = tokio::time::interval(Duration::from_millis(50));
    cursor_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_cursor_frame: Option<(CursorShape, bool, bool, bool)> = None;

    loop {
        tokio::select! {
            _ = cursor_tick.tick(), if image_state.is_some() && !headless => {
                let screen = decorate_screen(
                    engine.screen(),
                    focused,
                    &preedit,
                    &cursor_policy,
                    cursor_activity.elapsed().as_millis() as u64,
                );
                let signature = (
                    screen.cursor.shape,
                    screen.cursor.blink_visible,
                    screen.cursor.focused,
                    screen.cursor.visible,
                );
                if last_cursor_frame != Some(signature) {
                    if let Some(state) = image_state.as_mut() {
                        if state.pending_draw {
                            state.dirty = true;
                        } else if !present_screen(&surface_id, &screen, state, &output_tx).await {
                            return;
                        } else {
                            last_cursor_frame = Some(signature);
                        }
                    }
                }
            }
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    SurfaceCommand::Open { image, request } => {
                        open_requested = true;
                        requested_image = image;
                        requested_shell = request;
                        headless = requested_image.is_none();
                        if headless && !open_headless(&requested_shell, &mut session_id, &mut engine, &session_port, &output_tx).await { return; }
                        if !open_if_configured(&surface_id, open_requested, &requested_image, &requested_shell, &mut session_id,
                            &mut engine, &mut image_state, &session_port, &output_tx).await {
                            return;
                        }
                    }
                    SurfaceCommand::Reconnect => {
                        // PTY and VT state belong to the persistent session;
                        // the IOSurface belongs to the application instance.
                        // Discard only the old native image so the reconnecting
                        // client must provide a fresh Configure message.
                        if let Some(previous_state) = image_state.take() {
                            preserved_inline_images = previous_state.inline_images;
                        }
                        pending_configuration = None;
                        if !headless {
                            if let Some(session_id) = session_id.as_deref() {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"event": "session", "sessionId": session_id}
                            });
                            if output_tx.send(response.to_string()).await.is_err() {
                                return;
                            }
                            }
                        }
                    }
                    SurfaceCommand::Configure(configuration) => {
                        if let Some(state) = image_state.as_ref() {
                            if !newer_configuration(&configuration, state) {
                                continue;
                            }
                            if state.pending_draw {
                                let replace = pending_configuration.as_ref().map_or(true, |pending|
                                    (configuration.generation, configuration.raster) > (pending.generation, pending.raster));
                                if replace { pending_configuration = Some(configuration); }
                                continue;
                            }
                        }
                        let new_state = match ImageState::new(configuration.name.clone(), configuration.generation,
                            configuration.raster, configuration.width, configuration.height, configuration.scale, &terminal_font, terminal_font_size) {
                            Ok(state) => state,
                            Err(reason) => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": "image creation failed", "reason": reason}
                                });
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                                continue;
                            }
                        };
                        let mut new_state = new_state;
                        new_state.theme = current_theme;
                        new_state.inline_images = image_state.as_ref()
                            .map(|previous_state| previous_state.inline_images.clone())
                            .unwrap_or_else(|| std::mem::take(&mut preserved_inline_images));
                        let (cols, rows) = match calculate_terminal_size(
                            configuration.width, configuration.height, &new_state.metrics) {
                            Ok(size) => size,
                            Err(reason) => {
                                let response = json!({"surface": surface_id,
                                    "body": {"error": "invalidParams", "reason": reason}});
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                                continue;
                            }
                        };
                        engine.resize(cols, rows);
                        if let Err(error) = set_engine_metrics(&mut engine, &new_state) {
                            let response = json!({"surface": surface_id, "body": {"error": "invalid renderer metrics", "reason": error}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                            continue;
                        }
                        image_state = Some(new_state);
                        refresh_inline_image_positions(&mut engine, &mut image_state);
                        if let Some(sid) = session_id.as_ref() {
                            if let Err(error) = session_port.resize(sid, cols, rows).await {
                                let response = json!({"surface": surface_id,
                                    "body": {"error": format!("Resize failed: {error}")}});
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                            } else if !send_state(&surface_id, sid, cols, rows, image_state.as_ref().unwrap(), &output_tx).await {
                                return;
                            }
                            let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                            if !present_screen(&surface_id, &screen, image_state.as_mut().unwrap(), &output_tx).await {
                                return;
                            }
                        } else if !open_if_configured(&surface_id, open_requested, &requested_image, &requested_shell, &mut session_id,
                            &mut engine, &mut image_state, &session_port, &output_tx).await {
                            return;
                        }
                    }
                    SurfaceCommand::Input { bytes } => {
                        cursor_activity = Instant::now();
                        last_cursor_frame = None;
                        // 입력은 뷰포트를 가장 새 출력으로 되돌린 뒤 쓴다.
                        if engine.scroll_to_newest() {
                            refresh_inline_image_positions(&mut engine, &mut image_state);
                            let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                            if let Some(state) = image_state.as_mut() {
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                            if output_tx.send(screen_event(&surface_id, &screen).to_string()).await.is_err() { return; }
                        }
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
                    SurfaceCommand::Paste { text } => {
                        cursor_activity = Instant::now();
                        last_cursor_frame = None;
                        // 입력은 뷰포트를 가장 새 출력으로 되돌린 뒤 쓴다.
                        if engine.scroll_to_newest() {
                            refresh_inline_image_positions(&mut engine, &mut image_state);
                            let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                            if let Some(state) = image_state.as_mut() {
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                            if output_tx.send(screen_event(&surface_id, &screen).to_string()).await.is_err() { return; }
                        }
                        if let Some(ref sid) = session_id {
                            let bytes = match encoding::encode_paste(&text, &engine.modes()) {
                                Ok(bytes) => bytes,
                                Err(error) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": error}
                                    });
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        return;
                                    }
                                    continue;
                                }
                            };
                            match session_port.write(sid, &bytes).await {
                                Ok(()) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"ack": true, "event": "paste"}
                                    });
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        return;
                                    }
                                }
                                Err(error) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": format!("Paste failed: {error}")}
                                    });
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        return;
                                    }
                                }
                            }
                        } else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "Session not open"}
                            });
                            if output_tx.send(response.to_string()).await.is_err() {
                                return;
                            }
                        }
                    }
                    SurfaceCommand::SelectionStart { x, y } => {
                        let result = image_state.as_ref().ok_or_else(|| "selection image is not configured".to_string())
                            .and_then(|state| state.selection_cell(x, y))
                            .and_then(|(col, row)| engine.selection_start(col, row));
                        if let Err(error) = result {
                            let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": error}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        } else {
                            cursor_activity = Instant::now();
                            last_cursor_frame = None;
                            if let Some(state) = image_state.as_mut() {
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                            let response = json!({"surface": surface_id, "body": {"ack": true, "event": "selection.start"}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        }
                    }
                    SurfaceCommand::SelectionUpdate { x, y } => {
                        let result = image_state.as_ref().ok_or_else(|| "selection image is not configured".to_string())
                            .and_then(|state| state.selection_cell(x, y))
                            .and_then(|(col, row)| engine.selection_update(col, row));
                        if let Err(error) = result {
                            let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": error}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        } else {
                            cursor_activity = Instant::now();
                            last_cursor_frame = None;
                            if let Some(state) = image_state.as_mut() {
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                            let response = json!({"surface": surface_id, "body": {"ack": true, "event": "selection.update"}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        }
                    }
                    SurfaceCommand::SelectionEnd => {
                        match engine.selection_end() {
                            Ok(text) => {
                                if let Some(state) = image_state.as_mut() {
                                    let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                                    if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                                }
                                // A selection without text copies nothing and reports the release.
                                let body = match text {
                                    Some(text) => json!({"event": "selection.copy", "text": text, "userInitiated": true}),
                                    None => json!({"event": "selection.end", "copied": false}),
                                };
                                let response = json!({"surface": surface_id, "body": body});
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                            }
                            Err(error) => {
                                let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": error}});
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                            }
                        }
                    }
                    SurfaceCommand::Viewport { offset } => {
                        // 엔진이 보관된 기록 범위 안으로 제한한다.
                        let delta = i64::from(offset) - i64::from(engine.viewport_offset());
                        if delta != 0 {
                            engine.scroll_viewport(delta.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32);
                        }
                        refresh_inline_image_positions(&mut engine, &mut image_state);
                        let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                        if let Some(state) = image_state.as_mut() {
                            if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                        }
                        if output_tx.send(screen_event(&surface_id, &screen).to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::Scroll { lines, col, row } => {
                        let modes = engine.modes();
                        // 마우스 보고, 대체 화면의 대체 스크롤, 기본 화면의 뷰포트 순으로 적용한다.
                        let bytes = if modes.mouse_report {
                            match encoding::encode_wheel(&modes, lines > 0, col, row) {
                                Ok(event) => Some(event.repeat(lines.unsigned_abs() as usize)),
                                Err(error) => {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": error}});
                                    if output_tx.send(response.to_string()).await.is_err() { return; }
                                    continue;
                                }
                            }
                        } else if modes.alt_screen && modes.alternate_scroll {
                            let key = if lines > 0 { "Up" } else { "Down" };
                            let keys = vec![InputKey { key: key.to_string(), text: String::new(), shift: false, alt: false, ctrl: false }; lines.unsigned_abs() as usize];
                            match encode_keys(&keys, &modes) {
                                Ok(bytes) => Some(bytes),
                                Err(error) => {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": error}});
                                    if output_tx.send(response.to_string()).await.is_err() { return; }
                                    continue;
                                }
                            }
                        } else {
                            None
                        };
                        match bytes {
                            Some(bytes) => {
                                if let Some(ref sid) = session_id {
                                    if let Err(error) = session_port.write(sid, &bytes).await {
                                        let response = json!({"surface": surface_id, "body": {"error": "scroll write failed", "reason": error}});
                                        if output_tx.send(response.to_string()).await.is_err() { return; }
                                    }
                                }
                            }
                            None => {
                                engine.scroll_viewport(lines);
                                refresh_inline_image_positions(&mut engine, &mut image_state);
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                                if let Some(state) = image_state.as_mut() {
                                    if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                                }
                                if output_tx.send(screen_event(&surface_id, &screen).to_string()).await.is_err() { return; }
                            }
                        }
                    }
                    SurfaceCommand::Copy => {
                        // 선택이 없으면 복사하지 않고 그렇다고 알린다. 클립보드는 바꾸지 않는다.
                        let body = match engine.selection_text() {
                            Some(text) => json!({"event": "copy", "text": text, "userInitiated": true}),
                            None => json!({"event": "copy", "copied": false}),
                        };
                        let response = json!({"surface": surface_id, "body": body});
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::InputKeys { keys } => {
                        cursor_activity = Instant::now();
                        last_cursor_frame = None;
                        // 입력은 뷰포트를 가장 새 출력으로 되돌린 뒤 쓴다.
                        if engine.scroll_to_newest() {
                            refresh_inline_image_positions(&mut engine, &mut image_state);
                            let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, 0);
                            if let Some(state) = image_state.as_mut() {
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                            if output_tx.send(screen_event(&surface_id, &screen).to_string()).await.is_err() { return; }
                        }
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
                    SurfaceCommand::Compose { preedit: next } => {
                        preedit = next;
                        cursor_activity = Instant::now();
                        last_cursor_frame = None;
                        if let Some(state) = image_state.as_mut() {
                            if state.pending_draw {
                                state.dirty = true;
                            } else {
                                let screen = decorate_screen(
                                    engine.screen(),
                                    focused,
                                    &preedit,
                                    &cursor_policy,
                                    0,
                                );
                                if !present_screen(&surface_id, &screen, state, &output_tx).await {
                                    return;
                                }
                            }
                        }
                        let response = json!({"surface": surface_id, "body": {"ack": true}});
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::Focus { focused: next } => {
                        cursor_activity = Instant::now();
                        last_cursor_frame = None;
                        focused = next;
                        let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                        if let Some(ref mut state) = image_state {
                            if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                        }
                        let response = json!({"surface": surface_id, "body": {"ack": true}});
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::Theme { theme } => {
                        current_theme = theme;
                        engine.set_theme(theme);
                        if let Some(state) = image_state.as_mut() {
                            state.theme = theme;
                            if state.pending_draw {
                                state.dirty = true;
                            } else {
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                        }
                        let mode = if theme == crate::palette::TerminalTheme::light() { "light" } else { "dark" };
                        let response = json!({"surface": surface_id, "body": {"ack": true, "event": "theme", "mode": mode}});
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::Font { font, system, skipped, size } => {
                        let family = match font.family() {
                            Ok(family) => family,
                            Err(reason) => {
                                let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": reason}});
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                                continue;
                            }
                        };
                        // 현재 raster 크기를 유지하고 새 글꼴의 셀 메트릭으로 열과 행을 다시 계산한다.
                        if let Some(state) = image_state.as_mut() {
                            let metrics = match crate::platform::metrics_for(&font, size, state.scale) {
                                Ok(metrics) => metrics,
                                Err(reason) => {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": reason}});
                                    if output_tx.send(response.to_string()).await.is_err() { return; }
                                    continue;
                                }
                            };
                            let (cols, rows) = match calculate_terminal_size(state.width_px, state.height_px, &metrics) {
                                Ok(size) => size,
                                Err(reason) => {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": reason}});
                                    if output_tx.send(response.to_string()).await.is_err() { return; }
                                    continue;
                                }
                            };
                            state.metrics = metrics;
                            engine.resize(cols, rows);
                            if let Err(error) = set_engine_metrics(&mut engine, state) {
                                let response = json!({"surface": surface_id, "body": {"error": "invalid renderer metrics", "reason": error}});
                                if output_tx.send(response.to_string()).await.is_err() { return; }
                                continue;
                            }
                            terminal_font = font;
                            terminal_font_size = size;
                            refresh_inline_image_positions(&mut engine, &mut image_state);
                            if let Some(sid) = session_id.as_ref() {
                                if let Err(error) = session_port.resize(sid, cols, rows).await {
                                    let response = json!({"surface": surface_id, "body": {"error": format!("Resize failed: {error}")}});
                                    if output_tx.send(response.to_string()).await.is_err() { return; }
                                } else if !send_state(&surface_id, sid, cols, rows, image_state.as_ref().unwrap(), &output_tx).await {
                                    return;
                                }
                            }
                            let state = image_state.as_mut().unwrap();
                            if state.pending_draw {
                                state.dirty = true;
                            } else {
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                                if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                            }
                        } else {
                            terminal_font = font;
                            terminal_font_size = size;
                        }
                        let response = json!({"surface": surface_id, "body": {"ack": true, "event": "font", "family": family, "system": system, "skipped": skipped, "size": size}});
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::Cursor { policy } => {
                        cursor_policy = policy;
                        cursor_activity = Instant::now();
                        last_cursor_frame = None;
                        let screen = decorate_screen(
                            engine.screen(),
                            focused,
                            &preedit,
                            &cursor_policy,
                            0,
                        );
                        if let Some(state) = image_state.as_mut() {
                            if state.pending_draw {
                                state.dirty = true;
                            } else if !present_screen(&surface_id, &screen, state, &output_tx).await {
                                return;
                            }
                        }
                        let response = json!({
                            "surface": surface_id,
                            "body": {
                                "ack": true,
                                "event": "cursor",
                                "shape": match policy.shape {
                                    CursorShape::Block => "block",
                                    CursorShape::Underline => "underline",
                                    CursorShape::Beam => "beam",
                                    CursorShape::HollowBlock => "block",
                                    CursorShape::Hidden => "block",
                                },
                                "blink": match policy.blink {
                                    CursorBlinkPolicy::Never => "Never",
                                    CursorBlinkPolicy::Off => "Off",
                                    CursorBlinkPolicy::On => "On",
                                    CursorBlinkPolicy::Always => "Always",
                                },
                                "interval": policy.interval_ms,
                                "idleTimeout": policy.idle_timeout_ms,
                                "unfocused": match policy.unfocused {
                                    UnfocusedCursor::Hollow => "hollow",
                                    UnfocusedCursor::Solid => "solid",
                                    UnfocusedCursor::Underline => "underline",
                                    UnfocusedCursor::Beam => "beam",
                                    UnfocusedCursor::Unchanged => "unchanged",
                                },
                            }
                        });
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::Command { selector } => {
                        let response = json!({"surface": surface_id, "body": {"ack": true, "event": "command", "selector": selector}});
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::ClipboardResolve { request_id, text } => {
                        if let Err(error) = engine.resolve_clipboard(request_id, &text) {
                            let response = json!({"surface": surface_id, "body": {"error": error}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        } else if !send_engine_events(&surface_id, session_id.as_deref(), &mut engine, &session_port, &output_tx, true, &mut image_state, &mut multipart).await {
                            return;
                        }
                    }
                    SurfaceCommand::ClipboardReject { request_id, reason } => {
                        if let Err(error) = engine.reject_clipboard(request_id, &reason) {
                            let response = json!({"surface": surface_id, "body": {"error": error}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        } else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"event": "clipboard.rejected", "requestId": request_id, "reason": reason}
                            });
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                        }
                    }
                    SurfaceCommand::ScreenRead => {
                        let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                        let response = screen_event(&surface_id, &screen);
                        if let Err(_) = output_tx.send(response.to_string()).await {
                            return;
                        }
                    }
                    SurfaceCommand::InlineImageDelete { name } => {
                        let Some(state) = image_state.as_mut() else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "imageNotConfigured", "reason": "inline image region is not configured"}
                            });
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                            continue;
                        };
                        let Some(index) = state.inline_images.iter().position(|image| image.name == name) else {
                            let response = json!({
                                "surface": surface_id,
                                "body": {"error": "imageNotFound", "reason": format!("inline image {name:?} is not owned by this surface")}
                            });
                            if output_tx.send(response.to_string()).await.is_err() { return; }
                            continue;
                        };
                        state.inline_images.remove(index);
                        if state.pending_draw {
                            state.dirty = true;
                        } else {
                            let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                            if !present_screen(&surface_id, &screen, state, &output_tx).await { return; }
                        }
                        let response = json!({
                            "surface": surface_id,
                            "body": {"event": "image.inline.deleted", "name": name}
                        });
                        if output_tx.send(response.to_string()).await.is_err() { return; }
                    }
                    SurfaceCommand::SessionClose => {
                        let close_error = if let Some(ref sid) = session_id {
                            session_port.close(sid).await.err()
                        } else {
                            None
                        };
                        let body = close_error
                            .map(|error| json!({"error": format!("Close failed: {error}")}))
                            .unwrap_or_else(|| json!({}));
                        let response = json!({"surface": surface_id, "body": body});
                        if output_tx.send(response.to_string()).await.is_err() {
                            return;
                        }
                        break;
                    }
                    SurfaceCommand::SessionDetach => {
                        if let Some(ref sid) = session_id {
                            if let Err(error) = session_port.detach(sid).await {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": format!("Detach failed: {error}")}
                                });
                                if output_tx.send(response.to_string()).await.is_err() {
                                    return;
                                }
                            }
                        }
                        break;
                    }
                    SurfaceCommand::ImageResponse { body } => {
                        let image_obj = body.get("image").and_then(|v| v.as_object());
                        let consumed = image_obj.and_then(|o| o.get("consumed")).and_then(|v| v.as_object());
                        let is_error = image_obj.map_or(false, |o| o.get("error").is_some());
                        // consumed 는 안쪽 객체에, 오류는 바깥에 이름과 순번을 실어 보낸다.
                        let name = image_obj
                            .and_then(|o| o.get("name"))
                            .and_then(|v| v.as_str())
                            .or_else(|| consumed.and_then(|r| r.get("name")).and_then(|v| v.as_str()));
                        // An image transfer is serialized: pending_draw means exactly one
                        // envelope is awaiting a host response. During a layout replacement
                        // the host can reject that envelope after its generation/raster has
                        // already moved on, so exact metadata matching would leave the
                        // sidecar permanently blocked with pending_draw=true. A response for
                        // the current image name releases that one in-flight transfer; the
                        // response error remains observable through the host log and the
                        // pending configuration or dirty frame is rendered below.
                        let releases_pending = image_state.as_ref().is_some_and(|state|
                            state.pending_draw
                                && Some(state.name.as_str()) == name
                                && (consumed.is_some() || is_error));
                        if releases_pending {
                            image_state.as_mut().unwrap().pending_draw = false;
                            if let Some(configuration) = pending_configuration.take() {
                                let new_state = match ImageState::new(configuration.name.clone(), configuration.generation,
                                    configuration.raster, configuration.width, configuration.height, configuration.scale, &terminal_font, terminal_font_size) {
                                    Ok(state) => state,
                                    Err(reason) => {
                                        let response = json!({"surface": surface_id,
                                            "body": {"error": "image creation failed", "reason": reason}});
                                        if output_tx.send(response.to_string()).await.is_err() { return; }
                                        continue;
                                    }
                                };
                                let mut new_state = new_state;
                                new_state.theme = current_theme;
                                let (cols, rows) = match calculate_terminal_size(
                                    configuration.width, configuration.height, &new_state.metrics) {
                                    Ok(size) => size,
                                    Err(reason) => {
                                        let response = json!({"surface": surface_id,
                                            "body": {"error": "invalidParams", "reason": reason}});
                                        if output_tx.send(response.to_string()).await.is_err() { return; }
                                        continue;
                                    }
                                };
                                engine.resize(cols, rows);
                                if let Err(error) = set_engine_metrics(&mut engine, &new_state) {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalid renderer metrics", "reason": error}});
                                    if output_tx.send(response.to_string()).await.is_err() { return; }
                                    continue;
                                }
                                image_state = Some(new_state);
                                if let Some(sid) = session_id.as_ref() {
                                    if let Err(error) = session_port.resize(sid, cols, rows).await {
                                        let response = json!({"surface": surface_id,
                                            "body": {"error": format!("Resize failed: {error}")}});
                                        if output_tx.send(response.to_string()).await.is_err() { return; }
                                    } else if !send_state(&surface_id, sid, cols, rows, image_state.as_ref().unwrap(), &output_tx).await {
                                        return;
                                    }
                                    let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                                    if !present_screen(&surface_id, &screen, image_state.as_mut().unwrap(), &output_tx).await {
                                        return;
                                    }
                                }
                            } else if image_state.as_ref().unwrap().dirty {
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);
                                if !present_screen(&surface_id, &screen, image_state.as_mut().unwrap(), &output_tx).await {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            Some(event) = daemon_events_rx.recv() => {
                match event {
                    DaemonEvent::Output { session_id: ref recv_sid, data, sequence: _, truncated } => {
                        if let Some(ref sid) = session_id {
                            if recv_sid == sid {
                                cursor_activity = Instant::now();
                                last_cursor_frame = None;
                                if truncated {
                                    engine.reset();
                                }
                                engine.feed(&data);
                                if !send_engine_events(&surface_id, session_id.as_deref(), &mut engine, &session_port, &output_tx, !headless, &mut image_state, &mut multipart).await { return; }
                                let screen = decorate_screen(engine.screen(), focused, &preedit, &cursor_policy, cursor_activity.elapsed().as_millis() as u64);

                                if !headless { if let Some(ref mut img_state) = image_state {
                                        // 그림이 호스트에 있으면 돌려받을 때까지 그리지 않고 변경 사실만 남긴다.
                                        if img_state.pending_draw {
                                            img_state.dirty = true;
                                        } else if !present_screen(&surface_id, &screen, img_state, &output_tx).await {
                                            return;
                                        }
                                } }

                                if headless { continue; }
                                let response = screen_event(&surface_id, &screen);
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
                    DaemonEvent::Error { session_id: ref recv_sid, error } => {
                        if session_id.as_deref() == Some(recv_sid) {
                            let response = json!({"surface": surface_id, "body": {"event": "error", "reason": error}});
                            if output_tx.send(response.to_string()).await.is_err() { return; }
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
    serve_with_options(
        engine_factory,
        reader,
        writer,
        session_port_factory,
        None,
        None,
        String::new(),
    )
    .await
}

pub async fn serve_with_owner_close<R, W>(
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    reader: R,
    writer: W,
    session_port_factory: Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync>,
    owner_close: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    serve_with_options(
        engine_factory,
        reader,
        writer,
        session_port_factory,
        owner_close,
        None,
        String::new(),
    )
    .await
}

pub async fn serve_with_registry<R, W>(
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    reader: R,
    writer: W,
    session_port_factory: Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync>,
    owner_close: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    registry: Arc<PersistentRegistry>,
    owner: String,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    serve_with_options(
        engine_factory,
        reader,
        writer,
        session_port_factory,
        Some(owner_close),
        Some(registry),
        owner,
    )
    .await
}

async fn serve_with_options<R, W>(
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    reader: R,
    writer: W,
    session_port_factory: Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync>,
    owner_close: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    registry: Option<Arc<PersistentRegistry>>,
    owner: String,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let buf_reader = BufReader::new(reader);
    let (output_sender, output_rx) = mpsc::channel::<String>(100);
    let output_tx = OutputSink::direct(output_sender);

    let input_task = run_input_loop(
        buf_reader,
        engine_factory,
        session_port_factory,
        output_tx,
        owner_close,
        registry,
        owner,
    );
    let output_task = run_output_loop(writer, output_rx);

    tokio::try_join!(input_task, output_task)?;
    Ok(())
}

async fn run_input_loop<R>(
    mut buf_reader: BufReader<R>,
    engine_factory: Arc<dyn Fn() -> Box<dyn Engine> + Send + Sync>,
    session_port_factory: Arc<dyn Fn() -> Arc<dyn SessionPort> + Send + Sync>,
    output_tx: OutputSink,
    owner_close: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    registry: Option<Arc<PersistentRegistry>>,
    owner: String,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut surface_txs: HashMap<String, mpsc::Sender<SurfaceCommand>> = HashMap::new();
    let mut surface_epochs: HashMap<String, u64> = HashMap::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut line = String::new();

    loop {
        line.clear();
        let n = buf_reader.read_line(&mut line).await?;

        if n == 0 {
            if registry.is_none() {
                for (_, tx) in surface_txs.iter() {
                    if tx.send(SurfaceCommand::SessionDetach).await.is_err() {
                        // The actor already terminated; its monitor has emitted the actor error.
                        continue;
                    }
                }
            } else {
                output_tx.replace_sender(None).await;
            }
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if value.get("operation").and_then(Value::as_str) == Some("close-owner") {
                let request = value.get("request").and_then(Value::as_str).unwrap_or("");
                let mut result = owner_close
                    .as_ref()
                    .map(|close| close())
                    .unwrap_or_else(|| Err("owner close is unavailable".to_string()));
                if result.is_ok() {
                    if let Some(registry) = registry.as_ref() {
                        result = registry.close_owner(&owner).await;
                    }
                }
                let reply = match result {
                    Ok(()) => json!({"operation": "closed-owner", "request": request, "ok": true}),
                    Err(error) => {
                        json!({"operation": "closed-owner", "request": request, "ok": false, "error": error})
                    }
                };
                if output_tx.send(reply.to_string()).await.is_err() {
                    break;
                }
                continue;
            }
            if value.get("operation").and_then(Value::as_str) == Some("retain") {
                let request = value.get("request").and_then(Value::as_str).unwrap_or("");
                let result = match (registry.as_ref(), retain_keys(&value)) {
                    (Some(registry), Ok(keep)) => registry.retain(&owner, &keep).await,
                    (None, _) => Err("retain is unavailable".to_string()),
                    (_, Err(error)) => Err(error),
                };
                let reply = match result {
                    Ok(closed) => {
                        json!({"operation": "retained", "request": request, "ok": true, "closed": closed})
                    }
                    Err(error) => {
                        json!({"operation": "retained", "request": request, "ok": false, "error": error})
                    }
                };
                if output_tx.send(reply.to_string()).await.is_err() {
                    break;
                }
                continue;
            }
            if value.get("operation").and_then(Value::as_str) == Some("shutdown") {
                let request = value.get("request").and_then(Value::as_str).unwrap_or("");
                let result = if let Some(registry) = registry.as_ref() {
                    registry.request_shutdown();
                    Ok(())
                } else {
                    Err("shutdown is unavailable".to_string())
                };
                let reply = match result {
                    Ok(()) => json!({"operation": "shutdown", "request": request, "ok": true}),
                    Err(error) => {
                        json!({"operation": "shutdown", "request": request, "ok": false, "error": error})
                    }
                };
                if output_tx.send(reply.to_string()).await.is_err() {
                    break;
                }
                break;
            }
        }

        match serde_json::from_str::<Envelope>(trimmed) {
            Ok(env) => {
                let surface_id = env.surface.clone();

                if env.closed == Some(true) {
                    let registry_key =
                        local_surface_key(&surface_txs, env.root.as_deref(), &surface_id);
                    let close_result = if let Some(registry) = registry.as_ref() {
                        registry.close_surface(&registry_key, &owner).await
                    } else if let Some(tx) = surface_txs.remove(&registry_key) {
                        tx.send(SurfaceCommand::SessionClose)
                            .await
                            .map_err(|_| "surface actor closed before close".to_string())
                    } else {
                        Ok(())
                    };
                    if let Err(error) = close_result {
                        let response = json!({"surface": surface_id, "body": {"error": error}});
                        if output_tx.send(response.to_string()).await.is_err() {
                            break;
                        }
                        continue;
                    }
                    let response = json!({"surface": surface_id, "body": {}});
                    if let Err(_) = output_tx.send(response.to_string()).await {
                        // Output channel closed; end serve
                        break;
                    }
                } else if let Some(body) = env.body {
                    let registry_key =
                        local_surface_key(&surface_txs, env.root.as_deref(), &surface_id);
                    let tx = if let Some(tx) = surface_txs.get(&registry_key) {
                        if let Some(registry) = registry.as_ref() {
                            let epoch = surface_epochs.get(&registry_key).copied().unwrap_or(0);
                            if registry.current_epoch(&registry_key, &owner).await != Some(epoch) {
                                let response = json!({"surface": surface_id, "body": {"error": "stale attachment"}});
                                if output_tx.send(response.to_string()).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                        }
                        tx.clone()
                    } else if let Some(registry) = registry.as_ref() {
                        match registry.attach(&registry_key, &owner, &output_tx).await {
                            Ok((tx, epoch)) => {
                                surface_epochs.insert(registry_key.clone(), epoch);
                                if tx.send(SurfaceCommand::Reconnect).await.is_err() {
                                    let response = json!({"surface": surface_id, "body": {"error": "persistent surface actor closed before reconnect"}});
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                    continue;
                                }
                                tx
                            }
                            Err(error) if registry.contains(&registry_key).await => {
                                let response = json!({"surface": surface_id, "body": {"error": "persistent attach failed", "reason": error}});
                                if output_tx.send(response.to_string()).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                            Err(error) => {
                                if error != "session surface not found" {
                                    let response = json!({"surface": surface_id, "body": {"error": "persistent attach failed", "reason": error}});
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                    continue;
                                }

                                // A persistent service must create a new actor for a
                                // genuinely new surface. Only an existing registry
                                // entry may be reattached; no error is converted into
                                // an implicit replacement of an existing session.
                                let (cmd_tx, cmd_rx) = mpsc::channel(10);
                                let session_port = session_port_factory();
                                let factory = engine_factory.clone();
                                let out_tx = output_tx.clone();
                                let sid = surface_id.clone();
                                let actor = tokio::spawn(async move {
                                    surface_task(sid, factory, session_port, cmd_rx, out_tx).await;
                                });
                                match registry
                                    .insert(
                                        registry_key.clone(),
                                        owner.clone(),
                                        cmd_tx.clone(),
                                        output_tx.clone(),
                                        actor,
                                    )
                                    .await
                                {
                                    Ok(epoch) => {
                                        surface_epochs.insert(registry_key.clone(), epoch);
                                        cmd_tx
                                    }
                                    Err(insert_error) => {
                                        let response = json!({"surface": surface_id, "body": {"error": "persistent surface creation failed", "reason": insert_error}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                        continue;
                                    }
                                }
                            }
                        }
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
                                    if let Err(error) = out_tx_monitor.send(response.to_string()).await {
                                        eprintln!("surface panic report was not delivered: {error:?}");
                                    }
                                }
                                Err(error) => {
                                    eprintln!("surface task was cancelled: {error}");
                                }
                            }
                        });

                        surface_txs.insert(registry_key.clone(), cmd_tx.clone());
                        cmd_tx
                    };
                    surface_txs.insert(registry_key.clone(), tx.clone());

                    // Check for operation field first (it is a request).
                    if let Some(operation) = body.get("operation").and_then(|v| v.as_str()) {
                        match operation {
                            "reconnect" => {
                                if tx.send(SurfaceCommand::Reconnect).await.is_err() {
                                    break;
                                }
                            }
                            "open" => {
                                let image = body
                                    .get("image")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string);
                                let Some(shell) = body
                                    .get("shell")
                                    .and_then(|v| v.as_str())
                                    .filter(|shell| !shell.is_empty())
                                else {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "open requires a shell"}});
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                    continue;
                                };
                                let directory = match body.get("directory") {
                                    None => None,
                                    Some(Value::String(directory))
                                        if directory.starts_with('/') =>
                                    {
                                        Some(directory.clone())
                                    }
                                    Some(_) => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "open directory must be an absolute path"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                        continue;
                                    }
                                };
                                let request = ShellRequest {
                                    shell: shell.to_string(),
                                    directory,
                                };
                                if tx
                                    .send(SurfaceCommand::Open { image, request })
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            "input" => {
                                if let Some(value) = body.get("compose") {
                                    let parsed = if value.is_null() {
                                        Ok(None)
                                    } else {
                                        serde_json::from_value::<Preedit>(value.clone()).map(Some)
                                    };
                                    match parsed {
                                        Ok(preedit) => {
                                            if tx
                                                .send(SurfaceCommand::Compose { preedit })
                                                .await
                                                .is_err()
                                            {
                                                break;
                                            }
                                        }
                                        Err(error) => {
                                            let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": format!("compose: {error}")}});
                                            if output_tx.send(response.to_string()).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                                if let Some(value) = body.get("focus") {
                                    if let Some(focused) =
                                        value.get("focused").and_then(Value::as_bool)
                                    {
                                        if tx.send(SurfaceCommand::Focus { focused }).await.is_err()
                                        {
                                            break;
                                        }
                                    } else {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "focus.focused must be boolean"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                                if let Some(value) = body.get("command") {
                                    if let Some(selector) =
                                        value.get("selector").and_then(Value::as_str)
                                    {
                                        if tx
                                            .send(SurfaceCommand::Command {
                                                selector: selector.to_string(),
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    } else {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "command.selector must be string"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                                // Bytes and keys remain optional when compose/focus/command is present.
                                let has_bytes = body.get("bytes").is_some();
                                let has_keys = body.get("keys").is_some();
                                let has_native_input = body.get("compose").is_some()
                                    || body.get("focus").is_some()
                                    || body.get("command").is_some();

                                if !has_bytes && !has_keys && !has_native_input {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": "input requires bytes or keys field"}
                                    });
                                    if let Err(_) = output_tx.send(response.to_string()).await {
                                        break;
                                    }
                                } else {
                                    // Process bytes first (if present)
                                    if let Some(bytes_b64) =
                                        body.get("bytes").and_then(|v| v.as_str())
                                    {
                                        match base64_decode(bytes_b64) {
                                            Ok(bytes) => {
                                                if let Err(_) =
                                                    tx.send(SurfaceCommand::Input { bytes }).await
                                                {
                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"error": format!("Base64 error: {}", e)}
                                                });
                                                if let Err(_) =
                                                    output_tx.send(response.to_string()).await
                                                {
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
                                    if let Some(keys_arr) =
                                        body.get("keys").and_then(|v| v.as_array())
                                    {
                                        match serde_json::from_value::<Vec<InputKey>>(Value::Array(
                                            keys_arr.clone(),
                                        )) {
                                            Ok(keys) => {
                                                if let Err(_) = tx
                                                    .send(SurfaceCommand::InputKeys { keys })
                                                    .await
                                                {
                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                let response = json!({
                                                    "surface": surface_id,
                                                    "body": {"error": format!("Keys parse error: {}", e)}
                                                });
                                                if let Err(_) =
                                                    output_tx.send(response.to_string()).await
                                                {
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
                            "theme" => {
                                let mode = body.get("mode").and_then(Value::as_str);
                                match mode.and_then(crate::palette::TerminalTheme::from_mode) {
                                    Some(theme) => {
                                        if tx.send(SurfaceCommand::Theme { theme }).await.is_err() {
                                            break;
                                        }
                                    }
                                    None => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "theme.mode must be dark or light"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            "font" => {
                                let size = match body.get("size").and_then(Value::as_f64) {
                                    Some(size) if (FONT_SIZE_MIN..=FONT_SIZE_MAX).contains(&size) => Ok(size as f32),
                                    _ => Err(format!("font.size must be a number from {FONT_SIZE_MIN} to {FONT_SIZE_MAX} points")),
                                };
                                let resolved = match body.get("family").and_then(Value::as_str) {
                                    Some(list) => crate::platform::resolve_font_list(list),
                                    None => Err("font.family must be a string".to_string()),
                                };
                                match size
                                    .and_then(|size| resolved.map(|selection| (selection, size)))
                                {
                                    Ok((selection, size)) => {
                                        // 설치되어 있지 않은 family 는 오류가 아니라 로그에 남긴다.
                                        for family in &selection.skipped {
                                            eprintln!(
                                                "terminal font family is not installed: {family}"
                                            );
                                        }
                                        if selection.system {
                                            eprintln!("no listed terminal font family is installed; using the system fixed-pitch font");
                                        }
                                        let (font, system, skipped) =
                                            (selection.font, selection.system, selection.skipped);
                                        if tx
                                            .send(SurfaceCommand::Font {
                                                font,
                                                system,
                                                skipped,
                                                size,
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Err(reason) => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": reason, "operation": "font"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            "cursor" => match parse_cursor_policy(&body) {
                                Ok(policy) => {
                                    if tx.send(SurfaceCommand::Cursor { policy }).await.is_err() {
                                        break;
                                    }
                                }
                                Err(reason) => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": reason}
                                    });
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                }
                            },
                            "paste" => match body.get("text").and_then(Value::as_str) {
                                Some(text) => {
                                    if tx
                                        .send(SurfaceCommand::Paste {
                                            text: text.to_string(),
                                        })
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                                None => {
                                    let response = json!({
                                        "surface": surface_id,
                                        "body": {"error": "invalidParams", "reason": "paste requires text string"}
                                    });
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                }
                            },
                            "selection.start" | "selection.update" => {
                                let x = body.get("x").and_then(Value::as_f64);
                                let y = body.get("y").and_then(Value::as_f64);
                                match (x, y) {
                                    (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
                                        let command = if operation == "selection.start" {
                                            SurfaceCommand::SelectionStart { x, y }
                                        } else {
                                            SurfaceCommand::SelectionUpdate { x, y }
                                        };
                                        if tx.send(command).await.is_err() {
                                            break;
                                        }
                                    }
                                    _ => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "selection requires finite x and y"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            "selection.end" => {
                                if tx.send(SurfaceCommand::SelectionEnd).await.is_err() {
                                    break;
                                }
                            }
                            "copy" => {
                                if tx.send(SurfaceCommand::Copy).await.is_err() {
                                    break;
                                }
                            }
                            "viewport" => {
                                let Some(offset) = body
                                    .get("offset")
                                    .and_then(Value::as_u64)
                                    .and_then(|v| u32::try_from(v).ok())
                                else {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "viewport requires a nonnegative integer offset"}});
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                    continue;
                                };
                                if tx.send(SurfaceCommand::Viewport { offset }).await.is_err() {
                                    break;
                                }
                            }
                            "scroll" => {
                                let lines = body
                                    .get("lines")
                                    .and_then(Value::as_i64)
                                    .filter(|lines| *lines != 0 && i32::try_from(*lines).is_ok());
                                let col = body
                                    .get("col")
                                    .and_then(Value::as_u64)
                                    .and_then(|v| u16::try_from(v).ok());
                                let row = body
                                    .get("row")
                                    .and_then(Value::as_u64)
                                    .and_then(|v| u16::try_from(v).ok());
                                let (Some(lines), Some(col), Some(row)) = (lines, col, row) else {
                                    let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "scroll requires a nonzero integer lines and cell col and row"}});
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                    continue;
                                };
                                if tx
                                    .send(SurfaceCommand::Scroll {
                                        lines: lines as i32,
                                        col,
                                        row,
                                    })
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            "screen.read" => {
                                if let Err(_) = tx.send(SurfaceCommand::ScreenRead).await {
                                    break;
                                }
                            }
                            "clipboard.resolve" => {
                                let request_id = body.get("requestId").and_then(Value::as_u64);
                                let text =
                                    body.get("text").and_then(Value::as_str).map(str::to_string);
                                match (request_id, text) {
                                    (Some(request_id), Some(text)) => {
                                        if tx
                                            .send(SurfaceCommand::ClipboardResolve {
                                                request_id,
                                                text,
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    _ => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "clipboard.resolve requires requestId and text"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            "clipboard.reject" => {
                                let request_id = body.get("requestId").and_then(Value::as_u64);
                                let reason = body
                                    .get("reason")
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                                match (request_id, reason) {
                                    (Some(request_id), Some(reason)) if !reason.is_empty() => {
                                        if tx
                                            .send(SurfaceCommand::ClipboardReject {
                                                request_id,
                                                reason,
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    _ => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "clipboard.reject requires requestId and non-empty reason"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            "image.inline.delete" => {
                                match body
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .filter(|name| !name.is_empty())
                                {
                                    Some(name) => {
                                        if tx
                                            .send(SurfaceCommand::InlineImageDelete {
                                                name: name.to_string(),
                                            })
                                            .await
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    None => {
                                        let response = json!({"surface": surface_id, "body": {"error": "invalidParams", "reason": "image.inline.delete requires a non-empty name"}});
                                        if output_tx.send(response.to_string()).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            "close" => {
                                let close_result = if let Some(registry) = registry.as_ref() {
                                    registry.close_surface(&registry_key, &owner).await
                                } else if let Some(tx) = surface_txs.remove(&registry_key) {
                                    tx.send(SurfaceCommand::SessionClose).await.map_err(|_| {
                                        "surface actor closed before close".to_string()
                                    })
                                } else {
                                    Ok(())
                                };
                                if let Err(error) = close_result {
                                    let response =
                                        json!({"surface": surface_id, "body": {"error": error}});
                                    if output_tx.send(response.to_string()).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            _ => {
                                let response = json!({
                                    "surface": surface_id,
                                    "body": {"error": format!("Unknown operation: {}", operation)}
                                });
                                if let Err(_) = output_tx.send(response.to_string()).await {
                                    break;
                                }
                            }
                        }
                    } else if let Some(image) = body.get("image").and_then(|v| v.as_object()) {
                        if let Some(configure) = image.get("configure").and_then(|v| v.as_object())
                        {
                            let parsed = (|| {
                                let name = configure.get("name")?.as_str()?.to_string();
                                let generation = configure.get("generation")?.as_u64()?;
                                let raster = configure.get("raster")?.as_u64()?;
                                let width =
                                    u32::try_from(configure.get("width")?.as_u64()?).ok()?;
                                let height =
                                    u32::try_from(configure.get("height")?.as_u64()?).ok()?;
                                let scale = configure.get("scale")?.as_f64()? as f32;
                                (generation > 0
                                    && raster > 0
                                    && width > 0
                                    && height > 0
                                    && scale.is_finite()
                                    && scale > 0.0)
                                    .then_some(ImageConfiguration {
                                        name,
                                        generation,
                                        raster,
                                        width,
                                        height,
                                        scale,
                                    })
                            })();
                            if let Some(configuration) = parsed {
                                if tx
                                    .send(SurfaceCommand::Configure(configuration))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            } else {
                                let response = json!({"surface": surface_id,
                                    "body": {"error": "invalidParams", "reason": "invalid image configure"}});
                                if output_tx.send(response.to_string()).await.is_err() {
                                    break;
                                }
                            }
                        } else if tx
                            .send(SurfaceCommand::ImageResponse { body: body.clone() })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    } else {
                        // No operation and no image object means an unknown message.
                        let response = json!({
                            "surface": surface_id,
                            "body": {"error": "unknown operation"}
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

    // A persistent transport keeps its surface actors and PTY sessions across
    // an unexpected client disconnect. Normal application shutdown sends the
    // explicit close-owner operation and closes them there. Non-persistent
    // transports have no recovery owner, so their surfaces must be closed now.
    if registry.is_none() {
        for (_, tx) in surface_txs.iter() {
            tx.send(SurfaceCommand::SessionClose)
                .await
                .map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        format!("close surface during serve shutdown: {error}"),
                    )
                })?;
        }
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
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|error| format!("invalid base64 input: {error}"))
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
    fn set_theme(&mut self, _theme: crate::palette::TerminalTheme) {}

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        Vec::new()
    }

    fn resolve_clipboard(&mut self, _request_id: u64, _text: &str) -> Result<(), String> {
        Ok(())
    }

    fn reject_clipboard(&mut self, _request_id: u64, _reason: &str) -> Result<(), String> {
        Ok(())
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

    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
    }

    fn set_cell_metrics(&mut self, _width: u16, _height: u16) -> Result<(), String> {
        Ok(())
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
            background: None,
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
    let service = Arc::new(crate::pty::PtyService::new());
    Arc::new(move || Arc::new(LocalSessionPort::new(service.clone())) as Arc<dyn SessionPort>)
}

/// In-process PTY session port.  The service is shared by all surface ports;
/// each call to `open` still creates one independent PTY session.
pub struct LocalSessionPort {
    service: Arc<crate::pty::PtyService>,
    owner: String,
    events_tx: mpsc::UnboundedSender<DaemonEvent>,
    events_rx: Arc<tokio::sync::Mutex<Option<mpsc::UnboundedReceiver<DaemonEvent>>>>,
    attachments: Arc<tokio::sync::Mutex<HashMap<String, String>>>,
}

impl LocalSessionPort {
    fn new(service: Arc<crate::pty::PtyService>) -> Self {
        Self::new_with_owner(service, String::new())
    }

    pub fn new_with_owner(service: Arc<crate::pty::PtyService>, owner: String) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        Self {
            service,
            owner,
            events_tx,
            events_rx: Arc::new(tokio::sync::Mutex::new(Some(events_rx))),
            attachments: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl SessionPort for LocalSessionPort {
    async fn open(&self, request: &ShellRequest, cols: u16, rows: u16) -> Result<String, String> {
        let service = Arc::clone(&self.service);
        let owner = self.owner.clone();
        let shell = crate::pty::resolve_shell(&request.shell)?;
        let directory = request
            .directory
            .as_deref()
            .map(crate::pty::resolve_directory)
            .transpose()?;
        let events = self.events_tx.clone();
        let (session_id, attachment_id) = tokio::task::spawn_blocking(move || {
            service.open_shell(&owner, &shell, directory.as_deref(), cols, rows, events)
        })
        .await
        .map_err(|error| format!("open PTY task failed: {error}"))??;
        self.attachments
            .lock()
            .await
            .insert(session_id.clone(), attachment_id);
        Ok(session_id)
    }

    async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        self.service.write(session_id, data)
    }

    async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.service.resize(session_id, cols, rows)
    }

    async fn detach(&self, session_id: &str) -> Result<(), String> {
        if let Some(attachment_id) = self.attachments.lock().await.remove(session_id) {
            self.service.detach(session_id, &attachment_id)?;
        }
        Ok(())
    }

    async fn close(&self, session_id: &str) -> Result<(), String> {
        self.attachments.lock().await.remove(session_id);
        let service = Arc::clone(&self.service);
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || service.close(&session_id))
            .await
            .map_err(|error| format!("close PTY task failed: {error}"))?
    }

    async fn attach(&self, session_id: &str, from: i64) -> Result<String, String> {
        let attachment_id = self
            .service
            .attach(session_id, from, self.events_tx.clone())?;
        self.attachments
            .lock()
            .await
            .insert(session_id.to_string(), attachment_id.clone());
        Ok(attachment_id)
    }

    async fn get_events(&self) -> mpsc::Receiver<DaemonEvent> {
        let (tx, rx) = mpsc::channel(128);
        let mut events_rx = self.events_rx.lock().await;
        if let Some(mut source) = events_rx.take() {
            tokio::spawn(async move {
                while let Some(event) = source.recv().await {
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
            });
        }
        rx
    }
}

/// Base64 encode
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
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
    async fn open(&self, request: &ShellRequest, _cols: u16, _rows: u16) -> Result<String, String> {
        let mut calls = self.calls.lock().await;
        let session_id = format!("session-{}", calls.opens.len());
        calls.opens.push(request.shell.clone());
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
    fn unsupported_ctrl_character_error_identifies_the_received_scalar() {
        let error = encode_keys(
            &[InputKey {
                key: "Char".to_string(),
                text: "ㅕ".to_string(),
                shift: false,
                alt: false,
                ctrl: true,
            }],
            &Modes::default(),
        )
        .unwrap_err();

        assert_eq!(
            error,
            "unknown key: Char with ctrl: Unsupported (text 'ㅕ', U+3155)"
        );
    }

    #[test]
    fn test_base64_decode() {
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
    }

    #[tokio::test]
    async fn persistent_registry_rejects_stale_owner_and_awaits_actor_close() {
        let registry = PersistentRegistry::new();
        let (tx, mut rx) = mpsc::channel(4);
        let actor = tokio::spawn(async move {
            while let Some(command) = rx.recv().await {
                if matches!(command, SurfaceCommand::SessionClose) {
                    break;
                }
            }
        });
        let (output_sender, _output_receiver) = mpsc::channel(4);
        registry.entries.lock().await.insert(
            "root\0surface".to_string(),
            PersistentEntry {
                tx,
                output: OutputSink::direct(output_sender),
                actor,
                epoch: 1,
                owner: "client-a".to_string(),
            },
        );
        let (new_sender, _new_receiver) = mpsc::channel(4);
        let attached = registry
            .attach("root\0surface", "client-a", &OutputSink::direct(new_sender))
            .await
            .unwrap();
        assert!(attached.1 > 1);
        assert!(registry
            .attach(
                "root\0surface",
                "client-b",
                &OutputSink::direct(mpsc::channel(1).0)
            )
            .await
            .is_err());
        registry.close_owner("client-a").await.unwrap();
        assert!(!registry.contains("root\0surface").await);
    }

    fn closing_actor() -> (mpsc::Sender<SurfaceCommand>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::channel(1);
        let actor = tokio::spawn(async move {
            while let Some(command) = rx.recv().await {
                if matches!(command, SurfaceCommand::SessionClose) {
                    break;
                }
            }
        });
        (tx, actor)
    }

    #[tokio::test]
    async fn persistent_registry_retain_closes_only_the_owners_unlisted_sessions() {
        let registry = PersistentRegistry::new();
        for (key, owner) in [
            ("root\0kept", "client-a"),
            ("root\0orphan", "client-a"),
            ("root\0other", "client-b"),
        ] {
            let (tx, actor) = closing_actor();
            let (output, _events) = mpsc::channel(1);
            registry.entries.lock().await.insert(
                key.to_string(),
                PersistentEntry {
                    tx,
                    output: OutputSink::direct(output),
                    actor,
                    epoch: 1,
                    owner: owner.to_string(),
                },
            );
        }
        let keep = std::collections::HashSet::from(["root\0kept".to_string()]);
        assert_eq!(registry.retain("client-a", &keep).await, Ok(1));
        assert!(registry.contains("root\0kept").await);
        assert!(!registry.contains("root\0orphan").await);
        assert!(
            registry.contains("root\0other").await,
            "another client's session stays"
        );
    }

    #[tokio::test]
    async fn persistent_registry_close_owner_keeps_other_client_sessions() {
        let registry = PersistentRegistry::new();
        let (a_tx, mut a_rx) = mpsc::channel(1);
        let a_actor = tokio::spawn(async move {
            while let Some(command) = a_rx.recv().await {
                if matches!(command, SurfaceCommand::SessionClose) {
                    break;
                }
            }
        });
        let (b_tx, mut b_rx) = mpsc::channel(1);
        let b_actor = tokio::spawn(async move {
            while let Some(command) = b_rx.recv().await {
                if matches!(command, SurfaceCommand::SessionClose) {
                    break;
                }
            }
        });
        let (a_output, _a_events) = mpsc::channel(1);
        let (b_output, _b_events) = mpsc::channel(1);
        registry.entries.lock().await.insert(
            "root\0a".to_string(),
            PersistentEntry {
                tx: a_tx,
                output: OutputSink::direct(a_output),
                actor: a_actor,
                epoch: 1,
                owner: "client-a".to_string(),
            },
        );
        registry.entries.lock().await.insert(
            "root\0b".to_string(),
            PersistentEntry {
                tx: b_tx,
                output: OutputSink::direct(b_output),
                actor: b_actor,
                epoch: 1,
                owner: "client-b".to_string(),
            },
        );

        registry.close_owner("client-a").await.unwrap();
        assert!(!registry.contains("root\0a").await);
        assert!(registry.contains("root\0b").await);
        registry.close_owner("client-b").await.unwrap();
        assert!(!registry.contains("root\0b").await);
    }

    #[tokio::test]
    async fn persistent_surface_close_does_not_wait_forever_for_actor_exit() {
        let registry = PersistentRegistry::new();
        let (tx, mut rx) = mpsc::channel(1);
        let actor = tokio::spawn(async move {
            while let Some(_command) = rx.recv().await {
                std::future::pending::<()>().await;
            }
        });
        let (output, _events) = mpsc::channel(1);
        registry.entries.lock().await.insert(
            "root\0surface".to_string(),
            PersistentEntry {
                tx,
                output: OutputSink::direct(output),
                actor,
                epoch: 1,
                owner: "client".to_string(),
            },
        );

        let result = tokio::time::timeout(
            Duration::from_millis(200),
            registry.close_surface("root\0surface", "client"),
        )
        .await;
        result
            .expect("surface close blocked the persistent input loop")
            .expect("surface close could not queue actor cleanup");
    }
}
