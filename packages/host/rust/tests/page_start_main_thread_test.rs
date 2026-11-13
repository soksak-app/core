//! The start of a page runs as a step of the main thread (docs/spec/native-host.md#page-start): its cleanup of the earlier
//! page calls the native layout, which runs only on the main thread. The checks run on the main thread of this process,
//! which runs the posts of the host, while the start runs on another thread as the start document request does.

use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use soksak_host::framework::Manager;

// The test framework of the library names the framework and the menu of the host through these paths.
mod framework {
    pub use soksak_host::framework::*;
}
mod menu {
    pub use soksak_host::menu::*;
}
#[path = "support/framework.rs"]
#[allow(dead_code)]
mod test_framework;

#[path = "support/main_thread.rs"]
mod main_thread;

use test_framework::Task;

/// Sends the last task to the loop of the main thread when it is dropped, at the end of the start thread or at its panic.
struct Stop(Option<(Arc<std::sync::atomic::AtomicBool>, mpsc::Sender<Task>)>);

impl Drop for Stop {
    fn drop(&mut self) {
        if let Some((finished, main)) = self.0.take() {
            // silent: the loop of the main thread outlives the start thread, which it joins after this task.
            let _ = main.send(Box::new(move || finished.store(true, Ordering::Relaxed)));
        }
    }
}

// A task that the framework runs before the next post sees the window still ready when the start runs in that post, and
// not ready when the start ran before it, off the main thread, where the native layout ends the process with its record.
// contract: page.start.native-calls-are-main-thread-steps
fn the_start_of_a_page_runs_as_a_step_of_the_main_thread() -> Result<(), String> {
    let (app, framework) = test_framework::application_with_queue();
    let (main_sender, posts) = mpsc::channel::<Task>();
    framework.post_to(main_sender.clone());
    framework.add_window(Arc::new(test_framework::FixtureFrontend::new(Ok(1))));
    soksak_host::manage_start_state(&app);
    // The start reads the workspace of a folder that does not exist, so its snapshot fails and the start answers with that error.
    app.manage(soksak_host::workspace::Workspace::new(
        std::env::temp_dir().join(format!("page-start-main-thread-{}", std::process::id())),
    ));
    let records = Arc::new(soksak_host::windows::WindowData::default());
    soksak_host::windows::register_records(
        &app.state::<soksak_host::windows::Windows>(),
        "fixture",
        records.clone(),
    );
    records.ready.store(true, Ordering::Relaxed);
    let seen = Arc::new(Mutex::new(None));
    let before = seen.clone();
    let read = records.clone();
    framework.queue(move || {
        *before.lock().unwrap() = Some(read.ready.load(Ordering::Relaxed));
    });
    // The start thread ends the loop of the main thread with a last task through the same channel, after its posts.
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = Stop(Some((finished.clone(), main_sender.clone())));
    let starting = app.clone();
    let start = std::thread::spawn(move || {
        // The answer of the start is not judged; the order of its start is. The stop sends the last task also when the start
        // panics.
        let _stop = stop;
        let _ = soksak_host::start::start_page(&starting, "fixture");
    });
    // The main thread runs the posts until the last task of the start thread; the post of the start waits for its own result.
    while !finished.load(Ordering::Relaxed) {
        let task = posts
            .recv()
            .map_err(|_| "the start thread ended without its last task".to_string())?;
        task();
    }
    start
        .join()
        .map_err(|_| "the start thread panicked".to_string())?;
    if *seen.lock().unwrap() != Some(true) {
        return Err(format!(
            "the page start ran before the step of the main thread that the framework runs it in: the step saw ready {:?}",
            seen.lock().unwrap()
        ));
    }
    if records.ready.load(Ordering::Relaxed) {
        return Err("the page start left the window ready".to_string());
    }
    Ok(())
}

const TESTS: &[(&str, fn() -> Result<(), String>)] = &[(
    "the_start_of_a_page_runs_as_a_step_of_the_main_thread",
    the_start_of_a_page_runs_as_a_step_of_the_main_thread,
)];

fn main() {
    main_thread::run(TESTS);
}
