//! The thread of the web views: its waits and, with the diagnostics feature, the window that runs tasks of other threads on it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};

use crate::platform::devtools_input::Cancel;

thread_local! {
    /// The waits of the UI thread, by timer.
    static TIMERS: RefCell<HashMap<usize, Box<dyn FnOnce()>>> = RefCell::default();
}

pub(super) fn error(stage: &str, failure: impl fmt::Display) -> String {
    format!("{stage}: {failure}")
}

/// A timer that does not stop fires again and finds no task, so its failure is only recorded.
fn stop_timer(timer: usize) {
    if let Err(failure) = unsafe { KillTimer(None, timer) } {
        crate::application_log::log_error("input wait", failure);
    }
}

unsafe extern "system" fn timer_proc(_: HWND, _: u32, timer: usize, _: u32) {
    stop_timer(timer);
    let task = TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    if let Some(task) = task {
        task();
    }
}

/// Runs task on the UI thread after a wait, unless the returned function cancels it. Call it on the UI thread.
pub(super) fn after_on_ui_thread(wait: Duration, task: Box<dyn FnOnce()>) -> Cancel {
    // default: a wait longer than a timer can hold waits the longest it can
    let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
    let timer = unsafe { SetTimer(None, 0, millis, Some(timer_proc)) };
    if timer == 0 {
        // A process runs out of timers only when it is failing, and a wait must still end.
        crate::application_log::log_error("input wait", ::windows::core::Error::from_thread());
        task();
        return Box::new(|| {});
    }
    TIMERS.with(|timers| timers.borrow_mut().insert(timer, task));
    Box::new(move || {
        stop_timer(timer);
        TIMERS.with(|timers| timers.borrow_mut().remove(&timer));
    })
}

#[cfg(feature = "diagnostics")]
pub(super) use tasks::{on_ui_thread, post, start_task_window};

#[cfg(feature = "diagnostics")]
mod tasks {
    use std::sync::{Mutex, OnceLock};

    use ::windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
    use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use ::windows::Win32::System::Threading::GetCurrentThreadId;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, HWND_MESSAGE, PostMessageW, RegisterClassExW,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WNDCLASSEXW,
    };
    use ::windows::core::{PCWSTR, w};

    use super::error;

    const RUN_TASKS: u32 = WM_APP + 1;

    /// The window that runs tasks of other threads on the UI thread.
    struct TaskWindow {
        window: isize,
        thread: u32,
    }

    type Task = Box<dyn FnOnce() + Send>;

    static TASK_WINDOW: OnceLock<TaskWindow> = OnceLock::new();
    static TASKS: Mutex<Vec<Task>> = Mutex::new(Vec::new());

    unsafe extern "system" fn task_window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message != RUN_TASKS {
            return unsafe { DefWindowProcW(window, message, wparam, lparam) };
        }
        // default: a lock that a panicking thread poisoned still holds whole tasks; the panic hook records the panic.
        let tasks = std::mem::take(&mut *TASKS.lock().unwrap_or_else(|e| e.into_inner()));
        for task in tasks {
            task();
        }
        LRESULT(0)
    }

    /// Makes the calling thread the thread that [`post`] runs tasks on. Call it on the UI thread.
    pub(in super::super) fn start_task_window() -> Result<(), String> {
        if TASK_WINDOW.get().is_some() {
            return Ok(());
        }
        let instance: HMODULE = unsafe { GetModuleHandleW(PCWSTR::null()) }
            .map_err(|e| error("UI task window module", e))?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(task_window_proc),
            hInstance: instance.into(),
            lpszClassName: w!("soksak-ui-tasks"),
            ..Default::default()
        };
        if unsafe { RegisterClassExW(&class) } == 0 {
            return Err(error(
                "UI task window class",
                ::windows::core::Error::from_thread(),
            ));
        }
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("soksak-ui-tasks"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(instance.into()),
                None,
            )
        }
        .map_err(|e| error("UI task window", e))?;
        TASK_WINDOW
            .set(TaskWindow {
                window: window.0 as isize,
                thread: unsafe { GetCurrentThreadId() },
            })
            .map_err(|_| "the UI task window started twice")?;
        Ok(())
    }

    pub(in super::super) fn on_ui_thread() -> bool {
        TASK_WINDOW
            .get()
            .is_some_and(|task_window| task_window.thread == unsafe { GetCurrentThreadId() })
    }

    /// Runs a task as a later step of the UI thread, from any thread.
    pub(in super::super) fn post(task: Task) -> Result<(), String> {
        let task_window = TASK_WINDOW
            .get()
            .ok_or("no web view of this process has started the UI thread")?;
        // default: a lock that a panicking thread poisoned still holds whole tasks; the panic hook records the panic.
        TASKS.lock().unwrap_or_else(|e| e.into_inner()).push(task);
        unsafe {
            PostMessageW(
                Some(HWND(task_window.window as *mut _)),
                RUN_TASKS,
                WPARAM(0),
                LPARAM(0),
            )
        }
        .map_err(|e| error("UI task message", e))
    }
}
