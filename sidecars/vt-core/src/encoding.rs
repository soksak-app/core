//! 키·마우스·조합 입력을 PTY 에 쓸 바이트로 인코딩하는 순수 함수들.
//!
//! 터미널 엔진마다 다시 구현할 필요가 없는 공통 계층. 페이지에서 받은 논리적 입력을
//! 표준 VT 시퀀스로 변환한다.

use crate::Modes;

/// 입력 장치가 보낼 수 있는 키의 열거형.
/// 각 키는 표준 VT 시퀀스로 인코딩되어야 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    // 커서 키
    Up,
    Down,
    Left,
    Right,
    // 영역 키
    Home,
    End,
    Insert,
    Delete,
    PageUp,
    PageDown,
    // 기능 키
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
    // 특수 키
    Enter,
    Tab,
    Backspace,
    Escape,
}

/// 마우스 이벤트의 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
}

/// 마우스 이벤트. 좌표는 **셀 좌표**(1-based)로 받는다.
#[derive(Debug, Clone, Copy)]
pub struct MouseEvent {
    pub button: MouseButton,
    pub col: u16,        // 1-based cell column
    pub row: u16,        // 1-based cell row
    pub pressed: bool,   // true if button pressed, false if released
    pub is_motion: bool, // true if mouse is moving
}

/// 키 인코딩 오류.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// 미지원 키 또는 입력.
    Unsupported,
    /// 기타 오류.
    Other(String),
}

/// 수식자 플래그 (shift, alt, ctrl의 조합).
/// 각 비트: shift=1, alt=2, ctrl=4
pub type Modifiers = u8;

