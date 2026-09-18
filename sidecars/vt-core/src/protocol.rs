use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

/// 엔진이 구현할 트레이트. VT 처리 엔진의 계약.
pub trait Engine: Send + 'static {
    /// 화면 크기 변경
    fn resize(&mut self, cols: u16, rows: u16);
    /// 바이트를 엔진에 공급
    fn feed(&mut self, bytes: &[u8]);
    /// 현재 화면 상태를 돌려줌
    fn screen(&mut self) -> Screen;
    /// 현재 모드를 돌려줌
    fn modes(&self) -> Modes;
    /// 화면 상태를 초기화
    fn reset(&mut self);
}

/// 셀 하나의 속성
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Cell {
    /// 문자(또는 결합 문자열)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ch: Option<String>,
    /// 셀 폭: 0(결합 문자), 1(일반), 2(와이드 문자)
    pub width: u8,
    /// 전경색 (RGB 16진수 또는 ANSI 색상 인덱스)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    /// 배경색
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    /// 굵게
    #[serde(default)]
    pub bold: bool,
    /// 기울임
    #[serde(default)]
    pub italic: bool,
    /// 밑줄
    #[serde(default)]
    pub underline: bool,
    /// 역상
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

/// 커서 위치
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub col: u16,
    pub row: u16,
}

/// 터미널 모드 설정
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Modes {
    /// 애플리케이션 커서 모드
    #[serde(default)]
    pub app_cursor: bool,
    /// 애플리케이션 키패드 모드
    #[serde(default)]
    pub app_keypad: bool,
    /// 괄호로 감싼 붙여넣기 모드
    #[serde(default)]
    pub bracketed_paste: bool,
    /// 마우스 보고 모드
    #[serde(default)]
    pub mouse_report: bool,
    /// 대체 화면 모드
    #[serde(default)]
    pub alt_screen: bool,
}

/// 엔진 중립 화면 타입
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Screen {
    pub cols: u16,
    pub rows: u16,
    pub cursor: Cursor,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<Vec<Cell>>,
}

/// 세션 상태
pub(crate) struct Session {
    pub(crate) engine: Box<dyn Engine>,
}

/// 호스트에서 받은 메시지 봉투
#[derive(Debug, Deserialize)]
struct Envelope {
    surface: String,
    // 호스트가 전송마다 붙이는 프로젝트 디렉터리다. 세션을 데몬에서 열 때 작업 디렉터리로 쓴다.
    #[allow(dead_code)]
    root: Option<String>,
    body: Option<Value>,
    closed: Option<bool>,
}

/// 세션 관리자
pub struct SessionManager {
    sessions: HashMap<String, Session>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn open(&mut self, surface_id: String, engine: Box<dyn Engine>) {
        let session = Session {
            engine,
        };
        self.sessions.insert(surface_id, session);
    }

    pub fn close(&mut self, surface_id: &str) -> bool {
        self.sessions.remove(surface_id).is_some()
    }

    #[allow(private_interfaces)]
    pub fn get_session_mut(&mut self, surface_id: &str) -> Option<&mut Session> {
        self.sessions.get_mut(surface_id)
    }

    pub fn has_session(&self, surface_id: &str) -> bool {
        self.sessions.contains_key(surface_id)
    }
}

