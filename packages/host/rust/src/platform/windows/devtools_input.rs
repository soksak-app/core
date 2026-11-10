//! What a WebView2 receives for pointer and key input, and the order of its calls. It holds no COM call, so it also runs where
//! WebView2 does not exist.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};

use crate::platform::{Delivery, Key, Pointer, PointerHeld};

const PHASE_MOVE: i32 = 0;
const PHASE_PRESS: i32 = 1;
const PHASE_DRAG: i32 = 2;
const PHASE_RELEASE: i32 = 3;
const PHASE_SCROLL: i32 = 4;

/// The largest click count of a press and a release, as on the other platforms.
const MAX_CLICKS: i32 = 3;

/// One call of the DevTools protocol, with its parameters as JSON.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Call {
    pub(crate) method: &'static str,
    pub(crate) params: String,
}

impl Call {
    fn new(method: &'static str, params: Value) -> Self {
        Self {
            method,
            params: params.to_string(),
        }
    }
}

/// The open press of each button of a window and the pointer that holds them. A page has one mouse pointer, so a window
/// holds one press of each button, all of one pointer.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PressState {
    pub(crate) open: [bool; 2],
    /// The pointer of the open presses; it is None while no press is open.
    pub(crate) holder: Option<String>,
}

/// The reason of a Delivery::PointerHeld rejection: the page has one mouse pointer, which the presses of the holder take.
pub(crate) const POINTER_HELD_REASON: &str = "the page has one mouse pointer";

impl PressState {
    /// The protocol's mask of the open presses, with the button changed to pressed.
    fn buttons(&self, changed: Option<(usize, bool)>) -> u8 {
        let mut open = self.open;
        if let Some((button, pressed)) = changed {
            open[button] = pressed;
        }
        u8::from(open[0]) | u8::from(open[1]) << 1
    }

    /// The call that delivers a pointer input, or the result of an input that is not sent. The coordinates are CSS pixels of the web view
    /// at the content area of the window. It keeps the press rules of the other platforms: a button has one press, and a drag and a release
    /// need it. While another pointer holds a press, a move, a press, a drag and a release are PointerHeld, and a scroll is sent.
    pub(crate) fn call(&self, pointer: &Pointer) -> Result<Call, Delivery> {
        let button = match pointer.button {
            0 => 0,
            1 => 1,
            _ => return Err(Delivery::Rejected),
        };
        if let Some(holder) = &self.holder
            && *holder != pointer.pointer
            && pointer.phase != PHASE_SCROLL
        {
            return Err(Delivery::PointerHeld(PointerHeld {
                pointer: holder.clone(),
                reason: POINTER_HELD_REASON.to_string(),
            }));
        }
        let name = ["left", "right"][button];
        let clicks = pointer.clicks;
        let valid_clicks = (1..=MAX_CLICKS).contains(&clicks);
        let (kind, named, count, buttons) = match pointer.phase {
            PHASE_MOVE => ("mouseMoved", "none", 0, self.buttons(None)),
            PHASE_SCROLL => ("mouseWheel", "none", 0, self.buttons(None)),
            PHASE_PRESS => {
                if self.open[button] {
                    return Err(Delivery::PressOpen);
                }
                if !valid_clicks {
                    return Err(Delivery::Rejected);
                }
                (
                    "mousePressed",
                    name,
                    clicks,
                    self.buttons(Some((button, true))),
                )
            }
            PHASE_DRAG => {
                if !self.open[button] {
                    return Err(Delivery::Rejected);
                }
                ("mouseMoved", name, 0, self.buttons(None))
            }
            PHASE_RELEASE => {
                if !self.open[button] || !valid_clicks {
                    return Err(Delivery::Rejected);
                }
                (
                    "mouseReleased",
                    name,
                    clicks,
                    self.buttons(Some((button, false))),
                )
            }
            _ => return Err(Delivery::Rejected),
        };
        let mut event = json!({
            "type": kind, "x": pointer.x, "y": pointer.y, "button": named, "buttons": buttons, "clickCount": count,
        });
        if pointer.phase == PHASE_SCROLL {
            event["deltaX"] = json!(pointer.delta_x);
            event["deltaY"] = json!(pointer.delta_y);
        }
        Ok(Call::new("Input.dispatchMouseEvent", event))
    }

