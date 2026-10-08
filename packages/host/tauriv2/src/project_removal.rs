//! The requests that ask the window which shows a project whether the project may be removed
//! (docs/spec/projects.md). A request resolves with the answer of that window, or with true when the window ends.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

#[derive(Default)]
pub struct Removals {
    pending: Mutex<HashMap<String, (String, Sender<bool>)>>,
}

impl Removals {
    /// Registers a request for the project `id` that the window `owner` is asked. The returned receiver gets the
    /// answer once.
    pub fn begin(&self, id: &str, owner: &str) -> Result<Receiver<bool>, String> {
        let valid = !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !valid {
            return Err(format!("project id {id:?} is not valid"));
        }
        let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
        if pending.contains_key(id) {
            return Err(format!("removal of project {id} is already being asked"));
        }
        let (reply, asked) = channel();
        pending.insert(id.to_string(), (owner.to_string(), reply));
        Ok(asked)
    }

    /// Resolves the request for the project `id`.
    pub fn answer(&self, id: &str, allowed: bool) -> Result<(), String> {
        let (_, reply) = self
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .remove(id)
            .ok_or_else(|| format!("removal of project {id} is not being asked"))?;
        reply.send(allowed).map_err(|e| e.to_string())
    }

    /// Resolves every request that the window `owner` has not answered with true, because a window that ends keeps
    /// no tab.
    pub fn abandon(&self, owner: &str) {
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let ended: Vec<String> = pending
            .iter()
            .filter(|(_, (asked, _))| asked == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ended {
            if let Some((_, reply)) = pending.remove(&id) {
                // The asking command ended its wait, so no one receives the answer.
                if let Err(error) = reply.send(true) {
                    crate::application_log::log_error("project removal", error);
                }
            }
        }
    }
}
