//! The main-thread service of the GPUI application: the language host library and the framework adapter reach
//! the application context of GPUI from any thread through it (docs/spec/hosts.md).

use futures::StreamExt;
use futures::channel::mpsc;
use gpui_kit as gpui;
use std::sync::OnceLock;
use std::thread::ThreadId;

use gpui::App;

/// One request of the main-thread service.
enum Request {
    /// A task that runs with the application context on the main thread.
    Task(Box<dyn FnOnce(&mut App) + Send>),
}

static REQUESTS: OnceLock<mpsc::UnboundedSender<Request>> = OnceLock::new();

/// The thread of the GPUI application, which runs its event loop.
static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();

/// Starts the service of the application. The task that receives the requests runs until the application ends.
pub(crate) fn start(cx: &mut App) {
    let (sender, mut receiver) = mpsc::unbounded::<Request>();
    REQUESTS.get_or_init(|| sender);
    MAIN_THREAD.get_or_init(|| std::thread::current().id());
    cx.spawn(async move |cx| {
        while let Some(request) = receiver.next().await {
            let Request::Task(task) = request;
            // default: the application ends when its context no longer updates, so a failed update ends the service.
            cx.update(|cx| task(cx));
        }
    })
    .detach();
}

/// Whether the calling thread is the thread of the GPUI application.
pub(crate) fn is_main_thread() -> bool {
    MAIN_THREAD
        .get()
        .is_some_and(|main| std::thread::current().id() == *main)
}

/// Runs task with the application context on the main thread and returns without waiting for it.
pub(crate) fn post(task: Box<dyn FnOnce(&mut App) + Send>) -> Result<(), String> {
    let requests = REQUESTS
        .get()
        .ok_or("the GPUI application is not running")?;
    requests
        .unbounded_send(Request::Task(task))
        .map_err(|_| "the GPUI application is not running".to_string())
}

/// Runs work on the main thread and returns its value. Work that the main thread itself starts runs there
/// directly, and a caller of another thread waits for the main thread.
pub(crate) fn on_main<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    MAIN_THREAD
        .get()
        .ok_or("the GPUI application is not running")?;
    if is_main_thread() {
        return Ok(work());
    }
    let (sender, receiver) = std::sync::mpsc::channel::<T>();
    post(Box::new(move |_| {
        // default: a dropped receiver ends the wait of the caller with its error.
        let _ = sender.send(work());
    }))?;
    receiver
        .recv()
        .map_err(|_| "the main thread ended before it ran a task of the framework".to_string())
}

#[cfg(test)]
#[path = "../tests/service/service_test.rs"]
mod service_test;
