//! The index of the event files follows the writer, and the host answers the query over them (docs/spec/logging.md#index,
//! docs/spec/logging.md#query). The index and the query are implemented in the crate of the command line tool, which the host already
//! depends on; the host adds the thread that follows the writer, the endpoint method `log.query` and the host call `logQuery`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, PoisonError};

use serde_json::{Value, json};
use soksak_sok::log_index::{IndexUpdate, update_log_index};
use soksak_sok::log_query::{LogPage, parse_log_query, query_logs};

use crate::event_log::Level;

/// Announces the lines of an update of an index that announce a change of the log (docs/spec/debug.md#following) and stores the event
/// `host.log.index_rebuilt` for an index that was built from the whole file. An incremental update stores no event: the event would be
/// a line that the next update indexes (docs/spec/logging.md#index).
pub fn report_index_update(update: &IndexUpdate) {
    crate::debug_follow::announce_index_update(update);
    if !update.rebuilt {
        return;
    }
    crate::event_record::emit_host(
        Level::Info,
        "host.log.index_rebuilt",
        json!({
            "file": update.file, "reason": update.reason, "lines": update.lines, "bytes": update.bytes, "micros": update.micros,
        }),
    );
}

/// The result of one update of an index.
pub type IndexResult = Result<IndexUpdate, String>;

/// Returns the function that reports the result of an update of an index: a rebuild is an event, and a failure is shown once for each
/// distinct text in the application log as an error record of the place `log index`. It is called from one thread.
pub fn index_reporter() -> impl FnMut(&Path, IndexResult) + Send + 'static {
    let mut last_error: HashMap<PathBuf, String> = HashMap::new();
    move |path, result| match result {
        Err(text) => {
            if last_error.get(path) != Some(&text) {
                last_error.insert(path.to_path_buf(), text.clone());
                crate::application_log::log_error("log index", text);
            }
        }
        Ok(update) => {
            last_error.remove(path);
            report_index_update(&update);
        }
    }
}

/// The observer of the writes that the writer calls, and the function that stops the thread behind it.
pub type LogIndexer = (
    Box<dyn Fn(&Path, u64) + Send + Sync>,
    Box<dyn FnOnce() + Send>,
);

struct Pending {
    paths: BTreeSet<PathBuf>,
    stopped: bool,
}

/// Starts the thread that brings the index of an event file up to date after the writer wrote to the file. The observer records the
/// path and wakes the thread; the notices that arrive while it indexes become one more update of each path. `after` is called with
/// the result of each update. The returned function stops the thread and waits until it returned.
pub fn start_log_indexer(after: impl FnMut(&Path, IndexResult) + Send + 'static) -> LogIndexer {
    let shared = Arc::new((
        Mutex::new(Pending {
            paths: BTreeSet::new(),
            stopped: false,
        }),
        Condvar::new(),
    ));
    start_log_indexer_on(shared, after)
}

/// Starts the thread of [start_log_indexer] on the pending paths `shared`, which a test can poison before the start.
fn start_log_indexer_on(
    shared: Arc<(Mutex<Pending>, Condvar)>,
    mut after: impl FnMut(&Path, IndexResult) + Send + 'static,
) -> LogIndexer {
    let worker_shared = Arc::clone(&shared);
    let worker = crate::routine::spawn_named("log-index", move || {
        loop {
            let paths = {
                let (lock, wake) = &*worker_shared;
                // default: a lock that a panicking thread poisoned still holds the pending paths, which the thread
                // takes; the panic hook records the panic.
                let mut pending = lock.lock().unwrap_or_else(PoisonError::into_inner);
                while pending.paths.is_empty() && !pending.stopped {
                    // default: a wait that a poisoned lock ends still returns the guard of the pending paths, which the
                    // thread takes; the panic hook records the panic.
                    pending = wake.wait(pending).unwrap_or_else(PoisonError::into_inner);
                }
                if pending.stopped {
                    return;
                }
                std::mem::take(&mut pending.paths)
            };
            for path in paths {
                let mut result = update_log_index(&path);
                if result.is_err() {
                    if !path.exists() {
                        // silent: the writer moved the file to a generation (`log.rotated`) or retention removed it (`log.pruned`) after the notice, and the next write to the file of the same name notifies again.
                        continue;
                    }
                    // The file may have come back between the update and the check, so the update is made once more and its result is reported.
                    result = update_log_index(&path);
                }
                after(&path, result);
            }
        }
    });
    let observer_shared = Arc::clone(&shared);
    let observe = Box::new(move |path: &Path, _size: u64| {
        let (lock, wake) = &*observer_shared;
        lock.lock()
            // default: a lock that a panicking thread poisoned still holds the pending paths, which the notice amends;
            // the panic hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .paths
            .insert(path.to_path_buf());
        wake.notify_one();
    });
    let stop = Box::new(move || {
        let (lock, wake) = &*shared;
        // default: a lock that a panicking thread poisoned still holds the pending paths, which the stop amends; the
        // panic hook records the panic.
        lock.lock().unwrap_or_else(PoisonError::into_inner).stopped = true;
        wake.notify_one();
        if worker.join().is_err() {
            eprintln!("log index: the thread ended with a panic");
        }
    });
    (observe, stop)
}

/// Why a query was not answered.
#[derive(Debug, PartialEq, Eq)]
pub enum QueryError {
    /// The request is not a query that the specification accepts.
    Invalid(String),
    /// The files could not be read as events.
    Failed(String),
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            QueryError::Invalid(text) | QueryError::Failed(text) => formatter.write_str(text),
        }
    }
}

/// Runs the query of the request over the event files of the configuration folder.
pub fn query_event_logs(config: &Path, request: &str) -> Result<LogPage, QueryError> {
    let query = parse_log_query(request).map_err(QueryError::Invalid)?;
    let mut report = report_index_update;
    query_logs(config, &query, Some(&mut report)).map_err(QueryError::Failed)
}

/// Answers the endpoint method `log.query`: the page as the JSON text of the reply.
pub fn answer(
    config: &Path,
    params: Option<Value>,
) -> Result<Box<serde_json::value::RawValue>, crate::endpoint::Failure> {
    use crate::endpoint::{Failure, HANDLER_FAILED};
    let Some(Value::Object(params)) = params else {
        return Err(Failure::params("params must be an object"));
    };
    match query_event_logs(config, &Value::Object(params).to_string()) {
        Ok(page) => serde_json::value::to_raw_value(&page)
            .map_err(|error| Failure::new(-32603, error.to_string())),
        Err(QueryError::Invalid(text)) => Err(Failure::params(text)),
        Err(QueryError::Failed(text)) => Err(Failure::new(HANDLER_FAILED, text)),
    }
}

#[cfg(test)]
#[path = "log_query_lock_test.rs"]
mod lock_test;
