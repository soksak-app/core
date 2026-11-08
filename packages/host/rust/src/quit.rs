//! Whether the application is quitting. The quit begins when the host asks the ready windows to close and ends when the
//! page of a window keeps a modified tab (docs/spec/plugins.md#tab-reports); each change is idempotent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use crate::endpoint::{ReplyOutcome, ReplyScope};

#[cfg(test)]
#[path = "quit_owner_test.rs"]
mod quit_owner_test;

#[derive(Default)]
pub struct Quit {
    active: AtomicBool,
}

impl Quit {
    /// Marks the application as quitting.
    pub fn begin(&self) {
        self.active.store(true, Ordering::Relaxed);
    }

    /// Marks the application as not quitting.
    pub fn cancel(&self) {
        self.active.store(false, Ordering::Relaxed);
    }

    /// Whether the application is quitting.
    pub fn active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// Runs quit, which asks the application to end, for a quit request. Every quit request begins the quit state, with or without a
    /// ready window (docs/spec/hosts.md#process-lifecycle).
    pub fn request(&self, quit: impl FnOnce()) {
        self.begin();
        quit();
    }

    /// Begins the quit state for an operating system quit request and reports whether the application quits at once, which it does
    /// when no ready window exists. ready is the number of ready windows that the request asks to close. Every quit request begins
    /// the state, with or without a ready window (docs/spec/hosts.md#process-lifecycle).
    pub fn begin_quit_request(&self, ready: usize) -> bool {
        self.begin();
        ready == 0
    }
}

/// The response context of the endpoint request whose native work is running, such as the menu item that host.menu.select
/// performs. A quit that the system requests during that work follows the response of that request, so the client receives
/// the response before the endpoint closes (docs/spec/endpoint.md#responses-and-termination).
struct ResponseOwner {
    owned: bool,
    reply: Option<ReplyScope>,
}

/// Runs one owned native work at a time, so a quit request names the request whose work caused it.
static OWNED_WORK: Mutex<()> = Mutex::new(());
static RESPONSE_OWNER: Mutex<ResponseOwner> = Mutex::new(ResponseOwner {
    owned: false,
    reply: None,
});

fn set_owner(owned: bool, reply: Option<ReplyScope>) {
    let mut owner = RESPONSE_OWNER
        .lock()
        // default: a lock that a panicking thread poisoned still holds the owner, which each change replaces whole; the
        // panic hook records the panic.
        .unwrap_or_else(PoisonError::into_inner);
    owner.owned = owned;
    owner.reply = reply;
}

/// Clears the owner when the owned work ends, also when it panics.
struct OwnerReset;

impl Drop for OwnerReset {
    fn drop(&mut self) {
        set_owner(false, None);
    }
}

/// Runs work, the native work of an endpoint request, with reply as the owner of the quit requests that the work causes.
/// No reply owns them with no response, so they run at once.
pub fn with_response_owner<T>(reply: Option<&ReplyScope>, work: impl FnOnce() -> T) -> T {
    // default: a lock that a panicking thread poisoned still orders the owned work; the panic hook records the panic.
    let _work = OWNED_WORK.lock().unwrap_or_else(PoisonError::into_inner);
    set_owner(true, reply.cloned());
    let _reset = OwnerReset;
    work()
}

/// Runs quit after the response of the endpoint request whose native work is running, and at once when no such work runs or
/// its request has no response.
pub fn after_owner_response(quit: impl FnOnce() + Send + 'static) {
    let reply = {
        let owner = RESPONSE_OWNER
            .lock()
            // default: a lock that a panicking thread poisoned still holds the owner; the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        if owner.owned {
            owner.reply.clone()
        } else {
            None
        }
    };
    match reply {
        Some(reply) => reply.after_response(move |_: ReplyOutcome| quit()),
        None => quit(),
    }
}
