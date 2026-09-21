/// VT 기본 팔레트와 특수 색상 슬롯을 정의한다.
///
/// 엔진은 이 값을 화면 셀과 OSC 색상 응답에 사용하고, 네이티브 renderer는
/// 같은 호출에서 전달받은 foreground/background/cursor 값을 사용한다.
pub const DEFAULT_FOREGROUND_RGB: [u8; 3] = [0xd0, 0xd0, 0xd0];
pub const DEFAULT_BACKGROUND_RGB: [u8; 3] = [0x1e, 0x1e, 0x1e];
pub const DEFAULT_CURSOR_RGB: [u8; 3] = DEFAULT_FOREGROUND_RGB;
pub const DEFAULT_FOREGROUND_HEX: &str = "#d0d0d0";
pub const DEFAULT_BACKGROUND_HEX: &str = "#1e1e1e";

const ANSI: [[u8; 3]; 16] = [
    [0x00, 0x00, 0x00],
    [0xcd, 0x00, 0x00],
    [0x00, 0xcd, 0x00],
    [0xcd, 0xcd, 0x00],
    [0x00, 0x00, 0xee],
    [0xcd, 0x00, 0xcd],
    [0x00, 0xcd, 0xcd],
    [0xe5, 0xe5, 0xe5],
    [0x7f, 0x7f, 0x7f],
    [0xff, 0x00, 0x00],
    [0x00, 0xff, 0x00],
    [0xff, 0xff, 0x00],
    [0x5c, 0x5c, 0xff],
    [0xff, 0x00, 0xff],
    [0x00, 0xff, 0xff],
    [0xff, 0xff, 0xff],
];

const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];

const fn build_default_palette() -> [[u8; 3]; 256] {
    let mut palette = [[0; 3]; 256];
    let mut index = 0;
    while index < 16 {
        palette[index] = ANSI[index];
        index += 1;
    }

    let mut cube = 0;
    while cube < 216 {
        let red = cube / 36;
        let green = (cube / 6) % 6;
        let blue = cube % 6;
        palette[16 + cube] = [CUBE[red], CUBE[green], CUBE[blue]];
        cube += 1;
    }

    let mut gray = 0;
    while gray < 24 {
        let value = 8 + gray * 10;
        palette[232 + gray] = [value as u8, value as u8, value as u8];
        gray += 1;
    }
    palette
}

pub const DEFAULT_PALETTE: [[u8; 3]; 256] = build_default_palette();

const fn dim(color: [u8; 3]) -> [u8; 3] {
    [color[0] / 2, color[1] / 2, color[2] / 2]
}

/// 0..255 기본 팔레트와 256..268 named 슬롯을 해석한다.
pub const fn default_terminal_color(index: usize) -> Option<[u8; 3]> {
    if index < 256 {
        return Some(DEFAULT_PALETTE[index]);
    }
    match index {
        256 => Some(DEFAULT_FOREGROUND_RGB),
        257 => Some(DEFAULT_BACKGROUND_RGB),
        258 => Some(DEFAULT_CURSOR_RGB),
        259..=266 => Some(dim(DEFAULT_PALETTE[index - 259])),
        267 => Some(DEFAULT_FOREGROUND_RGB),
        268 => Some(dim(DEFAULT_FOREGROUND_RGB)),
        _ => None,
    }
}
