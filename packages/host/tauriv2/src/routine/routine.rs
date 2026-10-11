//! The entrance of every thread of the host (docs/spec/hosts.md#process-lifecycle).
//!
//! `spawn_named` starts a thread with a name. The panic hook of the host (`application_log::install_panic_hook`) calls
//! `record_panic` on the panicking thread, which stores the event `host.panic` with the name of the thread and hands the wait
//! for the writer to a thread of its own, so a panic of the thread of the interface never waits for the disk. That thread ends
//! the process with `PANIC_STATUS` once the event is stored: a state that a panic left behind is not trusted, so there is no
//! mode that continues after a panic.

use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::json;

use crate::event_log::Level;
use crate::event_record::{emit_host, flush_records};

/// The exit status of the process after a panic; it is the status of an unwinding Rust panic of the main thread.
pub const PANIC_STATUS: i32 = 101;

/// How long the thread that ends the process waits for the event of a panic to reach the file.
const FLUSH_DEADLINE: Duration = Duration::from_secs(2);

/// The thread that waits for the writer after a panic and ends the process; the hook wakes it.
static ENDER: OnceLock<Mutex<Sender<()>>> = OnceLock::new();

/// Runs `body` in a thread called `name`. A panic of `body` is recorded by the panic hook with that name.
pub fn spawn_named<T, F>(name: &str, body: F) -> JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(body)
        // default: a thread that cannot start ends the process by a panic, which the panic hook records.
        .unwrap_or_else(|error| panic!("cannot start the thread {name}: {error}"))
}

/// Starts the thread that ends the process after a panic. Call it before the panic hook is installed; calling it again does
/// nothing.
pub fn start_panic_ender() {
    ENDER.get_or_init(|| {
        let (wake, woken) = channel::<()>();
        spawn_named("panic-ender", move || {
            if woken.recv().is_err() {
                return;
            }
            if let Err(error) = flush_records(FLUSH_DEADLINE) {
                eprintln!("event writer: the record of the panic is not stored: {error}");
            }
            std::process::exit(PANIC_STATUS);
        });
        Mutex::new(wake)
    });
}

/// Stores the panic of a thread as the event `host.panic` and wakes the thread that ends the process. It does not wait for
/// the writer. `location` is `<file>:<line>` of the panic.
pub fn record_panic(location: &str, message: &str) {
    let thread = std::thread::current();
    // default: a thread without a name is recorded as unnamed, so the event still states that the thread had none.
    let name = thread.name().unwrap_or("<unnamed>");
    let stack = std::backtrace::Backtrace::force_capture().to_string();
    emit_host(
        Level::Error,
        "host.panic",
        json!({"name": name, "text": format!("{location}: {message}"), "stack": stack}),
    );
    match ENDER.get() {
        Some(wake) => {
            // default: the lock guards only the sender of the panic ender, and a panic of another thread must not stop this record.
            let wake = wake.lock().unwrap_or_else(PoisonError::into_inner);
            if let Err(error) = wake.send(()) {
                eprintln!("event writer: the thread that ends the process is gone: {error}");
            }
        }
        None => eprintln!("event writer: no thread ends the process after the panic of {name}"),
    }
}