    /// Records a pointer input of pointer that reached the page. An input that failed leaves the press as it was.
    pub(crate) fn delivered(&mut self, pointer: &str, phase: i32, button: i32) {
        let button = usize::from(button == 1);
        match phase {
            PHASE_PRESS => {
                self.open[button] = true;
                self.holder = Some(pointer.to_string());
            }
            PHASE_RELEASE => {
                self.open[button] = false;
                if self.open == [false, false] {
                    self.holder = None;
                }
            }
            _ => {}
        }
    }
}

/// A key of `input.key`.
#[derive(Clone)]
struct FoundKey {
    key: String,
    code: Option<(String, u32)>,
    text: String,
}

/// The key names of `input.key` (docs/spec/exposure.md).
static NAMED_KEYS: LazyLock<HashMap<&'static str, FoundKey>> = LazyLock::new(|| {
    let named = |key: &str, code: &str, virtual_key: u32, text: &str| FoundKey {
        key: key.to_string(),
        code: Some((code.to_string(), virtual_key)),
        text: text.to_string(),
    };
    HashMap::from([
        ("Enter", named("Enter", "Enter", 0x0D, "\r")),
        ("Tab", named("Tab", "Tab", 0x09, "\t")),
        ("Escape", named("Escape", "Escape", 0x1B, "")),
        ("Backspace", named("Backspace", "Backspace", 0x08, "")),
        ("Delete", named("Delete", "Delete", 0x2E, "")),
        ("Space", named(" ", "Space", 0x20, " ")),
        ("ArrowLeft", named("ArrowLeft", "ArrowLeft", 0x25, "")),
        ("ArrowUp", named("ArrowUp", "ArrowUp", 0x26, "")),
        ("ArrowRight", named("ArrowRight", "ArrowRight", 0x27, "")),
        ("ArrowDown", named("ArrowDown", "ArrowDown", 0x28, "")),
        ("Home", named("Home", "Home", 0x24, "")),
        ("End", named("End", "End", 0x23, "")),
        ("PageUp", named("PageUp", "PageUp", 0x21, "")),
        ("PageDown", named("PageDown", "PageDown", 0x22, "")),
    ])
});

/// The key of one character. A letter and a digit have a physical key, and any other character has only its text.
fn character_key(name: &str) -> Option<FoundKey> {
    let mut characters = name.chars();
    let character = characters.next()?;
    if characters.next().is_some() {
        return None;
    }
    let upper = character.to_ascii_uppercase();
    let code = if upper.is_ascii_uppercase() {
        Some((format!("Key{upper}"), upper as u32))
    } else if character.is_ascii_digit() {
        Some((format!("Digit{character}"), character as u32))
    } else {
        None
    };
    Some(FoundKey {
        key: name.to_string(),
        code,
        text: name.to_string(),
    })
}

const SHIFT: u32 = 1;
const CONTROL: u32 = 2;
const OPTION: u32 = 4;
const COMMAND: u32 = 8;

/// The protocol's bit sum of the modifiers of `input.key`: Alt 1, Ctrl 2, Meta 4, Shift 8.
fn protocol_modifiers(modifiers: u32) -> u32 {
    let mut bits = 0;
    if modifiers & OPTION != 0 {
        bits |= 1;
    }
    if modifiers & CONTROL != 0 {
        bits |= 2;
    }
    if modifiers & COMMAND != 0 {
        bits |= 4;
    }
    if modifiers & SHIFT != 0 {
        bits |= 8;
    }
    bits
}

/// The call that delivers a key input. A key types the given text, and without one its own characters unless Control, Option or Command
/// holds it. A key that types nothing goes down as rawKeyDown, which inserts nothing.
pub(crate) fn key_call(key: &Key) -> Result<Call, Delivery> {
    let found = NAMED_KEYS
        .get(key.key.as_str())
        .cloned()
        .or_else(|| character_key(&key.key))
        .ok_or(Delivery::Rejected)?;
    let mut event = json!({"key": found.key, "modifiers": protocol_modifiers(key.modifiers)});
    if let Some((code, virtual_key)) = &found.code {
        event["code"] = json!(code);
        event["windowsVirtualKeyCode"] = json!(virtual_key);
    }
    if !key.down {
        event["type"] = json!("keyUp");
        return Ok(Call::new("Input.dispatchKeyEvent", event));
    }
    // default: a key without given text types the text of the key itself
    let given = key.text.as_deref().unwrap_or("");
    let types = if !given.is_empty() {
        given
    } else if key.modifiers & (CONTROL | OPTION | COMMAND) == 0 {
        found.text.as_str()
    } else {
        ""
    };
    if types.is_empty() {
        event["type"] = json!("rawKeyDown");
    } else {
        event["type"] = json!("keyDown");
        event["text"] = json!(types);
        event["unmodifiedText"] = json!(types);
    }
    Ok(Call::new("Input.dispatchKeyEvent", event))
}

