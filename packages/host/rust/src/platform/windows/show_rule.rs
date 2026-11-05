//! The rule of a window show on Windows: only an application that holds the foreground may take it. It holds no system call, so it also
//! runs where Windows does not exist.

const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;

/// The flags of a position change. A change that shows the window keeps the front window where it is unless this application holds the
/// foreground, and any other change stays as it was asked.
pub(crate) fn shown_position_flags(flags: u32, holds_foreground: bool) -> u32 {
    if flags & SWP_SHOWWINDOW != 0 && !holds_foreground {
        flags | SWP_NOACTIVATE | SWP_NOZORDER
    } else {
        flags
    }
}

/// The command that shows a window: SW_SHOW activates it, and SW_SHOWNOACTIVATE leaves the active window active.
pub(crate) fn show_command(holds_foreground: bool) -> i32 {
    if holds_foreground { 5 } else { 4 }
}

#[cfg(test)]
#[path = "show_rule_test.rs"]
mod tests;