/// 키를 PTY 에 쓸 바이트로 인코딩한다.
///
/// # 인코딩 규칙
/// - 커서 키 (`Up`/`Down`/`Right`/`Left`): 보통 `ESC [ A|B|C|D`, app cursor 모드면 `ESC O A|B|C|D`.
/// - `Home`/`End`: `ESC [ H` / `ESC [ F` (app cursor 면 `ESC O H` / `ESC O F`).
/// - `Insert`/`Delete`/`PageUp`/`PageDown`: `ESC [ 2~` / `ESC [ 3~` / `ESC [ 5~` / `ESC [ 6~`.
/// - `F1..F12`: VT 관례 (F1–F4 는 `ESC O P|Q|R|S`, F5 `ESC [ 15~`, 등).
/// - 수식자(shift=1, alt=2, ctrl=4)가 있으면 `ESC [ 1 ; <n> A` 꼴 (커서 키),
///   또는 `ESC [ 2 ; <n> ~` 꼴 (Tilde 계열).
/// - `Enter` → `\r`, `Tab` → `\t`, `Backspace` → `\x7f`, `Escape` → `\x1b`.
/// - 문자 기반 키 (`A`–`Z`, `0`–`9` 등)는 이 함수에 전달되지 않음.
///   문자는 `encode_text()`를 통해 직접 인코딩하기.
///
/// # 미지원
/// - **App keypad 모드**: `modes.app_keypad` 가 켜져 있어도 현재 단계에서 지원하지 않음.
///   숫자 키는 그대로 보냄. 향후 확장 예정.
///
/// # 에러
/// 모르는 키나 매칭 불가능한 입력은 `Err(Unsupported)` 를 반환함.
/// 오류를 조용히 삼키지 않으니 호출자가 적절히 처리하기.
pub fn encode_key(key: Key, modifiers: Modifiers, modes: &Modes) -> Result<Vec<u8>, EncodeError> {
    match key {
        // 커서 키
        Key::Up => {
            if modifiers == 0 {
                if modes.app_cursor {
                    Ok(b"\x1bOA".to_vec())
                } else {
                    Ok(b"\x1b[A".to_vec())
                }
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}A", n).into_bytes())
            }
        }
        Key::Down => {
            if modifiers == 0 {
                if modes.app_cursor {
                    Ok(b"\x1bOB".to_vec())
                } else {
                    Ok(b"\x1b[B".to_vec())
                }
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}B", n).into_bytes())
            }
        }
        Key::Right => {
            if modifiers == 0 {
                if modes.app_cursor {
                    Ok(b"\x1bOC".to_vec())
                } else {
                    Ok(b"\x1b[C".to_vec())
                }
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}C", n).into_bytes())
            }
        }
        Key::Left => {
            if modifiers == 0 {
                if modes.app_cursor {
                    Ok(b"\x1bOD".to_vec())
                } else {
                    Ok(b"\x1b[D".to_vec())
                }
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}D", n).into_bytes())
            }
        }

        // Home/End 키
        Key::Home => {
            if modifiers == 0 {
                if modes.app_cursor {
                    Ok(b"\x1bOH".to_vec())
                } else {
                    Ok(b"\x1b[H".to_vec())
                }
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}H", n).into_bytes())
            }
        }
        Key::End => {
            if modifiers == 0 {
                if modes.app_cursor {
                    Ok(b"\x1bOF".to_vec())
                } else {
                    Ok(b"\x1b[F".to_vec())
                }
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}F", n).into_bytes())
            }
        }

        // Tilde 계열 키 (Insert, Delete, PageUp, PageDown)
        Key::Insert => {
            if modifiers == 0 {
                Ok(b"\x1b[2~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[2;{}~", n).into_bytes())
            }
        }
        Key::Delete => {
            if modifiers == 0 {
                Ok(b"\x1b[3~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[3;{}~", n).into_bytes())
            }
        }
        Key::PageUp => {
            if modifiers == 0 {
                Ok(b"\x1b[5~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[5;{}~", n).into_bytes())
            }
        }
        Key::PageDown => {
            if modifiers == 0 {
                Ok(b"\x1b[6~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[6;{}~", n).into_bytes())
            }
        }

        // 기능 키 (F1–F12)
        // F1–F4 는 수식자가 없으면 SS3, 있으면 CSI 에 수식자 인자를 싣는다.
        Key::F1 | Key::F2 | Key::F3 | Key::F4 => {
            let final_byte = match key {
                Key::F1 => b'P',
                Key::F2 => b'Q',
                Key::F3 => b'R',
                _ => b'S',
            };
            if modifiers == 0 {
                Ok(vec![0x1b, b'O', final_byte])
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[1;{}{}", n, final_byte as char).into_bytes())
            }
        }
        Key::F5 => {
            if modifiers == 0 {
                Ok(b"\x1b[15~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[15;{}~", n).into_bytes())
            }
        }
        Key::F6 => {
            if modifiers == 0 {
                Ok(b"\x1b[17~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[17;{}~", n).into_bytes())
            }
        }
        Key::F7 => {
            if modifiers == 0 {
                Ok(b"\x1b[18~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[18;{}~", n).into_bytes())
            }
        }
        Key::F8 => {
            if modifiers == 0 {
                Ok(b"\x1b[19~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[19;{}~", n).into_bytes())
            }
        }
        Key::F9 => {
            if modifiers == 0 {
                Ok(b"\x1b[20~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[20;{}~", n).into_bytes())
            }
        }
        Key::F10 => {
            if modifiers == 0 {
                Ok(b"\x1b[21~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[21;{}~", n).into_bytes())
            }
        }
        Key::F11 => {
            if modifiers == 0 {
                Ok(b"\x1b[23~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[23;{}~", n).into_bytes())
            }
        }
        Key::F12 => {
            if modifiers == 0 {
                Ok(b"\x1b[24~".to_vec())
            } else {
                let n = compute_modifier_param(modifiers);
                Ok(format!("\x1b[24;{}~", n).into_bytes())
            }
        }

        // 특수 키
        Key::Enter => Ok(b"\r".to_vec()),
        Key::Tab => Ok(b"\t".to_vec()),
        Key::Backspace => Ok(b"\x7f".to_vec()),
        Key::Escape => Ok(b"\x1b".to_vec()),
    }
}