/// Makes a page count as active. Its `:focus` needs that, and a window behind others is not active.
pub(crate) fn focus_emulation() -> Call {
    Call::new(
        "Emulation.setFocusEmulationEnabled",
        json!({"enabled": true}),
    )
}

/// How a call of a queue ended without success.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum InputFailure {
    /// The page or the web view ended before the call completed, so the page did not receive its input.
    WebviewEnded,
    Failed(String),
}

/// The text of [`InputFailure::WebviewEnded`].
pub(crate) const WEBVIEW_ENDED: &str = "the web view ended before the input completed";

/// The result of a pointer input from the answer of its call.
pub(crate) fn pointer_delivery(result: &Result<(), InputFailure>) -> Delivery {
    match result {
        Ok(()) => Delivery::Delivered,
        Err(InputFailure::WebviewEnded) => Delivery::Unreceived,
        Err(InputFailure::Failed(_)) => Delivery::Rejected,
    }
}

pub(crate) type Answer = Box<dyn FnOnce(Result<(), InputFailure>)>;
/// Receives the end of a call: nothing, or the error text of the web view.
pub(crate) type Complete = Box<dyn FnOnce(Result<(), String>)>;
pub(crate) type Cancel = Box<dyn FnOnce()>;
/// The work that a wait runs at its end.
pub(crate) type Task = Box<dyn FnOnce()>;
pub(crate) type After = Rc<dyn Fn(Duration, Task) -> Cancel>;

/// What an [`InputQueue`] needs of its web view.
pub(crate) trait Transport {
    /// Starts a call, and complete runs when it ends. An error means that complete does not run.
    fn send(&self, call: &Call, complete: Complete) -> Result<(), String>;
}

struct Entry {
    call: Call,
    /// None for an input that answered when it was queued.
    answer: RefCell<Option<Answer>>,
}

#[derive(Default)]
struct QueueState {
    waiting: VecDeque<Rc<Entry>>,
    current: Option<Rc<Entry>>,
    /// The failure of a call that has no answer, which the next input reports.
    failed: Option<String>,
    /// Whether the focus emulation was asked for.
    focused: bool,
    /// Whether the web view ended, after which no call is sent.
    ended: bool,
}

struct QueueInner {
    transport: Box<dyn Transport>,
    state: RefCell<QueueState>,
}

/// Sends the calls of one web view. The protocol may process calls out of order, so a call starts when the one before it completed. A call
/// ends by its completion or by the end of its page or its web view, and nothing else ends it. Use it on the UI thread: a completion ends
/// there.
#[derive(Clone)]
pub(crate) struct InputQueue(Rc<QueueInner>);

impl InputQueue {
    pub(crate) fn new(transport: Box<dyn Transport>) -> Self {
        Self(Rc::new(QueueInner {
            transport,
            state: RefCell::default(),
        }))
    }

    /// Queues a call, and answer receives its end. The error is why the input was not queued: the end of the web view, or the failure of an
    /// earlier call with no answer.
    pub(crate) fn push(&self, call: Call, answer: Option<Answer>) -> Result<(), String> {
        {
            let mut state = self.0.state.borrow_mut();
            if state.ended {
                return Err(WEBVIEW_ENDED.to_string());
            }
            if let Some(failed) = state.failed.take() {
                return Err(failed);
            }
            if !state.focused {
                state.focused = true;
                state.waiting.push_back(Rc::new(Entry {
                    call: focus_emulation(),
                    answer: RefCell::new(None),
                }));
            }
            state.waiting.push_back(Rc::new(Entry {
                call,
                answer: RefCell::new(answer),
            }));
        }
        Self::next(&self.0);
        Ok(())
    }

