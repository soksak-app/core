//! The mouse buttons and the window input of Windows, read from raw mouse input. The reading of the system is in
//! [`MouseSystem`], so that this logic runs in the tests of every platform.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use super::Handle;

/// One button of a raw mouse input: its flags in `RAWMOUSE.usButtonFlags`, its bit in the mask of host.buttons, and
/// its virtual key.
struct MouseButton {
    down: u16,
    up: u16,
    bit: u64,
    key: i32,
}

const fn button(down: u16, up: u16, bit: u64, key: i32) -> MouseButton {
    MouseButton { down, up, bit, key }
}

const LEFT: usize = 0;
const RIGHT: usize = 1;
const MOUSE_BUTTONS: [MouseButton; 5] = [
    button(0x0001, 0x0002, 1 << 0, 0x01),
    button(0x0004, 0x0008, 1 << 1, 0x02),
    button(0x0010, 0x0020, 1 << 2, 0x04),
    button(0x0040, 0x0080, 1 << 3, 0x05),
    button(0x0100, 0x0200, 1 << 4, 0x06),
];

/// Reads the mask of the held buttons from the state of their virtual keys.
pub fn buttons_held(held: impl Fn(i32) -> bool) -> u64 {
    MOUSE_BUTTONS
        .iter()
        .filter(|button| held(button.key))
        .fold(0, |mask, button| mask | button.bit)
}

/// Applies the flags of one input to a mask, and tells whether the flags name a button at all, because the other
/// flags are the wheels. An input that names both changes of a button ended with that button released.
fn next_buttons(mut mask: u64, flags: u16) -> (u64, bool) {
    let mut named = false;
    for button in &MOUSE_BUTTONS {
        if flags & button.down != 0 {
            mask |= button.bit;
            named = true;
        }
        if flags & button.up != 0 {
            mask &= !button.bit;
            named = true;
        }
    }
    (mask, named)
}

/// Reads the press and the release of the primary button, the one that the system maps to the left button of a page.
/// A raw input names the physical button, and the system setting exchanges the two.
fn primary_change(flags: u16, swapped: bool) -> (bool, bool) {
    let button = &MOUSE_BUTTONS[if swapped { RIGHT } else { LEFT }];
    (flags & button.down != 0, flags & button.up != 0)
}

/// What the reader reads of the system at an input.
pub trait MouseSystem {
    /// Whether the system exchanges the primary and the secondary button.
    fn swapped(&self) -> bool;
    /// The top window under the pointer and its views from the hit view upward. The window is not one of them.
    fn hit(&self) -> Result<Option<(Handle, Vec<Handle>)>, String>;
    /// The pointer in the page coordinates of the window.
    fn position(&self, window: Handle) -> Result<(f64, f64), String>;
}

/// A report or a step that runs on the UI thread.
#[derive(Debug, PartialEq)]
pub enum MouseStep {
    Buttons(u64),
    Press {
        monitor: Handle,
        views: Vec<Handle>,
        x: f64,
        y: f64,
    },
    Move {
        monitor: Handle,
        x: f64,
        y: f64,
    },
    Release {
        monitor: Handle,
        x: f64,
        y: f64,
    },
}

#[derive(Clone)]
struct Watched {
    monitor: Handle,
    window: Handle,
    dragging: Arc<AtomicBool>,
}

/// The state that the UI thread and the reader share.
pub struct MouseWatches {
    mask: u64,
    reporting: bool,
    watched: Vec<Watched>,
    last: Handle,
}

impl MouseWatches {
    pub const fn new() -> Self {
        Self {
            mask: 0,
            reporting: false,
            watched: Vec::new(),
            last: 0,
        }
    }
}

fn locked(watches: &Mutex<MouseWatches>) -> std::sync::MutexGuard<'_, MouseWatches> {
    // default: a lock that a panicking thread poisoned still holds whole values; the panic hook records the panic.
    watches.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Sets the buttons held when the source started.
pub fn set_mask(watches: &Mutex<MouseWatches>, mask: u64) {
    locked(watches).mask = mask;
}

/// Starts the reports of the mask and returns the current mask. Call it on the UI thread: a report of a later input
/// runs as a later step of that thread.
pub fn start_reports(watches: &Mutex<MouseWatches>) -> Result<u64, String> {
    let mut watches = locked(watches);
    if watches.reporting {
        return Err("the mouse buttons are already watched".into());
    }
    watches.reporting = true;
    Ok(watches.mask)
}

/// Starts to read the input of a window and returns the number of the watch and the flag that keeps the moves of a
/// drag that the page handles away from the UI thread.
pub fn add_watch(watches: &Mutex<MouseWatches>, window: Handle) -> (Handle, Arc<AtomicBool>) {
    let mut watches = locked(watches);
    watches.last += 1;
    let monitor = watches.last;
    let dragging = Arc::new(AtomicBool::new(false));
    watches.watched.push(Watched {
        monitor,
        window,
        dragging: dragging.clone(),
    });
    (monitor, dragging)
}

