//! The entrance of every thread of the host (docs/spec/hosts.md#process-lifecycle).
//!
//! `spawn_named` starts a thread with a name. The panic hook of the host (`application_log::install_panic_hook`) calls
//! `record_panic` on the panicking thread, which stores the event `host.panic` with the name of the thread and hands the wait
//! for the writer to a thread of its own, so a panic of the thread of the interface never waits for the disk. That thread ends
//! the process with `PANIC_STATUS` once the event is stored: a state that a panic left behind is not trusted, so there is no
//! mode that continues after a panic.

use std::sync::mpsc::{Sender, channel};
use std::sync::{Condvar, Mutex, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::json;

use crate::event_log::Level;
use crate::event_record::{emit_host, flush_records};

/// The exit status of the process after a panic; it is the status of an unwinding Rust panic of the main thread.
pub const PANIC_STATUS: i32 = 101;

/// How long the thread that ends the process waits for the event of a panic to reach the file.
const FLUSH_DEADLINE: Duration = Duration::from_secs(2);

/// How long the thread that ends the process waits for the writer when the panic happened before the writer opened. The wait
/// ends at the attach of the writer, which wakes it. The bound applies only to a writer that never opens, which is a start that
/// fails before the writer exists; then the record goes to the standard error instead of the event log.
pub(crate) const WRITER_DEADLINE: Duration = Duration::from_secs(5);

/// Whether the writer of the host is attached, and the wake of the thread that waits for it.
static WRITER: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

/// The thread that waits for the writer after a panic and ends the process; the hook wakes it with the record of the panic.
static ENDER: OnceLock<Mutex<Sender<String>>> = OnceLock::new();

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
    start_panic_ender_with(WRITER_DEADLINE);
}

/// Starts the thread that ends the process after a panic, and gives that thread the writer deadline `writer_deadline`.
/// The first call sets the deadline; later calls do nothing.
pub fn start_panic_ender_with(writer_deadline: Duration) {
    ENDER.get_or_init(|| {
        let (wake, woken) = channel::<String>();
        spawn_named("panic-ender", move || {
            let Ok(record) = woken.recv() else {
                return;
            };
            if !wait_for_writer(writer_deadline) {
                // No writer exists to store the record, so the record is written to the standard error in full.
                eprintln!(
                    "event writer: the record of the panic is not stored: no writer opened within {writer_deadline:?}\n{record}"
                );
                std::process::exit(PANIC_STATUS);
            }
            if let Err(error) = flush_records(FLUSH_DEADLINE) {
                eprintln!("event writer: the record of the panic is not stored: {error}");
            }
            std::process::exit(PANIC_STATUS);
        });
        Mutex::new(wake)
    });
}

/// Records that the writer of the host is attached, so the thread that ends the process after a panic can store the record.
pub fn notify_writer_attached() {
    let (attached, woken) = &WRITER;
    // default: a lock that a panicking thread poisoned still holds the attached flag, which is only written as a whole; the panic hook records the panic.
    *attached.lock().unwrap_or_else(PoisonError::into_inner) = true;
    woken.notify_all();
}

/// Waits at most `deadline` until the writer is attached, and reports whether it is.
fn wait_for_writer(deadline: Duration) -> bool {
    let (attached, woken) = &WRITER;
    let guard = attached.lock();
    // default: a lock that a panicking thread poisoned still holds the attached flag, which is only read; the panic hook records the panic.
    let guard = guard.unwrap_or_else(PoisonError::into_inner);
    let waited = woken.wait_timeout_while(guard, deadline, |attached| !*attached);
    // default: a wait that a poisoned lock ends still returns the guard and the flag, which is only read; the panic hook records the panic.
    let (guard, _) = waited.unwrap_or_else(PoisonError::into_inner);
    *guard
}

/// Stores the panic of a thread as the event `host.panic` and wakes the thread that ends the process. It does not wait for
/// the writer. `location` is `<file>:<line>` of the panic.
pub fn record_panic(location: &str, message: &str) {
    let thread = std::thread::current();
    // default: a thread without a name is recorded as unnamed, so the event still states that the thread had none.
    let name = thread.name().unwrap_or("<unnamed>");
    let stack = std::backtrace::Backtrace::force_capture().to_string();
    let record = format!("host.panic name={name} text={location}: {message}\n{stack}");
    emit_host(
        Level::Error,
        "host.panic",
        json!({"name": name, "text": format!("{location}: {message}"), "stack": stack}),
    );
    match ENDER.get() {
        Some(wake) => {
            // default: the lock guards only the sender of the panic ender, and a panic of another thread must not stop this record.
            let wake = wake.lock().unwrap_or_else(PoisonError::into_inner);
            if let Err(error) = wake.send(record) {
                eprintln!(
                    "event writer: the thread that ends the process is gone: {error}\n{}",
                    error.0
                );
            }
        }
        None => eprintln!(
            "event writer: no thread ends the process after the panic of {name}\n{record}"
        ),
    }
}
