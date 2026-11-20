//! The surface of a process (docs/spec/sidecars.md#process-identity): the host walks the parent processes of the process of
//! an endpoint connection to the first process whose parent is a running sidecar, asks that sidecar with a process query,
//! and reads the chain again before it accepts the answer. The Go host (packages/host/go/src/process_identity.go) implements
//! the same rules.

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex, PoisonError};

use super::{Members, Outgoing, Owner, QueuedLine, Sidecars, State, member};
use crate::platform::{ProcessEntry, current};

/// The result of the surface of a process: a refusal is the endpoint error 1014 with its text, any other failure is an
/// error of the host.
#[derive(Debug, PartialEq, Eq)]
pub enum ProcessSurfaceError {
    Refused(String),
    Failed(String),
}

/// A process query that waits for its answer: the sidecar and the process of that sidecar that it was sent to, the process
/// that it asks about, and the sender of the answer.
pub(super) struct ProcessQuery {
    sidecar: String,
    owner: u32,
    process: u32,
    answer: SyncSender<ProcessAnswer>,
}

/// The answer of a sidecar: the surface, or None when the sidecar did not start the process for a surface, with the start
/// time that the sidecar recorded, in milliseconds since the Unix epoch.
struct ProcessAnswer {
    surface: Option<String>,
    started: i64,
}

/// The process queries of the sidecars and the request of the last one. The state of the sidecars holds it.
#[derive(Default)]
pub(super) struct ProcessQueries {
    waiting: HashMap<u64, ProcessQuery>,
    last: u64,
}

impl<O: Owner> Sidecars<O> {
    /// The surface of the process `peer`: the surface for which a sidecar started the nearest ancestor of `peer`, `peer`
    /// included, whose parent is a running sidecar of the host (docs/spec/sidecars.md#process-identity).
    pub fn process_surface(&self, peer: u32) -> Result<String, ProcessSurfaceError> {
        let platform = current().map_err(ProcessSurfaceError::Failed)?;
        let entry = |pid: u32| {
            platform
                .process_entry(pid)
                .map_err(ProcessSurfaceError::Failed)
        };
        let changed = || {
            ProcessSurfaceError::Refused(format!(
                "process {peer} changed while its surface was checked"
            ))
        };
        let sidecars = self.sidecar_processes();
        let mut chain: Vec<(u32, ProcessEntry)> = Vec::new();
        let mut pid = peer;
        let (sidecar, owner) = loop {
            let Some(found) = entry(pid)? else {
                return Err(changed());
            };
            chain.push((pid, found));
            if let Some(name) = sidecars.get(&found.parent) {
                break (name.clone(), found.parent);
            }
            if found.parent <= 1 {
                return Err(ProcessSurfaceError::Refused(format!(
                    "process {peer} is not a process of a surface: no parent process of it is a running sidecar of the application that started it for a surface"
                )));
            }
            pid = found.parent;
        };
        let (root, root_entry) = *chain.last().expect("the walk read one process");
        let declares = self
            .core
            .declarations
            .read()
            // default: a lock that a panicking thread poisoned still holds the declarations, which are only read; the panic
            // hook records the panic.
            .unwrap_or_else(PoisonError::into_inner)
            .processes
            .contains(&sidecar);
        if !declares {
            return Err(ProcessSurfaceError::Refused(format!(
                "process {peer} is a process of sidecar {sidecar}, which declares no processes of surfaces"
            )));
        }
        let answer = self.ask_process(&sidecar, owner, root)?;
        for (pid, read) in &chain {
            if entry(*pid)? != Some(*read) {
                return Err(changed());
            }
        }
        let Some(surface) = answer.surface else {
            return Err(ProcessSurfaceError::Refused(format!(
                "process {peer} is not a process of a surface: sidecar {sidecar} did not start process {root} for a surface"
            )));
        };
        if answer.started != root_entry.started {
            return Err(changed());
        }
        Ok(surface)
    }

    /// The process of each running sidecar with its name: the child of a sidecar on standard input and output, and the
    /// service process of a persistent connection.
    fn sidecar_processes(&self) -> HashMap<u32, String> {
        let state = self
            .core
            .state
            .lock()
            // default: a lock that a panicking thread poisoned still holds the sidecar state, which is only read; the panic
            // hook records the panic.
            .unwrap_or_else(PoisonError::into_inner);
        let mut processes = HashMap::new();
        for (name, process) in &state.running {
            if let Some(persistent) = &process.persistent {
                processes.insert(persistent.service_pid, name.clone());
            } else if let Some(child) = &process.child {
                processes.insert(child.id(), name.clone());
            }
        }
        processes
    }