/// Ends the reading of a watch.
pub fn remove_watch(watches: &Mutex<MouseWatches>, monitor: Handle) {
    locked(watches)
        .watched
        .retain(|watched| watched.monitor != monitor);
}

/// Turns the raw mouse inputs into reports and steps. It runs on the thread of the source, so the reading of a hit,
/// which may wait for another process, never holds the UI thread, and a move that nothing watches never wakes it.
pub struct MouseReader<'a, M> {
    pub system: M,
    pub watches: &'a Mutex<MouseWatches>,
    pressed: Option<Watched>,
    last: (f64, f64),
}

impl<'a, M: MouseSystem> MouseReader<'a, M> {
    pub fn new(system: M, watches: &'a Mutex<MouseWatches>) -> Self {
        Self {
            system,
            watches,
            pressed: None,
            last: (0.0, 0.0),
        }
    }

    /// Handles the button flags of one raw mouse input, and returns the steps in their order and the failures of the
    /// reading. An input without a button is a move or a wheel.
    pub fn receive(&mut self, flags: u16) -> (Vec<MouseStep>, Vec<String>) {
        let mut steps = Vec::new();
        let mut failures = Vec::new();
        self.report_buttons(flags, &mut steps);
        let (down, up) = if flags == 0 {
            (false, false)
        } else {
            primary_change(flags, self.system.swapped())
        };
        if down {
            self.press_step(&mut steps, &mut failures);
        }
        if up {
            self.release_step(&mut steps, &mut failures);
        }
        if !down && !up {
            self.move_step(&mut steps, &mut failures);
        }
        (steps, failures)
    }

    fn report_buttons(&self, flags: u16, steps: &mut Vec<MouseStep>) {
        let mut watches = locked(self.watches);
        let (mask, named) = next_buttons(watches.mask, flags);
        if !named {
            return;
        }
        watches.mask = mask;
        if watches.reporting {
            steps.push(MouseStep::Buttons(mask));
        }
    }

    fn press_step(&mut self, steps: &mut Vec<MouseStep>, failures: &mut Vec<String>) {
        self.pressed = None;
        let (window, views) = match self.system.hit() {
            Ok(Some(hit)) => hit,
            Ok(None) => return,
            Err(failure) => {
                failures.push(failure);
                return;
            }
        };
        let watched = locked(self.watches)
            .watched
            .iter()
            .find(|watched| watched.window == window)
            .cloned();
        let Some(watched) = watched else {
            return;
        };
        match self.system.position(window) {
            Ok((x, y)) => {
                steps.push(MouseStep::Press {
                    monitor: watched.monitor,
                    views,
                    x,
                    y,
                });
                self.last = (x, y);
                self.pressed = Some(watched);
            }
            Err(failure) => failures.push(failure),
        }
    }

    fn release_step(&mut self, steps: &mut Vec<MouseStep>, failures: &mut Vec<String>) {
        let Some(watched) = self.pressed.take() else {
            return;
        };
        let (x, y) = match self.system.position(watched.window) {
            Ok(position) => position,
            Err(failure) => {
                // The release still ends the drag that the page holds, at the last place that the pointer was read.
                failures.push(failure);
                self.last
            }
        };
        steps.push(MouseStep::Release {
            monitor: watched.monitor,
            x,
            y,
        });
    }

    fn move_step(&mut self, steps: &mut Vec<MouseStep>, failures: &mut Vec<String>) {
        let Some(watched) = &self.pressed else {
            return;
        };
        if !watched.dragging.load(Ordering::Acquire) {
            return;
        }
        let monitor = watched.monitor;
        match self.system.position(watched.window) {
            Ok(position) if position == self.last => {}
            Ok((x, y)) => {
                self.last = (x, y);
                steps.push(MouseStep::Move { monitor, x, y });
            }
            Err(failure) => failures.push(failure),
        }
    }
}

/// Delivers the input of one window. Call its functions on the UI thread.
pub struct InputWatch {
    pub pressed: Box<dyn Fn(Vec<Handle>) -> bool>,
    pub pointed: Box<dyn Fn(u8, f64, f64)>,
    pub dragging: Arc<AtomicBool>,
}

impl InputWatch {
    pub fn press(&self, views: Vec<Handle>, x: f64, y: f64) {
        let dragging = (self.pressed)(views);
        self.dragging.store(dragging, Ordering::Release);
        if dragging {
            (self.pointed)(0, x, y);
        }
    }

    pub fn moved(&self, x: f64, y: f64) {
        if self.dragging.load(Ordering::Acquire) {
            (self.pointed)(1, x, y);
        }
    }

    pub fn release(&self, x: f64, y: f64) {
        if self.dragging.swap(false, Ordering::AcqRel) {
            (self.pointed)(2, x, y);
        }
    }
}

#[cfg(test)]
#[path = "mouse_watch_test.rs"]
mod tests;