/// Ctrl 기반 바이트 인코딩. `ctrl+a` → `0x01` 부터 `ctrl+z` → `0x1a` 까지.
/// 일반 문자가 아닌 특수 시퀀스도 지원: `ctrl+[` → `0x1b`, `ctrl+\` → `0x1c`, `ctrl+]` → `0x1d`, `ctrl+space` → `0x00`.
///
/// # 에러
/// `ch` 가 컨트롤 가능한 문자가 아니면 `Err(Unsupported)`.
pub fn encode_ctrl_char(ch: char) -> Result<Vec<u8>, EncodeError> {
    match ch {
        'a'..='z' => {
            let code = (ch as u8 - b'a' + 1) as u8;
            Ok(vec![code])
        }
        'A'..='Z' => {
            let code = (ch as u8 - b'A' + 1) as u8;
            Ok(vec![code])
        }
        '[' => Ok(vec![0x1b]),  // Ctrl+[
        '\\' => Ok(vec![0x1c]), // Ctrl+\
        ']' => Ok(vec![0x1d]),  // Ctrl+]
        ' ' => Ok(vec![0x00]),  // Ctrl+Space
        _ => Err(EncodeError::Unsupported),
    }
}

/// 텍스트를 utf-8 바이트로 인코딩한다. 텍스트 입력 처리용.
pub fn encode_text(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

/// Alt + 문자 조합. 문자 앞에 ESC 를 붙인다.
/// 예: `alt+a` → `ESC` + `a` 의 UTF-8 바이트.
pub fn encode_alt_char(ch: char) -> Vec<u8> {
    let mut result = vec![0x1b]; // ESC
    let mut buf = [0u8; 4];
    let encoded = ch.encode_utf8(&mut buf);
    result.extend_from_slice(encoded.as_bytes());
    result
}

/// 수식자 파라미터를 계산한다.
/// shift=1, alt=2, ctrl=4 의 비트가 주어질 때, (shift+alt+ctrl) + 1 을 반환.
/// 예: alt+ctrl → (2+4)+1=7, shift 만 → (1)+1=2, 수식자 없음 → (0)+1=1.
fn compute_modifier_param(modifiers: Modifiers) -> u8 {
    modifiers + 1
}

/// 붙여넣기 텍스트를 인코딩한다.
///
/// # 처리
/// - `bracketed_paste` 모드가 켜져 있으면 `ESC [ 200 ~` 로 시작해 `ESC [ 201 ~` 로 끝남.
/// - 텍스트 내의 `ESC [ 201 ~` 시퀀스는 감싸기를 빠져나가지 못하도록 거부함.
/// - 텍스트의 UTF-8 바이트와 개행을 그대로 보존함.
pub fn encode_paste(text: &str, modes: &Modes) -> Result<Vec<u8>, String> {
    if modes.bracketed_paste && text.contains("\x1b[201~") {
        return Err("paste text contains the bracketed-paste terminator".to_string());
    }
    let mut result = Vec::new();

    if modes.bracketed_paste {
        result.extend_from_slice(b"\x1b[200~");
    }

    result.extend_from_slice(text.as_bytes());

    if modes.bracketed_paste {
        result.extend_from_slice(b"\x1b[201~");
    }

    Ok(result)
}

/// 마우스 이벤트를 PTY 에 쓸 바이트로 인코딩한다. SGR(1006) 형식 사용.
///
/// # SGR 형식
/// - 누름: `ESC [ < <button> ; <col> ; <row> M`
/// - 뗌: `ESC [ < <button> ; <col> ; <row> m`
/// - 좌표는 **1-based** (셀 좌표).
///
/// # 버튼 인코딩
/// - 왼쪽: 0, 가운데: 1, 오른쪽: 2
/// - 이동 중: +32
/// - 수식자: shift +4, alt +8, ctrl +16
/// - 휠 위: 64, 휠 아래: 65
///
/// # 반환값
/// 마우스 보고 모드가 꺼져 있으면 `None`. 켜져 있으면 인코딩된 바이트.
pub fn encode_mouse(event: MouseEvent, modes: &Modes) -> Option<Vec<u8>> {
    if !modes.mouse_report {
        return None;
    }

    let mut button_code = match event.button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::WheelUp => 64,
        MouseButton::WheelDown => 65,
    };

    if event.is_motion
        && event.button != MouseButton::WheelUp
        && event.button != MouseButton::WheelDown
    {
        button_code += 32;
    }

    let action_char = if event.pressed { b'M' } else { b'm' };

    let result = format!(
        "\x1b[<{};{};{}{}",
        button_code, event.col, event.row, action_char as char
    );

    Some(result.into_bytes())
}

