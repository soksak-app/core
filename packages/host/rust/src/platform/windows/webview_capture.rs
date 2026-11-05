//! Still capture of a WebView2, through CapturePreview. A capture waits on the thread of its request, and CapturePreview runs and completes
//! on the UI thread.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use ::windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use ::windows::Win32::System::Com::{IStream, STREAM_SEEK_END, STREAM_SEEK_SET};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::System::Threading::GetCurrentThreadId;
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, HWND_MESSAGE, IsIconic, IsWindowVisible, PostMessageW,
    RegisterClassExW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WNDCLASSEXW,
};
use ::windows::core::{BOOL, PCWSTR, w};
use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;

use super::webview_input::{after, error, view_of};
use crate::framework::Window;
use crate::platform::Handle;
use crate::platform::devtools::{capture_refusal, capture_wait, check_still};

/// Limits a capture, whose completion is not promised ([`capture_wait`]).
const CAPTURE_WAIT: Duration = Duration::from_secs(10);

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
pub(super) fn start_task_window() -> Result<(), String> {
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

fn on_ui_thread() -> bool {
    TASK_WINDOW
        .get()
        .is_some_and(|task_window| task_window.thread == unsafe { GetCurrentThreadId() })
}

/// Runs a task as a later step of the UI thread, from any thread.
fn post(task: Task) -> Result<(), String> {
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

/// The window number of a window is its handle: a web view is no window of its own here.
pub fn window_numbers(window: &Window) -> Result<Vec<isize>, String> {
    let handle = window.native_window().map_err(|e| e.to_string())?;
    Ok(vec![handle as isize])
}

/// Writes one picture of the web view of the window to path as PNG. The wait runs on the caller's thread and the completion on the UI
/// thread, so a call on the UI thread would wait for itself.
pub fn capture_still(window_number: isize, path: &str) -> Result<(), String> {
    if on_ui_thread() {
        return Err(
            "capture: a capture waits for the UI thread, and it was called on that thread"
                .to_string(),
        );
    }
    let (ended, wait) = mpsc::channel();
    post(Box::new(move || {
        let done = {
            let ended = ended.clone();
            Box::new(move |picture| answer_capture(&ended, picture))
        };
        if let Err(failure) = start_capture(window_number as Handle, done) {
            answer_capture(&ended, Err(failure));
        }
    }))
    .map_err(|e| error("capture", e))?;
    let data = wait.recv().map_err(|e| error("capture", e))??;
    check_still(&data)?;
    std::fs::write(path, data).map_err(|e| error("capture", e))
}

/// Sends the end of a capture to its request, which is waiting unless its thread is gone.
fn answer_capture(ended: &mpsc::Sender<Result<Vec<u8>, String>>, picture: Result<Vec<u8>, String>) {
    if ended.send(picture).is_err() {
        crate::application_log::log_info("capture", "a capture ended after its request");
    }
}

/// Starts CapturePreview on the UI thread. The error is why it did not start, and otherwise done receives the end once.
fn start_capture(
    window: Handle,
    done: Box<dyn FnOnce(Result<Vec<u8>, String>)>,
) -> Result<(), String> {
    let view = view_of(window)?;
    let minimized = unsafe { IsIconic(view.window) }.as_bool();
    let shown = unsafe { IsWindowVisible(view.window) }.as_bool();
    let mut visible = BOOL::default();
    unsafe { view.controller.IsVisible(&mut visible) }
        .map_err(|e| error("capture: web view visibility", e))?;
    capture_refusal(minimized, shown, visible.as_bool())?;
    let core =
        unsafe { view.controller.CoreWebView2() }.map_err(|e| error("capture: web view", e))?;
    let stream = unsafe { CreateStreamOnHGlobal(Default::default(), true) }
        .map_err(|e| error("capture: stream", e))?;
    let read = stream.clone();
    let finish = capture_wait(
        &after(),
        CAPTURE_WAIT,
        Box::new(move |result| done(result.and_then(|()| stream_bytes(&read)))),
    );
    let finish = Rc::new(RefCell::new(Some(finish)));
    let completed = finish.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        if let Some(finish) = completed.borrow_mut().take() {
            finish(result.map_err(|e| error("capture: CapturePreview", e)));
        }
        Ok(())
    }));
    let started = unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
    };
    if let Err(failure) = started
        && let Some(finish) = finish.borrow_mut().take()
    {
        finish(Err(error("capture: CapturePreview", failure)));
    }
    Ok(())
}

/// Reads a whole stream.
fn stream_bytes(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut size = 0u64;
    unsafe { stream.Seek(0, STREAM_SEEK_END, Some(&mut size)) }
        .map_err(|e| error("capture: stream size", e))?;
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|e| error("capture: stream start", e))?;
    let mut data = vec![0u8; size as usize];
    if data.is_empty() {
        return Ok(data);
    }
    let mut read = 0u32;
    unsafe { stream.Read(data.as_mut_ptr().cast(), size as u32, Some(&mut read)) }
        .ok()
        .map_err(|e| error("capture: stream read", e))?;
    data.truncate(read as usize);
    Ok(data)
}
