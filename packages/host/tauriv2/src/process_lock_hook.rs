//! The declared function that the acquisition of the process lock calls when it finds a lock file that an earlier owner
//! left, before it claims the file (docs/spec/endpoint.md#discovery). A test starts a second acquisition from it, which
//! places the race of two starters at a known point. It exists only in diagnostic builds, like the other test hooks.

use std::path::Path;
use std::sync::{Arc, Mutex};

/// The function that the acquisition calls with the configuration directory of the lock.
pub type ProcessLockHook = Arc<dyn Fn(&Path) + Send + Sync>;

static HOOK: Mutex<Option<ProcessLockHook>> = Mutex::new(None);

/// Declares the function; `None` removes it.
pub fn set_process_lock_hook(hook: Option<ProcessLockHook>) {
    *HOOK.lock().expect("the process lock hook lock") = hook;
}

/// Calls the declared function. The lock of the hook is released before the call, so the function may acquire the lock.
pub(crate) fn observe_stale_lock(directory: &Path) {
    let hook = HOOK.lock().expect("the process lock hook lock").clone();
    if let Some(hook) = hook {
        hook(directory);
    }
}
