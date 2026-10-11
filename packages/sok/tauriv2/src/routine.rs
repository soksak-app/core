//! The entrance of every thread of the tool and of the recovery of its panics (docs/spec/cli.md#event-log).
//!
//! `spawn_named` starts a thread with a name and recovers its panic; `guard` runs the command in the calling thread and
//! recovers its panic. The panic hook captures the message, the location and the stack at the panic, on the panicking thread.
//! A panic of a spawned thread is written to the standard error with the name of the thread and its stack, handed to the
//! recorder that `logged` installs, and ends the process with `PANIC_STATUS`: a state that a panic left behind is not
//! trusted, so no mode continues after it. A bare `thread::spawn` ends the thread with the report of the runtime only and
//! leaves no event.

use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, Once, PoisonError};
use std::thread::JoinHandle;

/// The exit status of the tool after a panic.
pub const PANIC_STATUS: i32 = 4;

/// A panic that an entrance recovered.
#[derive(Clone, Debug)]
pub struct Panic {
    /// The name of the thread; the command runs in the thread `main`.
    pub name: String,
    pub text: String,
    pub stack: String,
}

/// Stores a panic of a spawned thread and waits until it is stored; `logged` installs it for the run.
type Recorder = Arc<dyn Fn(&Panic) + Send + Sync>;

static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

/// Installs the recorder of the panics of spawned threads, or removes it with `None`.
pub fn set_recorder(recorder: Option<Recorder>) {
    // default: the lock guards only the recorder, and a panic of another thread must not stop its replacement.
    *RECORDER.lock().unwrap_or_else(PoisonError::into_inner) = recorder;
}

thread_local! {
    /// Whether an entrance recovers the panics of this thread, so the hook keeps them for the entrance.
    static GUARDED: Cell<bool> = const { Cell::new(false) };
    /// The last panic of this thread that the hook kept.
    static LAST: RefCell<Option<Panic>> = const { RefCell::new(None) };
}

/// Installs the panic hook once. The hook of a thread that an entrance recovers keeps the panic with its stack; any other
/// thread reaches the hook that was installed before.
fn install_hook() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !GUARDED.with(Cell::get) {
                previous(info);
                return;
            }
            let payload = info.payload();
            let text = payload
                .downcast_ref::<&str>()
                .map(|text| text.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                // default: a payload that is neither text type is recorded as unknown, so the event still states that a panic happened.
                .unwrap_or_else(|| "unknown panic payload".to_string());
            let location = info
                .location()
                .map_or_else(String::new, |at| format!("panicked at {at}\n"));
            let stack = format!("{location}{}", std::backtrace::Backtrace::force_capture());
            let thread = std::thread::current();
            // default: a thread without a name is recorded as unnamed, so the event still states that the thread had none.
            let name = thread.name().unwrap_or("<unnamed>").to_string();
            LAST.with(|last| *last.borrow_mut() = Some(Panic { name, text, stack }));
        }));
    });
}

/// Takes the panic that the hook kept for this thread.
fn take_panic() -> Panic {
    // default: a thread that ended by a panic without a kept record is recorded with a text that states it, so the event is still stored.
    LAST.with(|last| last.borrow_mut().take()).unwrap_or(Panic {
        name: "<unknown>".into(),
        text: "a panic without a record".into(),
        stack: String::new(),
    })
}

/// Runs `body` in a thread called `name`. A panic of `body` is recorded and ends the process with `PANIC_STATUS`.
pub fn spawn_named<T, F>(name: &str, body: F) -> JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    install_hook();
    let thread_name = name.to_string();
    std::thread::Builder::new()
        .name(thread_name.clone())
        .spawn(move || {
            GUARDED.with(|guarded| guarded.set(true));
            match catch_unwind(AssertUnwindSafe(body)) {
                Ok(result) => result,
                Err(_) => end(take_panic()),
            }
        })
        // default: a thread that cannot start ends the process by a panic, which the guard of the command records.
        .unwrap_or_else(|error| panic!("cannot start the thread {thread_name}: {error}"))
}

/// Runs `body` in the calling thread, which is the thread `main`, and returns its result. A panic of `body` is returned as a
/// value.
pub fn guard<T>(body: impl FnOnce() -> T) -> Result<T, Panic> {
    install_hook();
    GUARDED.with(|guarded| guarded.set(true));
    let result = catch_unwind(AssertUnwindSafe(body));
    GUARDED.with(|guarded| guarded.set(false));
    result.map_err(|_| {
        let mut panic = take_panic();
        panic.name = "main".into();
        panic
    })
}

/// Writes the panic of a spawned thread to the standard error, records it and ends the process.
fn end(panic: Panic) -> ! {
    eprintln!(
        "sok: panic: {}\n\nthread {}:\n{}",
        panic.text, panic.name, panic.stack
    );
    let recorder = RECORDER
        .lock()
        // default: the lock guards only the recorder, and a panic of another thread must not stop this record.
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let Some(record) = recorder {
        record(&panic);
    }
    std::process::exit(PANIC_STATUS);
}