/// 스크롤 이벤트를 인코딩한다.
///
/// # 세 가지 경우
/// 1. 마우스 보고 모드가 켜져 있으면: 휠 버튼 보고를 줄 수만큼 반복 (`lines` 만큼 위/아래).
/// 2. 마우스 보고는 꺼져 있지만 대체 화면(alt_screen) 모드: 커서 위/아래 키를 줄 수만큼.
///    (대체 화면에는 스크롤백이 없으므로 위/아래 키가 관례).
/// 3. 둘 다 아니면 `None` (호출자가 자체 스크롤백을 움직인다).
///
/// # 인자
/// - `lines`: 스크롤할 줄 수. 양수면 아래(down), 음수면 위(up).
pub fn encode_scroll(lines: i32, modes: &Modes) -> Option<Vec<u8>> {
    if modes.mouse_report {
        // 마우스 보고 모드: 휠 버튼 이벤트를 반복
        let mut result = Vec::new();
        if lines > 0 {
            for _ in 0..lines {
                result.extend_from_slice(b"\x1b[<65;1;1M"); // WheelDown at (1,1)
            }
        } else if lines < 0 {
            for _ in 0..(-lines) {
                result.extend_from_slice(b"\x1b[<64;1;1M"); // WheelUp at (1,1)
            }
        }
        Some(result)
    } else if modes.alt_screen {
        // 대체 화면: 커서 위/아래 키
        let mut result = Vec::new();
        if lines > 0 {
            for _ in 0..lines {
                result.extend_from_slice(b"\x1b[B"); // Down arrow
            }
        } else if lines < 0 {
            for _ in 0..(-lines) {
                result.extend_from_slice(b"\x1b[A"); // Up arrow
            }
        }
        Some(result)
    } else {
        // 둘 다 아님: 스크롤백은 호출자가 직접 관리
        None
    }
}

/// 조합(IME) 상태를 추적하는 간단한 상태 머신.
/// 조합 중인 문자열을 보관하고, 확정 시점에만 바이트를 돌려준다.
///
/// # 사용법
/// ```
/// use soksak_sidecar_vt_core::encoding::CompositionState;
/// let mut composer = CompositionState::new();
/// // 조합 중에는 PTY 로 나가는 바이트가 없다.
/// assert_eq!(composer.add_char('한'), None);
/// assert!(composer.is_composing());
/// // 확정할 때 한 번만 나간다.
/// assert_eq!(composer.confirm(), Some("한".as_bytes().to_vec()));
/// assert!(!composer.is_composing());
/// ```
#[derive(Debug, Clone)]
pub struct CompositionState {
    buffer: String,
}

impl CompositionState {
    /// 새로운 조합 상태 생성.
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// 조합 중인 문자를 추가한다.
    /// **PTY 로 보내지 않음**. 호출자가 화면에 미리 그려야 함.
    /// `None` 을 반환 (바이트 없음).
    pub fn add_char(&mut self, ch: char) -> Option<Vec<u8>> {
        self.buffer.push(ch);
        None // 조합 중에는 바이트 반환 안 함
    }

    /// 조합을 취소한다.
    pub fn cancel(&mut self) {
        self.buffer.clear();
    }

    /// 조합을 확정한다.
    /// 버퍼의 텍스트를 UTF-8 바이트로 돌려주고 버퍼를 비운다.
    pub fn confirm(&mut self) -> Option<Vec<u8>> {
        if self.buffer.is_empty() {
            None
        } else {
            let bytes = self.buffer.as_bytes().to_vec();
            self.buffer.clear();
            Some(bytes)
        }
    }

    /// 현재 조합 중인 텍스트를 돌려줌 (읽기 전용).
    pub fn current(&self) -> &str {
        &self.buffer
    }

