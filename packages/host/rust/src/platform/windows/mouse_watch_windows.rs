//! The source of the mouse buttons and of the window input: the raw input of the system, with no hook. A raw input is a
//! copy that the system sends beside the input, so a person's input never waits for this process. The registration
//! receives the mouse inputs of every application, because host.buttons reports them, and it does not register the
//! keyboard.
//!
//! Its limits: the source thread wakes at every move of the mouse, also over other applications; touch and pen input
//! that the system does not send as raw mouse input are not seen; a press is read at the place of the pointer when the
//! source reads it, not when the button changed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use ::windows::Win32::Graphics::Gdi::ScreenToClient;
use ::windows::Win32::UI::HiDpi::GetDpiForWindow;
use ::windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use ::windows::Win32::UI::Input::{
    GetRawInputData, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_INPUT,
    RIDEV_INPUTSINK, RIM_TYPEMOUSE, RegisterRawInputDevices,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, DispatchMessageW, GA_PARENT, GA_ROOT, GetAncestor, GetCursorPos, GetMessageW,
    GetSystemMetrics, MSG, SM_SWAPBUTTON, WM_INPUT, WindowFromPoint,
};
use ::windows::core::w;

use super::ui_thread::{error, message_window, post, start_task_window};
use crate::application_log::log_error;
use crate::platform::Handle;
use crate::platform::mouse_watch::{
    InputWatch, MouseReader, MouseStep, MouseSystem, MouseWatches, add_watch, buttons_held,
    remove_watch, set_mask, start_reports,
};

const USAGE_PAGE_GENERIC: u16 = 0x01;
const USAGE_MOUSE: u16 = 0x02;
const PAGE_DOTS_PER_INCH: f64 = 96.0;

static WATCHES: Mutex<MouseWatches> = Mutex::new(MouseWatches::new());
static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
static CHANGED: OnceLock<Box<dyn Fn(u64) + Send + Sync>> = OnceLock::new();

thread_local! {
    /// The reader, on the thread of the source.
    static READER: RefCell<Option<MouseReader<'static, SystemMouse>>> = const { RefCell::new(None) };
    /// The watches, on the UI thread.
    static INPUT_WATCHES: RefCell<HashMap<Handle, Rc<InputWatch>>> = RefCell::new(HashMap::new());
}

struct SystemMouse;

fn cursor() -> Result<POINT, String> {
    let mut at = POINT::default();
    unsafe { GetCursorPos(&mut at) }.map_err(|e| error("mouse input: the pointer position", e))?;
    Ok(at)
}

impl MouseSystem for SystemMouse {
    fn swapped(&self) -> bool {
        unsafe { GetSystemMetrics(SM_SWAPBUTTON) != 0 }
    }

    fn hit(&self) -> Result<Option<(Handle, Vec<Handle>)>, String> {
        let hit = unsafe { WindowFromPoint(cursor()?) };
        if hit.is_invalid() {
            return Ok(None);
        }
        let root = unsafe { GetAncestor(hit, GA_ROOT) };
        let mut views = Vec::new();
        let mut view = hit;
        while !view.is_invalid() && view != root {
            views.push(view.0 as Handle);
            view = unsafe { GetAncestor(view, GA_PARENT) };
        }
        Ok(Some((root.0 as Handle, views)))
    }

    fn position(&self, window: Handle) -> Result<(f64, f64), String> {
        let target = HWND(window as *mut _);
        let mut at = cursor()?;
        if !unsafe { ScreenToClient(target, &mut at) }.as_bool() {
            return Err(error(
                &format!("mouse input: the pointer in window {window:#x}"),
                ::windows::core::Error::from_thread(),
            ));
        }
        let dots = unsafe { GetDpiForWindow(target) };
        if dots == 0 {
            return Err(error(
                &format!("mouse input: the scale of window {window:#x}"),
                ::windows::core::Error::from_thread(),
            ));
        }
        let scale = f64::from(dots) / PAGE_DOTS_PER_INCH;
        Ok((f64::from(at.x) / scale, f64::from(at.y) / scale))
    }
}

/// Runs one step on the UI thread. A step of a watch that ended does nothing.
fn run_step(step: MouseStep) {
    let watch_of = |monitor: Handle| INPUT_WATCHES.with(|all| all.borrow().get(&monitor).cloned());
    match step {
        MouseStep::Buttons(mask) => {
            if let Some(changed) = CHANGED.get() {
                changed(mask);
            }
        }
        MouseStep::Press {
            monitor,
            views,
            x,
            y,
        } => {
            if let Some(watch) = watch_of(monitor) {
                watch.press(views, x, y);
            }
        }
        MouseStep::Move { monitor, x, y } => {
            if let Some(watch) = watch_of(monitor) {
                watch.moved(x, y);
            }
        }
        MouseStep::Release { monitor, x, y } => {
            if let Some(watch) = watch_of(monitor) {
                watch.release(x, y);
            }
        }
    }
}

