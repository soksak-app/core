//! The work of the named routines: for each name, the wakes that did work, the time they took and the bytes they handled
//! (docs/spec/performance-trace.md). The host counts while the performance trace is on, and the sampler takes the totals.

use std::sync::{Mutex, PoisonError};

/// The work of one named routine since the last take: the wakes that did work, the microseconds they took and the bytes they handled
/// (docs/spec/performance-trace.md). The host counts while the performance trace is on, and the sampler takes the totals.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorkTotals {
    pub name: String,
    pub wakes: i64,
    pub micros: i64,
    pub bytes: i64,
}

static COUNTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WORK: Mutex<std::collections::BTreeMap<&'static str, WorkTotals>> =
    Mutex::new(std::collections::BTreeMap::new());

/// Turns the counting of the work on or off; turning it on starts the totals from zero.
pub fn count_work(on: bool) {
    // default: a lock that a panicking thread poisoned still holds the totals, which the switch empties; the panic hook
    // records the panic.
    let mut work = WORK.lock().unwrap_or_else(PoisonError::into_inner);
    work.clear();
    COUNTING.store(on, std::sync::atomic::Ordering::Release);
}

/// Counts one wake of the routine `name` that started at `started` and handled `bytes`. It does nothing while the counting is off.
pub fn work(name: &'static str, started: std::time::Instant, bytes: i64) {
    if !COUNTING.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let micros = started.elapsed().as_micros() as i64;
    // default: a lock that a panicking thread poisoned still holds the totals, which the count amends; the panic hook
    // records the panic.
    let mut work = WORK.lock().unwrap_or_else(PoisonError::into_inner);
    let totals = work.entry(name).or_insert_with(|| WorkTotals {
        name: name.to_string(),
        ..WorkTotals::default()
    });
    totals.wakes += 1;
    totals.micros += micros;
    totals.bytes += bytes;
}

/// The wake of a routine that counts its work when it ends, at the end of the scope that holds it.
pub struct Wake {
    name: &'static str,
    started: std::time::Instant,
    bytes: i64,
}

impl Wake {
    /// Starts a wake of the routine `name` that handles `bytes`.
    pub fn start(name: &'static str, bytes: usize) -> Wake {
        Wake {
            name,
            started: std::time::Instant::now(),
            bytes: bytes as i64,
        }
    }
}

impl Drop for Wake {
    fn drop(&mut self) {
        work(self.name, self.started, self.bytes);
    }
}

/// Returns the totals of every routine that worked since the last take, in the order of the names, and starts them from zero.
pub fn take_work() -> Vec<WorkTotals> {
    // default: a lock that a panicking thread poisoned still holds the totals, which the take empties; the panic hook
    // records the panic.
    let mut work = WORK.lock().unwrap_or_else(PoisonError::into_inner);
    std::mem::take(&mut *work).into_values().collect()
}