    /// Starts the first waiting call, unless a call has not completed.
    fn next(inner: &Rc<QueueInner>) {
        loop {
            let entry = {
                let mut state = inner.state.borrow_mut();
                if state.ended || state.current.is_some() {
                    return;
                }
                let Some(entry) = state.waiting.pop_front() else {
                    return;
                };
                state.current = Some(entry.clone());
                entry
            };
            let complete = {
                let (inner, entry) = (inner.clone(), entry.clone());
                Box::new(move |result: Result<(), String>| Self::completed(&inner, &entry, result))
            };
            if let Err(error) = inner.transport.send(&entry.call, complete) {
                Self::completed(inner, &entry, Err(error));
            }
        }
    }

    /// Ends a call and starts the next one. The completion of a call that the end of its page or its web view answered answers nothing.
    fn completed(inner: &Rc<QueueInner>, entry: &Rc<Entry>, result: Result<(), String>) {
        {
            let mut state = inner.state.borrow_mut();
            if !state
                .current
                .as_ref()
                .is_some_and(|current| Rc::ptr_eq(current, entry))
            {
                return;
            }
            state.current = None;
        }
        let answer = entry.answer.borrow_mut().take();
        match (answer, result) {
            (Some(answer), result) => answer(result.map_err(InputFailure::Failed)),
            (None, Err(error)) => {
                inner.state.borrow_mut().failed = Some(format!("{}: {error}", entry.call.method))
            }
            (None, Ok(())) => {}
        }
        Self::next(inner);
    }

    /// Ends the calls of a page that ended: its open call and its waiting calls answer [`InputFailure::WebviewEnded`], and their late
    /// completions answer nothing. The next page gets the focus emulation again.
    pub(crate) fn page_ended(&self) {
        let open: Vec<Rc<Entry>> = {
            let mut state = self.0.state.borrow_mut();
            state.focused = false;
            let current = state.current.take();
            current.into_iter().chain(state.waiting.drain(..)).collect()
        };
        for entry in open {
            let answer = entry.answer.borrow_mut().take();
            if let Some(answer) = answer {
                answer(Err(InputFailure::WebviewEnded));
            }
        }
    }

    /// Ends the web view of the queue: its calls end as at the end of a page, and a later input fails at once.
    pub(crate) fn end(&self) {
        self.0.state.borrow_mut().ended = true;
        self.page_ended();
    }
}

/// Why a capture does not start. CapturePreview is reported to accept the call and never complete while the web view is hidden or its parent
/// window is not shown, and a minimized window hides its web view, so these states are the answer at once.
#[cfg(any(test, feature = "diagnostics"))]
pub(crate) fn capture_refusal(minimized: bool, shown: bool, visible: bool) -> Result<(), String> {
    if minimized {
        Err("capture: the window is minimized, and its web view does not draw".to_string())
    } else if !shown {
        Err("capture: the window is not shown, and its web view does not draw".to_string())
    } else if !visible {
        Err("capture: the web view is hidden, and it does not draw".to_string())
    } else {
        Ok(())
    }
}

/// Limits the wait for CapturePreview, whose behavior in a covered window no document states. It returns the function that receives the
/// completion. done runs once: with the completion, or with the failure of the wait, and a later completion answers nothing.
#[cfg(any(test, feature = "diagnostics"))]
pub(crate) fn capture_wait(after: &After, wait: Duration, done: Complete) -> Complete {
    let done = Rc::new(RefCell::new(Some(done)));
    let timed = done.clone();
    let cancel = after(
        wait,
        Box::new(move || {
            if let Some(done) = timed.borrow_mut().take() {
                done(Err(format!(
                    "capture: CapturePreview did not complete within {wait:?}, and the web view reports that it draws; the window may be covered"
                )));
            }
        }),
    );
    Box::new(move |result| {
        cancel();
        if let Some(done) = done.borrow_mut().take() {
            done(result);
        }
    })
}

/// Checks that CapturePreview wrote an image.
#[cfg(any(test, feature = "diagnostics"))]
pub(crate) fn check_still(data: &[u8]) -> Result<(), String> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(())
    } else {
        Err(format!(
            "capture: CapturePreview wrote {} bytes that are not a PNG image",
            data.len()
        ))
    }
}

#[cfg(test)]
#[path = "devtools_input_test.rs"]
mod tests;