/// 서비스 루프. stdin 에서 JSON 을 읽고 stdout 으로 응답을 씀.
pub async fn serve<F, R, W>(
    engine_factory: F,
    reader: R,
    mut writer: W,
) -> std::io::Result<()>
where
    F: Fn() -> Box<dyn Engine>,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf_reader = BufReader::new(reader);
    let mut sessions = SessionManager::new();
    let mut line = String::new();

    loop {
        line.clear();
        let n = buf_reader.read_line(&mut line).await?;

        if n == 0 {
            // stdin EOF 에 2초 안에 정리하고 끝남
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // 봉투 파싱
        match serde_json::from_str::<Envelope>(trimmed) {
            Ok(env) => {
                let response = handle_envelope(&mut sessions, &engine_factory, env);
                let response_json = serde_json::to_string(&response)?;
                writer.write_all(response_json.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.flush().await?;
            }
            Err(e) => {
                let error_response = json!({
                    "surface": "",
                    "body": {
                        "error": format!("Invalid envelope: {}", e)
                    }
                });
                let response_json = serde_json::to_string(&error_response)?;
                writer.write_all(response_json.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.flush().await?;
            }
        }
    }

    Ok(())
}

fn handle_envelope<F>(
    sessions: &mut SessionManager,
    engine_factory: F,
    env: Envelope,
) -> Value
where
    F: Fn() -> Box<dyn Engine>,
{
    let surface_id = env.surface;

    // 종료 봉투 처리
    if env.closed == Some(true) {
        sessions.close(&surface_id);
        return json!({
            "surface": surface_id,
            "body": {}
        });
    }

    // 요청 봉투 처리
    if let Some(body) = env.body {
        handle_request(sessions, engine_factory, surface_id, body)
    } else {
        json!({
            "surface": surface_id,
            "body": {
                "error": "Missing body"
            }
        })
    }
}

fn handle_request<F>(
    sessions: &mut SessionManager,
    engine_factory: F,
    surface_id: String,
    body: Value,
) -> Value
where
    F: Fn() -> Box<dyn Engine>,
{
    let op = body.get("op").and_then(|v| v.as_str());

    match op {
        Some("open") => {
            let width = body.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let height = body.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let scale = body.get("scale").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;

            let mut engine = engine_factory();

            // 픽셀 크기에서 셀 개수 계산
            const CELL_WIDTH: f32 = 8.0;
            const CELL_HEIGHT: f32 = 16.0;

            let cols = (width as f32 / (CELL_WIDTH * scale)) as u16;
            let rows = (height as f32 / (CELL_HEIGHT * scale)) as u16;

            engine.resize(cols, rows);
            sessions.open(surface_id.clone(), engine);

            json!({
                "surface": surface_id,
                "body": {
                    "event": "state",
                    "cols": cols,
                    "rows": rows,
                    "cursor": {
                        "col": 0,
                        "row": 0
                    }
                }
            })
        }
        Some("input") => {
            if let Some(bytes_b64) = body.get("bytes").and_then(|v| v.as_str()) {
                match base64_decode(bytes_b64) {
                    Ok(decoded) => {
                        if let Some(session) = sessions.get_session_mut(&surface_id) {
                            session.engine.feed(&decoded);
                            json!({
                                "surface": surface_id,
                                "body": {
                                    "ack": true
                                }
                            })
                        } else {
                            json!({
                                "surface": surface_id,
                                "body": {
                                    "error": "Session not found"
                                }
                            })
                        }
                    }
                    Err(e) => {
                        json!({
                            "surface": surface_id,
                            "body": {
                                "error": format!("Base64 decode error: {}", e)
                            }
                        })
                    }
                }
            } else {
                json!({
                    "surface": surface_id,
                    "body": {
                        "error": "Missing bytes field"
                    }
                })
            }
        }
        Some("resize") => {
            let width = body.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let height = body.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let scale = body.get("scale").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;

            if let Some(session) = sessions.get_session_mut(&surface_id) {
                const CELL_WIDTH: f32 = 8.0;
                const CELL_HEIGHT: f32 = 16.0;

                let cols = (width as f32 / (CELL_WIDTH * scale)) as u16;
                let rows = (height as f32 / (CELL_HEIGHT * scale)) as u16;

                session.engine.resize(cols, rows);

                json!({
                    "surface": surface_id,
                    "body": {
                        "event": "state",
                        "cols": cols,
                        "rows": rows,
                        "cursor": {
                            "col": 0,
                            "row": 0
                        }
                    }
                })
            } else {
                json!({
                    "surface": surface_id,
                    "body": {
                        "error": "Session not found"
                    }
                })
            }
        }
        Some("screen.read") => {
            if let Some(session) = sessions.get_session_mut(&surface_id) {
                let screen = session.engine.screen();
                json!({
                    "surface": surface_id,
                    "body": {
                        "event": "screen",
                        "cols": screen.cols,
                        "rows": screen.rows,
                        "cursor": screen.cursor,
                        "lines": screen.lines
                    }
                })
            } else {
                json!({
                    "surface": surface_id,
                    "body": {
                        "error": "Session not found"
                    }
                })
            }
        }
        Some("close") => {
            if sessions.has_session(&surface_id) {
                sessions.close(&surface_id);
                json!({
                    "surface": surface_id,
                    "body": {}
                })
            } else {
                json!({
                    "surface": surface_id,
                    "body": {
                        "error": "Session not found"
                    }
                })
            }
        }
        _ => {
            json!({
                "surface": surface_id,
                "body": {
                    "error": format!("Unknown operation: {:?}", op)
                }
            })
        }
    }
}

/// 간단한 Base64 디코딩
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
            .ok_or_else(|| "Invalid Base64 character".to_string())?;

        if i + 1 >= bytes.len() {
            return Err("Incomplete Base64".to_string());
        }

        let b2 = bytes[i + 1];
        let idx2 = ALPHABET.iter().position(|&x| x == b2)
            .ok_or_else(|| "Invalid Base64 character".to_string())?;

        result.push((((idx1 << 2) | (idx2 >> 4)) & 0xFF) as u8);

        if i + 2 < bytes.len() && bytes[i + 2] != b'=' {
            let b3 = bytes[i + 2];
            let idx3 = ALPHABET.iter().position(|&x| x == b3)
                .ok_or_else(|| "Invalid Base64 character".to_string())?;

            result.push((((idx2 << 4) | (idx3 >> 2)) & 0xFF) as u8);

            if i + 3 < bytes.len() && bytes[i + 3] != b'=' {
                let b4 = bytes[i + 3];
                let idx4 = ALPHABET.iter().position(|&x| x == b4)
                    .ok_or_else(|| "Invalid Base64 character".to_string())?;

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

/// Fake 엔진: 입력 바이트를 그대로 화면에 놓음 (테스트용)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_fake_engine_basic() {
        let mut engine = FakeEngine::new();
        engine.feed(b"hi");

        let screen = engine.screen();
        assert_eq!(screen.lines.len(), 1);
        assert_eq!(screen.lines[0].len(), 2);
        assert_eq!(screen.lines[0][0].ch, Some("h".to_string()));
        assert_eq!(screen.lines[0][1].ch, Some("i".to_string()));
    }

    #[tokio::test]
    async fn test_resize_updates_dimensions() {
        let mut engine = FakeEngine::new();
        engine.resize(100, 50);

        let screen = engine.screen();
        assert_eq!(screen.cols, 100);
        assert_eq!(screen.rows, 50);
    }

    #[tokio::test]
    async fn test_base64_decode() {
        let decoded = base64_decode("aGk=").unwrap();
        assert_eq!(decoded, b"hi");

        let decoded = base64_decode("aGVsbG8=").unwrap();
        assert_eq!(decoded, b"hello");
    }

    #[tokio::test]
    async fn test_serve_open_input_screen_read() {
        // open → input → screen.read 통합 테스트
        let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"input","bytes":"aGk="}}
{"surface":"s1","body":{"op":"screen.read"}}
"#;

        let reader = std::io::Cursor::new(input.as_bytes());
        let mut writer = Vec::new();

        let result = serve(
            || Box::new(FakeEngine::new()),
            reader,
            &mut writer,
        ).await;

        assert!(result.is_ok());

        let output = String::from_utf8(writer).unwrap();
        let lines: Vec<&str> = output.lines().collect();

        // 3개 응답 확인
        assert_eq!(lines.len(), 3);

        // 첫 번째: open 응답
        let open_response: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(open_response.get("surface").unwrap().as_str(), Some("s1"));
        assert_eq!(open_response.get("body").unwrap().get("event").unwrap().as_str(), Some("state"));

        // 세 번째: screen.read 응답에서 "hi" 내용 확인
        let screen_response: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(screen_response.get("surface").unwrap().as_str(), Some("s1"));
        let body = screen_response.get("body").unwrap();
        assert_eq!(body.get("event").unwrap().as_str(), Some("screen"));

        // 화면의 첫 줄에 "hi"가 있는지 확인
        let lines_array = body.get("lines").unwrap().as_array().unwrap();
        assert!(!lines_array.is_empty());
        let first_line = lines_array[0].as_array().unwrap();
        assert_eq!(first_line[0].get("ch").unwrap().as_str(), Some("h"));
        assert_eq!(first_line[1].get("ch").unwrap().as_str(), Some("i"));
    }

    #[tokio::test]
    async fn test_close_session() {
        // open → close → input (오류 예상)
        let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","closed":true}
{"surface":"s1","body":{"op":"input","bytes":"aGk="}}
"#;

        let reader = std::io::Cursor::new(input.as_bytes());
        let mut writer = Vec::new();

        let result = serve(
            || Box::new(FakeEngine::new()),
            reader,
            &mut writer,
        ).await;

        assert!(result.is_ok());

        let output = String::from_utf8(writer).unwrap();
        let lines: Vec<&str> = output.lines().collect();

        // 세 번째 요청(close 후 input)은 오류 응답
        let error_response: Value = serde_json::from_str(lines[2]).unwrap();
        assert!(error_response.get("body").unwrap().get("error").is_some());
        assert_eq!(
            error_response.get("body").unwrap().get("error").unwrap().as_str(),
            Some("Session not found")
        );
    }

    #[tokio::test]
    async fn test_resize() {
        let input = r#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
{"surface":"s1","body":{"op":"resize","width":1600,"height":768,"scale":1.0}}
"#;

        let reader = std::io::Cursor::new(input.as_bytes());
        let mut writer = Vec::new();

        let result = serve(
            || Box::new(FakeEngine::new()),
            reader,
            &mut writer,
        ).await;

        assert!(result.is_ok());

        let output = String::from_utf8(writer).unwrap();
        let lines: Vec<&str> = output.lines().collect();

        assert_eq!(lines.len(), 2);

        let resize_response: Value = serde_json::from_str(lines[1]).unwrap();
        let state = &resize_response.get("body").unwrap().get("event");
        assert_eq!(state.and_then(|v| v.as_str()), Some("state"));
    }

    #[tokio::test]
    async fn test_wide_chars() {
        let mut engine = FakeEngine::new();
        engine.feed("안".as_bytes());

        let screen = engine.screen();
        assert_eq!(screen.lines.len(), 1);
        // 한글은 width 2 로 표현되어야 함
        assert_eq!(screen.lines[0][0].width, 2);
    }
}
