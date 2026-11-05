//! A window show that does not take the front. The framework that owns a window may show it with SW_SHOW, which activates it, so the rule is
//! also held in the position change that the show makes.

use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::System::Threading::GetCurrentProcessId;
use ::windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SET_WINDOW_POS_FLAGS, SHOW_WINDOW_CMD,
    ShowWindow, WINDOWPOS, WM_WINDOWPOSCHANGING,
};

use crate::platform::Handle;
use crate::platform::show_rule::{show_command, shown_position_flags};

/// Whether the foreground window belongs to this process. No foreground window means that it does not.
fn holds_foreground() -> bool {
    let mut process = 0u32;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut process)) };
    process == unsafe { GetCurrentProcessId() }
}

/// Shows a window whose owner reads its visibility from the system. Call it on the UI thread.
pub fn show_window(window: Handle) -> Result<(), String> {
    let command = SHOW_WINDOW_CMD(show_command(holds_foreground()));
    if unsafe { ShowWindow(HWND(window as *mut _), command) }.as_bool() {
        crate::application_log::log_info("window show", "the window was already shown");
    }
    Ok(())
}

unsafe extern "system" fn keep_front(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_WINDOWPOSCHANGING {
        // SAFETY: the system passes this message a valid WINDOWPOS, which a handler may change.
        let position = unsafe { &mut *(lparam.0 as *mut WINDOWPOS) };
        position.flags =
            SET_WINDOW_POS_FLAGS(shown_position_flags(position.flags.0, holds_foreground()));
    }
    unsafe { DefSubclassProc(window, message, wparam, lparam) }
}

/// Makes every later show of a window keep the front, whoever shows it. A framework that holds the visibility of its window shows it through
/// its own call, so that its state stays true. Call it on the UI thread of the window; a second call changes nothing.
pub fn keep_front_on_show(window: Handle) -> Result<(), String> {
    let installed =
        unsafe { SetWindowSubclass(HWND(window as *mut _), Some(keep_front), 1, 0) }.as_bool();
    if installed {
        Ok(())
    } else {
        Err(format!(
            "window show: the window {window:#x} did not take its position rule"
        ))
    }
}