    /// Sends the process query for `pid` to the process `owner` of `sidecar` and waits for its answer or for the end of the
    /// reading of that process, which drops the sender (docs/spec/sidecars.md#messages).
    fn ask_process(
        &self,
        sidecar: &str,
        owner: u32,
        pid: u32,
    ) -> Result<ProcessAnswer, ProcessSurfaceError> {
        let (answer, received): (SyncSender<ProcessAnswer>, Receiver<ProcessAnswer>) =
            sync_channel(1);
        {
            let mut state = self
                .core
                .state
                .lock()
                // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the
                // panic hook records the panic.
                .unwrap_or_else(PoisonError::into_inner);
            let queued = (state.clock)();
            state.process_queries.last += 1;
            let request = state.process_queries.last;
            let Some(process) = state.running.get(sidecar) else {
                return Err(ProcessSurfaceError::Failed(format!(
                    "sidecar {sidecar} ended before the process query of process {pid}"
                )));
            };
            let mut line =
                serde_json::to_vec(&serde_json::json!({"process": pid, "request": request}))
                    .map_err(|error| ProcessSurfaceError::Failed(error.to_string()))?;
            line.push(b'\n');
            process
                .outbox
                .try_send(Outgoing::Line(QueuedLine::new(line, queued)))
                .map_err(|_| {
                    ProcessSurfaceError::Failed(format!("sidecar {sidecar} is not keeping up"))
                })?;
            state.process_queries.waiting.insert(
                request,
                ProcessQuery {
                    sidecar: sidecar.to_string(),
                    owner,
                    process: pid,
                    answer,
                },
            );
        }
        received.recv().map_err(|_| {
            ProcessSurfaceError::Failed(format!(
                "sidecar {sidecar} ended before it answered the process query of process {pid}"
            ))
        })
    }
}

/// The answer to a process query (docs/spec/sidecars.md#messages).
struct AnswerLine {
    process: u32,
    request: u64,
    surface: Option<String>,
    started: Option<i64>,
}

/// Handles the line of `members` of the process `owner` of `sidecar` when it is an answer to a process query. It returns
/// Ok(false) when it is not an answer, Ok(true) when it was delivered, and the reason when the protocol was violated
/// (docs/spec/sidecars.md#failure).
pub(super) fn process_answer<O>(
    state: &Arc<Mutex<State<O>>>,
    sidecar: &str,
    owner: u32,
    members: &Members<'_>,
) -> Result<bool, String> {
    // A process member that is null is no answer, as a line without it.
    let Some(process) = member::<Option<u32>>(members, "process")?.flatten() else {
        return Ok(false);
    };
    let answer = AnswerLine {
        process,
        request: member::<u64>(members, "request")?
            .ok_or_else(|| "invalid message: request is missing".to_string())?,
        surface: member::<Option<String>>(members, "surface")?.flatten(),
        started: member::<Option<i64>>(members, "started")?.flatten(),
    };
    let query = {
        // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the panic
        // hook records the panic.
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        match state.process_queries.waiting.get(&answer.request) {
            Some(query) if query.sidecar == sidecar && query.owner == owner => {
                state.process_queries.waiting.remove(&answer.request)
            }
            _ => None,
        }
    };
    let Some(query) = query else {
        return Err(format!(
            "unexpected process answer for request {}",
            answer.request
        ));
    };
    if answer.process != query.process {
        return Err(format!(
            "process answer for request {} names process {}, not {}",
            answer.request, answer.process, query.process
        ));
    }
    let started = match (&answer.surface, answer.started) {
        (Some(_), None) => {
            return Err(format!(
                "process answer for request {} has a surface and no started",
                answer.request
            ));
        }
        // default: an answer without a surface carries no start time, and none is compared.
        (_, started) => started.unwrap_or(0),
    };
    // The waiting side holds its receiver until it receives this answer or the reading of the sidecar ends, so a failed send
    // is a defect of the wait, which the log records.
    if query
        .answer
        .send(ProcessAnswer {
            surface: answer.surface,
            started,
        })
        .is_err()
    {
        crate::application_log::log_error(
            "process query",
            format!(
                "the answer for request {} has no waiting side",
                answer.request
            ),
        );
    }
    Ok(true)
}

/// Drops the process queries sent to the process `owner` of `sidecar` when its reading ended, so their waits end
/// (docs/spec/sidecars.md#process-identity).
pub(super) fn end_process_queries<O>(state: &Arc<Mutex<State<O>>>, sidecar: &str, owner: u32) {
    // default: a lock that a panicking thread poisoned still holds the sidecar state, which the call amends; the panic hook
    // records the panic.
    let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
    state
        .process_queries
        .waiting
        .retain(|_, query| query.sidecar != sidecar || query.owner != owner);
}