/// Reads the button flags of a WM_INPUT message. The answer is None for an input that is not of the mouse.
fn read_raw_mouse(lparam: LPARAM) -> Result<Option<u16>, String> {
    let mut input = RAWINPUT::default();
    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let read = unsafe {
        GetRawInputData(
            HRAWINPUT(lparam.0 as *mut _),
            RID_INPUT,
            Some(std::ptr::from_mut(&mut input).cast()),
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        )
    };
    if read == u32::MAX {
        return Err(error(
            "mouse input: the raw input",
            ::windows::core::Error::from_thread(),
        ));
    }
    if input.header.dwType != RIM_TYPEMOUSE.0 {
        return Ok(None);
    }
    // SAFETY: the header says that the union holds a mouse input, and every bit pattern is a valid value of its fields.
    Ok(Some(unsafe {
        input.data.mouse.Anonymous.Anonymous.usButtonFlags
    }))
}

fn handle_input(lparam: LPARAM) {
    let flags = match read_raw_mouse(lparam) {
        Ok(Some(flags)) => flags,
        Ok(None) => return,
        Err(failure) => {
            log_error("mouse input", failure);
            return;
        }
    };
    let result = READER.with(|reader| {
        reader
            .borrow_mut()
            .as_mut()
            .map(|reader| reader.receive(flags))
    });
    let Some((steps, failures)) = result else {
        return;
    };
    for failure in failures {
        log_error("mouse input", failure);
    }
    for step in steps {
        if let Err(failure) = post(Box::new(move || run_step(step))) {
            log_error("mouse input", failure);
        }
    }
}

unsafe extern "system" fn mouse_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT {
        handle_input(lparam);
    }
    // A WM_INPUT also needs the default handling, which releases the input.
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// Registers for the raw mouse input and reads the buttons held at that point. An input of the time between the two is
/// handled after them, and applying a press to a mask that holds it changes nothing.
fn register_source() -> Result<(), String> {
    let window = message_window(
        w!("soksak-mouse-input"),
        Some(mouse_window_proc),
        "mouse input window",
    )?;
    let device = RAWINPUTDEVICE {
        usUsagePage: USAGE_PAGE_GENERIC,
        usUsage: USAGE_MOUSE,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: window,
    };
    unsafe { RegisterRawInputDevices(&[device], std::mem::size_of::<RAWINPUTDEVICE>() as u32) }
        .map_err(|e| error("mouse input registration", e))?;
    set_mask(
        &WATCHES,
        buttons_held(|key| unsafe { GetAsyncKeyState(key) } < 0),
    );
    READER.with(|reader| *reader.borrow_mut() = Some(MouseReader::new(SystemMouse, &WATCHES)));
    Ok(())
}

fn run_source(started: mpsc::Sender<Result<(), String>>) {
    let registered = register_source();
    let failed = registered.is_err();
    if started.send(registered).is_err() || failed {
        return;
    }
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
        // The result of a dispatch is the result of the window procedure, which logs its own failures.
        unsafe { DispatchMessageW(&message) };
    }
    // Only WM_QUIT or a failure ends the loop, and nothing asks this thread to quit.
    log_error("mouse input", "the source thread ended");
}

/// Starts the source once. Call it on the UI thread, which then runs the steps.
fn start_source() -> Result<(), String> {
    STARTED
        .get_or_init(|| {
            start_task_window()?;
            let (started, wait) = mpsc::channel();
            crate::routine::spawn_named("mouse-input", move || run_source(started));
            wait.recv().map_err(|e| error("mouse input source", e))?
        })
        .clone()
}

/// Delivers the presses and the drags of the window, read from raw input. The key inputs are not watched, because the
/// keyboard is not registered. Call it on the UI thread.
pub fn watch_input(
    window: Handle,
    pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
    pointed: Box<dyn Fn(u8, f64, f64)>,
) -> Result<Handle, String> {
    start_source()?;
    let (monitor, dragging) = add_watch(&WATCHES, window);
    let watch = Rc::new(InputWatch {
        pressed,
        pointed,
        dragging: Arc::clone(&dragging),
    });
    INPUT_WATCHES.with(|all| all.borrow_mut().insert(monitor, watch));
    Ok(monitor)
}

/// Ends the watch that [`watch_input`] returned. Call it on the UI thread.
pub fn unwatch_input(monitor: Handle) -> Result<(), String> {
    remove_watch(&WATCHES, monitor);
    INPUT_WATCHES.with(|all| all.borrow_mut().remove(&monitor));
    Ok(())
}

/// Reports the mouse buttons of every application, read from raw input. Call it once on the UI thread.
pub fn watch_buttons(changed: Box<dyn Fn(u64) + Send + Sync>) -> Result<(), String> {
    start_source()?;
    CHANGED
        .set(changed)
        .map_err(|_| "the mouse buttons are already watched".to_string())?;
    let mask = start_reports(&WATCHES)?;
    if let Some(changed) = CHANGED.get() {
        changed(mask);
    }
    Ok(())
}
