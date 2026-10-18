//! The declared function that the watch of the policy file calls on its thread for each notification, immediately before the
//! read starts, with the paths that the watch holds (docs/spec/logging.md#classes-and-policy). A test reads from it whether the
//! file was watched before its read, which a write in place right after the creation needs. It exists only in diagnostic builds.

use std::path::PathBuf;
use std::sync::Mutex;

/// The function that receives the paths that the watch holds.
pub type LogPolicyWatchHook = Box<dyn Fn(&[PathBuf]) + Send + Sync>;

static HOOK: Mutex<Option<LogPolicyWatchHook>> = Mutex::new(None);

/// Declares the function; `None` removes it.
pub fn set_log_policy_watch_hook(hook: Option<LogPolicyWatchHook>) {
    *HOOK.lock().expect("the log policy watch hook lock") = hook;
}

pub(crate) fn observe(watched: &[PathBuf]) {
    if let Some(hook) = HOOK
        .lock()
        .expect("the log policy watch hook lock")
        .as_ref()
    {
        hook(watched);
    }
}
