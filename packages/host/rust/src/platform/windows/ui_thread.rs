//! The thread of the web views: its waits, and the window that runs tasks of other threads on it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

use ::windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::System::Threading::GetCurrentThreadId;
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, HWND_MESSAGE, KillTimer, PostMessageW, RegisterClassExW,
    SetTimer, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WNDCLASSEXW, WNDPROC,
};
use ::windows::core::{PCWSTR, w};

use crate::application_log::log_error;
use crate::platform::devtools_input::Cancel;
use crate::platform::ui_queue::{Task, UiQueue};

const RUN_TASKS: u32 = WM_APP + 1;

/// The thread that started the task window.
static STARTED: OnceLock<u32> = OnceLock::new();
/// The queue of the UI thread.
static TASKS: LazyLock<Arc<UiQueue>> = LazyLock::new(|| {
    Arc::new(UiQueue::new(
        Box::new(|wait, fire| {
            crate::routine::spawn_named("ui-delay", move || {
                std::thread::sleep(wait);
                fire();
            });
        }),
        Box::new(|failure| log_error("UI task", failure)),
    ))
});

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

unsafe extern "system" fn task_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message != RUN_TASKS {
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    }
    TASKS.run();
    LRESULT(0)
}

/// Registers a window class of that name and creates a message-only window of it on this thread. place names the
/// window in an error.
pub(super) fn message_window(
    class_name: PCWSTR,
    proc: WNDPROC,
    place: &str,
) -> Result<HWND, String> {
    let instance: HMODULE = unsafe { GetModuleHandleW(PCWSTR::null()) }
        .map_err(|e| error(&format!("{place} module"), e))?;
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: proc,
        hInstance: instance.into(),
        lpszClassName: class_name,
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        return Err(error(
            &format!("{place} class"),
            ::windows::core::Error::from_thread(),
        ));
    }
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
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
    .map_err(|e| error(place, e))
}

/// Makes the calling thread the thread that [`post`] runs tasks on. Call it on the UI thread.
pub(super) fn start_task_window() -> Result<(), String> {
    if STARTED.get().is_some() {
        return Ok(());
    }
    let window = message_window(
        w!("soksak-ui-tasks"),
        Some(task_window_proc),
        "UI task window",
    )?;
    let window = window.0 as isize;
    TASKS.start(Box::new(move || {
        unsafe {
            PostMessageW(
                Some(HWND(window as *mut _)),
                RUN_TASKS,
                WPARAM(0),
                LPARAM(0),
            )
        }
        .map_err(|e| e.to_string())
    }));
    STARTED
        .set(unsafe { GetCurrentThreadId() })
        .map_err(|_| "the UI task window started twice".to_string())
}

#[cfg(feature = "diagnostics")]
pub(super) fn on_ui_thread() -> bool {
    STARTED
        .get()
        .is_some_and(|thread| *thread == unsafe { GetCurrentThreadId() })
}

/// Runs a task as a later step of the UI thread, from any thread. A task that it refuses never runs.
pub(super) fn post(task: Task) -> Result<(), String> {
    TASKS.add(task)
}

/// Runs work once as a later step of the UI thread, in the order of the calls.
pub fn enqueue_ui(work: Task) -> Result<(), String> {
    TASKS.add(work)
}

/// Runs work once as a later step of the UI thread after delay.
pub fn enqueue_ui_after(delay: Duration, work: Task) -> Result<(), String> {
    UiQueue::add_after(&TASKS, delay, work)
}