    /// 조합이 진행 중인지 확인.
    pub fn is_composing(&self) -> bool {
        !self.buffer.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cursor_keys_app_cursor_mode() {
        let modes_normal = Modes {
            app_cursor: false,
            app_keypad: false,
            bracketed_paste: false,
            mouse_report: false,
            alt_screen: false,
            ..Default::default()
        };
        let modes_app = Modes {
            app_cursor: true,
            app_keypad: false,
            bracketed_paste: false,
            mouse_report: false,
            alt_screen: false,
            ..Default::default()
        };

        // 일반 모드
        assert_eq!(
            encode_key(Key::Up, 0, &modes_normal).unwrap(),
            b"\x1b[A".to_vec()
        );
        assert_eq!(
            encode_key(Key::Down, 0, &modes_normal).unwrap(),
            b"\x1b[B".to_vec()
        );
        assert_eq!(
            encode_key(Key::Right, 0, &modes_normal).unwrap(),
            b"\x1b[C".to_vec()
        );
        assert_eq!(
            encode_key(Key::Left, 0, &modes_normal).unwrap(),
            b"\x1b[D".to_vec()
        );

        // App cursor 모드
        assert_eq!(
            encode_key(Key::Up, 0, &modes_app).unwrap(),
            b"\x1bOA".to_vec()
        );
        assert_eq!(
            encode_key(Key::Down, 0, &modes_app).unwrap(),
            b"\x1bOB".to_vec()
        );
        assert_eq!(
            encode_key(Key::Right, 0, &modes_app).unwrap(),
            b"\x1bOC".to_vec()
        );
        assert_eq!(
            encode_key(Key::Left, 0, &modes_app).unwrap(),
            b"\x1bOD".to_vec()
        );
    }

    #[test]
    fn test_function_keys_with_modifiers() {
        let modes = Modes::default();
        // 수식자가 없으면 SS3.
        assert_eq!(encode_key(Key::F1, 0, &modes).unwrap(), b"\x1bOP".to_vec());
        assert_eq!(encode_key(Key::F4, 0, &modes).unwrap(), b"\x1bOS".to_vec());
        // shift(1) 이면 인자는 2, ctrl(4) 이면 5.
        assert_eq!(
            encode_key(Key::F1, 1, &modes).unwrap(),
            b"\x1b[1;2P".to_vec()
        );
        assert_eq!(
            encode_key(Key::F3, 4, &modes).unwrap(),
            b"\x1b[1;5R".to_vec()
        );
    }

    #[test]
    fn test_cursor_keys_with_modifiers() {
        let modes = Modes::default();

        // Shift+Up (modifier 1)
        assert_eq!(
            encode_key(Key::Up, 1, &modes).unwrap(),
            b"\x1b[1;2A".to_vec()
        );

        // Ctrl+Left (modifier 4)
        assert_eq!(
            encode_key(Key::Left, 4, &modes).unwrap(),
            b"\x1b[1;5D".to_vec()
        );

        // Shift+Ctrl+Down (modifier 5)
        assert_eq!(
            encode_key(Key::Down, 5, &modes).unwrap(),
            b"\x1b[1;6B".to_vec()
        );
    }

    #[test]
    fn test_home_end_keys() {
        let modes_normal = Modes::default();
        let modes_app = Modes {
            app_cursor: true,
            ..Default::default()
        };

        // 일반 모드
        assert_eq!(
            encode_key(Key::Home, 0, &modes_normal).unwrap(),
            b"\x1b[H".to_vec()
        );
        assert_eq!(
            encode_key(Key::End, 0, &modes_normal).unwrap(),
            b"\x1b[F".to_vec()
        );

        // App cursor 모드
        assert_eq!(
            encode_key(Key::Home, 0, &modes_app).unwrap(),
            b"\x1bOH".to_vec()
        );
        assert_eq!(
            encode_key(Key::End, 0, &modes_app).unwrap(),
            b"\x1bOF".to_vec()
        );
    }

    #[test]
    fn test_tilde_keys() {
        let modes = Modes::default();

        // Insert/Delete/PageUp/PageDown
        assert_eq!(
            encode_key(Key::Insert, 0, &modes).unwrap(),
            b"\x1b[2~".to_vec()
        );
        assert_eq!(
            encode_key(Key::Delete, 0, &modes).unwrap(),
            b"\x1b[3~".to_vec()
        );
        assert_eq!(
            encode_key(Key::PageUp, 0, &modes).unwrap(),
            b"\x1b[5~".to_vec()
        );
        assert_eq!(
            encode_key(Key::PageDown, 0, &modes).unwrap(),
            b"\x1b[6~".to_vec()
        );

        // With modifiers
        assert_eq!(
            encode_key(Key::Delete, 2, &modes).unwrap(),
            b"\x1b[3;3~".to_vec() // alt (2+1=3)
        );
    }

    #[test]
    fn test_function_keys() {
        let modes = Modes::default();

        // F1-F4: ESC O letter
        assert_eq!(encode_key(Key::F1, 0, &modes).unwrap(), b"\x1bOP".to_vec());
        assert_eq!(encode_key(Key::F2, 0, &modes).unwrap(), b"\x1bOQ".to_vec());
        assert_eq!(encode_key(Key::F3, 0, &modes).unwrap(), b"\x1bOR".to_vec());
        assert_eq!(encode_key(Key::F4, 0, &modes).unwrap(), b"\x1bOS".to_vec());

        // F5-F12: ESC [ num ~
        assert_eq!(
            encode_key(Key::F5, 0, &modes).unwrap(),
            b"\x1b[15~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F6, 0, &modes).unwrap(),
            b"\x1b[17~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F7, 0, &modes).unwrap(),
            b"\x1b[18~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F8, 0, &modes).unwrap(),
            b"\x1b[19~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F9, 0, &modes).unwrap(),
            b"\x1b[20~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F10, 0, &modes).unwrap(),
            b"\x1b[21~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F11, 0, &modes).unwrap(),
            b"\x1b[23~".to_vec()
        );
        assert_eq!(
            encode_key(Key::F12, 0, &modes).unwrap(),
            b"\x1b[24~".to_vec()
        );

        // F5 with Shift (modifier 1)
        assert_eq!(
            encode_key(Key::F5, 1, &modes).unwrap(),
            b"\x1b[15;2~".to_vec()
        );
    }

    #[test]
    fn test_special_keys() {
        let modes = Modes::default();

        assert_eq!(encode_key(Key::Enter, 0, &modes).unwrap(), b"\r".to_vec());
        assert_eq!(encode_key(Key::Tab, 0, &modes).unwrap(), b"\t".to_vec());
        assert_eq!(
            encode_key(Key::Backspace, 0, &modes).unwrap(),
            b"\x7f".to_vec()
        );
        assert_eq!(
            encode_key(Key::Escape, 0, &modes).unwrap(),
            b"\x1b".to_vec()
        );
    }

    #[test]
    fn test_encode_ctrl_char() {
        // Ctrl+A through Ctrl+Z
        assert_eq!(encode_ctrl_char('a').unwrap(), vec![0x01]);
        assert_eq!(encode_ctrl_char('u').unwrap(), vec![0x15]);
        assert_eq!(encode_ctrl_char('z').unwrap(), vec![0x1a]);
        assert_eq!(encode_ctrl_char('A').unwrap(), vec![0x01]);
        assert_eq!(encode_ctrl_char('Z').unwrap(), vec![0x1a]);

        // Special ctrl codes
        assert_eq!(encode_ctrl_char('[').unwrap(), vec![0x1b]);
        assert_eq!(encode_ctrl_char('\\').unwrap(), vec![0x1c]);
        assert_eq!(encode_ctrl_char(']').unwrap(), vec![0x1d]);
        assert_eq!(encode_ctrl_char(' ').unwrap(), vec![0x00]);

        // Unsupported
        assert_eq!(encode_ctrl_char('!').unwrap_err(), EncodeError::Unsupported);
    }

    #[test]
    fn test_encode_alt_char() {
        // Alt+A → ESC + 'a'
        let result = encode_alt_char('a');
        assert_eq!(result, vec![0x1b, b'a']);

        // Alt+한 (한글)
        let result = encode_alt_char('한');
        let mut expected = vec![0x1b];
        let korean_str = "한";
        expected.extend_from_slice(korean_str.as_bytes());
        assert_eq!(result, expected);
    }

    #[test]
    fn test_encode_paste_bracketed() {
        let modes_bracketed = Modes {
            bracketed_paste: true,
            ..Default::default()
        };
        let modes_normal = Modes::default();

        // Bracketed paste mode ON
        let result = encode_paste("hello", &modes_bracketed).unwrap();
        assert_eq!(result, b"\x1b[200~hello\x1b[201~".to_vec());

        // Bracketed paste mode OFF
        let result = encode_paste("hello", &modes_normal).unwrap();
        assert_eq!(result, b"hello".to_vec());
    }

    #[test]
fn test_encode_paste_rejects_end_marker_without_dropping_it() {
        let modes = Modes {
            bracketed_paste: true,
            ..Default::default()
        };

        let error = encode_paste("hello\x1b[201~world", &modes).unwrap_err();
        assert_eq!(error, "paste text contains the bracketed-paste terminator");
    }

    #[test]
    fn test_encode_paste_preserves_line_endings() {
        let modes = Modes {
            bracketed_paste: true,
            ..Default::default()
        };

        let result = encode_paste("hello\nworld", &modes).unwrap();
        assert_eq!(result, b"\x1b[200~hello\nworld\x1b[201~".to_vec());
        let result = encode_paste("hello\r\nworld", &modes).unwrap();
        assert_eq!(result, b"\x1b[200~hello\r\nworld\x1b[201~".to_vec());
        let result = encode_paste("hello\rworld", &modes).unwrap();
        assert_eq!(result, b"\x1b[200~hello\rworld\x1b[201~".to_vec());
    }

    #[test]
    fn test_encode_mouse_sgr_format() {
        let modes = Modes {
            mouse_report: true,
            ..Default::default()
        };

        // Left button press at (1, 1)
        let event = MouseEvent {
            button: MouseButton::Left,
            col: 1,
            row: 1,
            pressed: true,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes).unwrap();
        assert_eq!(result, b"\x1b[<0;1;1M".to_vec());

        // Left button release
        let event = MouseEvent {
            button: MouseButton::Left,
            col: 1,
            row: 1,
            pressed: false,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes).unwrap();
        assert_eq!(result, b"\x1b[<0;1;1m".to_vec());
    }

    #[test]
    fn test_encode_mouse_buttons() {
        let modes = Modes {
            mouse_report: true,
            ..Default::default()
        };

        // Middle button
        let event = MouseEvent {
            button: MouseButton::Middle,
            col: 10,
            row: 20,
            pressed: true,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes).unwrap();
        assert_eq!(result, b"\x1b[<1;10;20M".to_vec());

        // Right button
        let event = MouseEvent {
            button: MouseButton::Right,
            col: 10,
            row: 20,
            pressed: true,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes).unwrap();
        assert_eq!(result, b"\x1b[<2;10;20M".to_vec());
    }

    #[test]
    fn test_encode_mouse_motion() {
        let modes = Modes {
            mouse_report: true,
            ..Default::default()
        };

        // Left button motion (pressed + moving)
        let event = MouseEvent {
            button: MouseButton::Left,
            col: 5,
            row: 5,
            pressed: true,
            is_motion: true,
        };
        let result = encode_mouse(event, &modes).unwrap();
        // Button code: 0 + 32 = 32
        assert_eq!(result, b"\x1b[<32;5;5M".to_vec());
    }

    #[test]
    fn test_encode_mouse_wheel() {
        let modes = Modes {
            mouse_report: true,
            ..Default::default()
        };

        // Wheel up
        let event = MouseEvent {
            button: MouseButton::WheelUp,
            col: 1,
            row: 1,
            pressed: false,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes).unwrap();
        assert_eq!(result, b"\x1b[<64;1;1m".to_vec());

        // Wheel down
        let event = MouseEvent {
            button: MouseButton::WheelDown,
            col: 1,
            row: 1,
            pressed: false,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes).unwrap();
        assert_eq!(result, b"\x1b[<65;1;1m".to_vec());
    }

    #[test]
    fn test_encode_mouse_disabled() {
        let modes = Modes {
            mouse_report: false,
            ..Default::default()
        };

        let event = MouseEvent {
            button: MouseButton::Left,
            col: 1,
            row: 1,
            pressed: true,
            is_motion: false,
        };
        let result = encode_mouse(event, &modes);
        assert_eq!(result, None);
    }

    #[test]
    fn test_encode_scroll_with_mouse_report() {
        let modes = Modes {
            mouse_report: true,
            alt_screen: false,
            ..Default::default()
        };

        // Scroll down (positive)
        let result = encode_scroll(3, &modes).unwrap();
        assert_eq!(result, b"\x1b[<65;1;1M\x1b[<65;1;1M\x1b[<65;1;1M".to_vec());

        // Scroll up (negative)
        let result = encode_scroll(-2, &modes).unwrap();
        assert_eq!(result, b"\x1b[<64;1;1M\x1b[<64;1;1M".to_vec());

        // No scroll
        let result = encode_scroll(0, &modes).unwrap();
        assert_eq!(result, b"".to_vec());
    }

    #[test]
    fn test_encode_scroll_alt_screen() {
        let modes = Modes {
            mouse_report: false,
            alt_screen: true,
            ..Default::default()
        };

        // Scroll down (positive)
        let result = encode_scroll(2, &modes).unwrap();
        assert_eq!(result, b"\x1b[B\x1b[B".to_vec());

        // Scroll up (negative)
        let result = encode_scroll(-3, &modes).unwrap();
        assert_eq!(result, b"\x1b[A\x1b[A\x1b[A".to_vec());

        // No scroll
        let result = encode_scroll(0, &modes).unwrap();
        assert_eq!(result, b"".to_vec());
    }

    #[test]
    fn test_encode_scroll_no_handling() {
        let modes = Modes {
            mouse_report: false,
            alt_screen: false,
            ..Default::default()
        };

        // No mouse report, no alt screen → None
        let result = encode_scroll(5, &modes);
        assert_eq!(result, None);

        let result = encode_scroll(-3, &modes);
        assert_eq!(result, None);
    }

    #[test]
    fn test_composition_state_not_composing() {
        let mut composer = CompositionState::new();

        // Before confirmation, no bytes
        assert_eq!(composer.add_char('あ'), None);
        assert!(composer.is_composing());

        // Confirm and get bytes
        let confirmed = composer.confirm();
        assert_eq!(confirmed, Some("あ".as_bytes().to_vec()));
        assert!(!composer.is_composing());
    }

    #[test]
    fn test_composition_state_cancel() {
        let mut composer = CompositionState::new();

        composer.add_char('あ');
        composer.add_char('い');
        assert!(composer.is_composing());

        composer.cancel();
        assert!(!composer.is_composing());
        assert_eq!(composer.current(), "");
    }

    #[test]
    fn test_composition_state_multiple_chars() {
        let mut composer = CompositionState::new();

        composer.add_char('a');
        composer.add_char('b');
        composer.add_char('c');

        let confirmed = composer.confirm();
        assert_eq!(confirmed, Some(b"abc".to_vec()));
        assert!(!composer.is_composing());

        // Next composition starts fresh
        composer.add_char('x');
        let confirmed2 = composer.confirm();
        assert_eq!(confirmed2, Some(b"x".to_vec()));
    }

    #[test]
    fn test_composition_state_current() {
        let mut composer = CompositionState::new();

        composer.add_char('한');
        composer.add_char('글');
        assert_eq!(composer.current(), "한글");

        composer.confirm();
        assert_eq!(composer.current(), "");
    }

    #[test]
    fn test_composition_state_confirm_empty() {
        let mut composer = CompositionState::new();
        assert_eq!(composer.confirm(), None);
    }
}
