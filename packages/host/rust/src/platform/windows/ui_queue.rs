//! The tasks of the UI thread. It holds no system call, so it also runs where Windows does not exist.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// The wait before a delayed task enters the queue again after the queue refused it.
pub const UI_POST_RETRY: Duration = Duration::from_millis(50);

pub type Task = Box<dyn FnOnce() + Send>;
/// Asks the UI thread to run the queue later. It must not run a task itself.
pub type Wake = Box<dyn Fn() -> Result<(), String> + Send + Sync>;
/// Calls its function once after a wait, on any thread.
pub type After = Box<dyn Fn(Duration, Task) + Send + Sync>;
/// Receives the failure of a delayed task, which has no caller to answer.
pub type Report = Box<dyn Fn(String) + Send + Sync>;

struct State {
    tasks: Vec<Task>,
    wake: Option<Wake>,
}

/// The queue of the UI thread.
pub struct UiQueue {
    state: Mutex<State>,
    after: After,
    report: Report,
}

impl UiQueue {
    pub fn new(after: After, report: Report) -> Self {
        Self {
            state: Mutex::new(State {
                tasks: Vec::new(),
                wake: None,
            }),
            after,
            report,
        }
    }

    fn locked(&self) -> MutexGuard<'_, State> {
        // default: a lock that a panicking thread poisoned still holds whole tasks; the panic hook records the panic.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lets the queue take tasks. Call it when the UI thread starts.
    pub fn start(&self, wake: Wake) {
        self.locked().wake = Some(wake);
    }

    /// The refusal gives the task back, so that a delayed task can enter later. The task enters under the lock of the
    /// wake, so a run that the wake causes finds it.
    fn try_add(&self, task: Task) -> Result<(), (Task, String)> {
        let mut state = self.locked();
        let Some(wake) = &state.wake else {
            return Err((task, "the UI thread has not started".to_string()));
        };
        match wake() {
            Ok(()) => {
                state.tasks.push(task);
                Ok(())
            }
            Err(failure) => Err((task, format!("UI task message: {failure}"))),
        }
    }

    /// Queues task as a later step of the UI thread. A task that it refuses never runs.
    pub fn add(&self, task: Task) -> Result<(), String> {
        self.try_add(task).map_err(|(_, failure)| failure)
    }

    /// Queues task after delay. A refusal of the queue at that time is reported and the task enters it later, because
    /// the caller was promised that it runs.
    pub fn add_after(queue: &Arc<Self>, delay: Duration, task: Task) -> Result<(), String> {
        if queue.locked().wake.is_none() {
            return Err("the UI thread has not started".to_string());
        }
        let entering = queue.clone();
        (queue.after)(delay, Box::new(move || Self::enter(entering, task)));
        Ok(())
    }

    fn enter(queue: Arc<Self>, task: Task) {
        if let Err((task, failure)) = queue.try_add(task) {
            (queue.report)(failure);
            let entering = queue.clone();
            (queue.after)(UI_POST_RETRY, Box::new(move || Self::enter(entering, task)));
        }
    }

    /// Runs the tasks that were queued when it started, in order. A task that a task queues waits for a later step.
    pub fn run(&self) {
        let tasks = std::mem::take(&mut self.locked().tasks);
        for task in tasks {
            task();
        }
    }
}

#[cfg(test)]
#[path = "ui_queue_test.rs"]
mod tests;
