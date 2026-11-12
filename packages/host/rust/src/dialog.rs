//! The dialogs of the windows whose host.dialog an endpoint client watches (docs/spec/exposure.md#dialogs).

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::application_log::log_error;
use crate::framework::{Manager, Window};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The kinds of a dialog request.
pub const SAVE: &str = "save";
pub const FOLDER: &str = "folder";
pub const OPEN: &str = "open";
pub const DOWNLOAD: &str = "download";

/// A dialog that a window asks for while a client watches its host.dialog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// The host gives each request its id; the request of a page comes without one.
    #[serde(default)]
    pub id: String,
    pub kind: String,
    #[serde(rename = "suggestedName")]
    pub suggested_name: Option<String>,
    pub directory: Option<String>,
    pub multiple: bool,
    pub directories: bool,
    pub url: Option<String>,
}

/// The answer of input.dialog.answer.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Answer {
    pub id: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub cancel: bool,
    #[serde(default)]
    pub replace: bool,
}

/// A request that waits for its answer. answered receives the answer once.
struct Held {
    request: Request,
    answered: SyncSender<Answered>,
}

/// The answer of a request: the chosen paths, None for a cancel, and applied, which receives once whether the asker applied
/// them; the answer of a client waits for it. The end of a watch waits for no result, so it gives no applied.
struct Answered {
    paths: Option<Vec<String>>,
    applied: Option<SyncSender<Result<(), String>>>,
}

impl Answered {
    /// Reports to the answer of the client whether the asker applied the paths.
    fn applied(self, result: Result<(), String>) {
        if let Some(applied) = self.applied
            && let Err(error) = applied.try_send(result)
        {
            // Each answer receives one result, so the channel is not full; the send fails only when the answer of the
            // client ended with a panic, which the panic hook records.
            log_error("dialog applied", error.to_string());
        }
    }
}

#[derive(Default)]
struct State {
    watched: HashSet<String>,
    held: HashMap<String, Vec<Held>>,
    next: u64,
}

impl State {
    fn value(&self, window: &str) -> Value {
        let pending: Vec<&Request> = self
            .held
            .get(window)
            .map(|held| held.iter().map(|dialog| &dialog.request).collect())
            .unwrap_or_default();
        json!({ "pending": pending })
    }
}

/// The dialog requests of the windows whose host.dialog a client watches. While a window is watched, a dialog that the
/// window asks for shows no panel: it waits as a request of host.dialog until a client answers it or the watch ends.
pub struct Dialogs {
    state: Mutex<State>,
    changed: Box<dyn Fn(&str, Value) + Send + Sync>,
}

impl Dialogs {
    /// Creates the dialogs of the host. changed receives each new value of host.dialog of a window, in the order of the
    /// changes; it must not block.
    pub fn new(changed: impl Fn(&str, Value) + Send + Sync + 'static) -> Self {
        Dialogs {
            state: Mutex::new(State::default()),
            changed: Box::new(changed),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // default: a lock that a panicking thread poisoned still holds the requests, each of which is added or removed
        // whole; the panic hook records the panic.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records the start (on) or the end of the watch of host.dialog of window. The end answers each request of the
    /// window that waits as cancelled.
    pub fn watched(&self, window: &str, on: bool) {
        let mut state = self.state();
        if on {
            state.watched.insert(window.to_string());
            return;
        }
        state.watched.remove(window);
        let Some(held) = state.held.remove(window) else {
            return;
        };
        // The watchers hear the change before the askers go on, so a change is announced before the call that it answered
        // returns.
        (self.changed)(window, state.value(window));
        for dialog in held {
            deliver(
                &dialog,
                Answered {
                    paths: None,
                    applied: None,
                },
            );
        }
    }

    /// The value of host.dialog of window: {pending}, the requests that wait in the order they were asked.
    pub fn value(&self, window: &str) -> Value {
        self.state().value(window)
    }

    /// Answers the request answer.id of window and returns when the asker applied the answer, with the error of applying
    /// it. An answer that the request does not take is refused with the rule and the path, and the request keeps waiting.
    pub fn answer(&self, window: &str, answer: Answer) -> Result<(), String> {
        let id = answer.id.clone();
        let (applied, result) = sync_channel(1);
        self.take(window, answer, applied)?;
        // The asker sends the result once it applied the answer; a receive fails only when the asker ended with a panic.
        result.recv().map_err(|_| {
            format!("dialog: the request {id} of {window} ended without applying its answer")
        })?
    }

    fn take(
        &self,
        window: &str,
        answer: Answer,
        applied: SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        let mut state = self.state();
        let held = state.held.get_mut(window);
        let Some((index, held)) = held.and_then(|held| {
            held.iter()
                .position(|dialog| dialog.request.id == answer.id)
                .map(|index| (index, held))
        }) else {
            return Err(format!(
                "dialog: no request {} waits in {window}",
                answer.id
            ));
        };
        let paths = if answer.cancel {
            None
        } else {
            Some(choice(&held[index].request, &answer)?)
        };
        let dialog = held.remove(index);
        if held.is_empty() {
            state.held.remove(window);
        }
        // The watchers hear the change before the asker goes on, so a change is announced before the call that it answered
        // returns.
        (self.changed)(window, state.value(window));
        deliver(
            &dialog,
            Answered {
                paths,
                applied: Some(applied),
            },
        );
        Ok(())
    }

    /// Asks for request in window. Without a watch of host.dialog of window, panel shows the person's panel and gives
    /// its answer. With one, request waits with an id of its own until a client answers it, and ask returns the chosen
    /// paths, or None for a cancel and for the end of the watch.
    pub fn ask(
        &self,
        window: &str,
        request: Request,
        panel: impl FnOnce() -> Result<Option<Vec<String>>, String>,
    ) -> Result<Option<Vec<String>>, String> {
        let answer = {
            let mut state = self.state();
            if !state.watched.contains(window) {
                drop(state);
                return panel();
            }
            self.add(&mut state, window, request)
        };
        let answered = wait(window, answer)?;
        let paths = answered.paths.clone();
        answered.applied(Ok(()));
        Ok(paths)
    }

    /// Gives request an id of its own, lets it wait in window and announces it. It returns the receiver of its answer.
    fn add(&self, state: &mut State, window: &str, mut request: Request) -> Receiver<Answered> {
        let (answered, answer) = sync_channel(1);
        state.next += 1;
        request.id = format!("dialog-{}", state.next);
        state
            .held
            .entry(window.to_string())
            .or_default()
            .push(Held { request, answered });
        (self.changed)(window, state.value(window));
        answer
    }

    /// Holds request, a request that a page of window gives the host: the open panel of a file input or the place of a
    /// download. While a client watches host.dialog of window, it waits until it is answered, and apply applies the chosen
    /// paths to the page, None for a cancel; the answer of the client returns the error of apply, so the answer of a
    /// download returns when the download ended. Without a watch the request is cancelled at once. hold returns after apply.
    pub fn hold(
        &self,
        window: &str,
        request: Request,
        apply: impl FnOnce(Option<Vec<String>>) -> Result<(), String>,
    ) {
        let answer = {
            let mut state = self.state();
            if !state.watched.contains(window) {
                drop(state);
                if let Err(error) = apply(None) {
                    log_error("dialog cancel", error);
                }
                return;
            }
            self.add(&mut state, window, request)
        };
        let answered = match wait(window, answer) {
            Ok(answered) => answered,
            Err(error) => {
                log_error("dialog", error);
                if let Err(error) = apply(None) {
                    log_error("dialog cancel", error);
                }
                return;
            }
        };
        let result = apply(answered.paths.clone());
        if answered.paths.is_none()
            && let Err(error) = &result
        {
            log_error("dialog cancel", error.clone());
        }
        answered.applied(result);
    }
}

/// Waits for the answer of a request of window. The sender lives in the request until its answer is sent, so the receive
/// ends with that answer.
fn wait(window: &str, answer: Receiver<Answered>) -> Result<Answered, String> {
    answer
        .recv()
        .map_err(|_| format!("dialog: the request of {window} ended without an answer"))
}

/// Sends the answer of a request that was taken out of the requests. Each request receives one answer, so the channel is
/// not full; a send fails only when the call that asked ended with a panic, which the panic hook records.
fn deliver(dialog: &Held, answered: Answered) {
    if let Err(error) = dialog.answered.try_send(answered) {
        log_error("dialog answer", format!("{}: {error}", dialog.request.id));
    }
}

/// The choice that answer gives request, after the checks of the panel of a person: a save or a download takes one
/// absolute path in an existing folder whose name is not empty, holds no ':' and does not start with '.', and that names
/// no folder and no existing file unless replace is set; a folder takes one existing folder; an open takes existing paths,
/// at least one, one unless multiple, and files unless directories.
pub fn choice(request: &Request, answer: &Answer) -> Result<Vec<String>, String> {
    let paths = &answer.paths;
    match request.kind.as_str() {
        SAVE | DOWNLOAD => {
            if paths.len() != 1 {
                return Err(format!(
                    "dialog: a {} takes one path, the answer gives {}",
                    request.kind,
                    paths.len()
                ));
            }
            save_place(&paths[0], answer.replace)?;
        }
        FOLDER => {
            if paths.len() != 1 {
                return Err(format!(
                    "dialog: a folder takes one path, the answer gives {}",
                    paths.len()
                ));
            }
            if !existing(&paths[0])? {
                return Err(format!("dialog: {} is not a folder", paths[0]));
            }
        }
        OPEN => {
            if paths.is_empty() {
                return Err(
                    "dialog: an open takes at least one path, the answer gives none".into(),
                );
            }
            if paths.len() > 1 && !request.multiple {
                return Err(format!(
                    "dialog: this open takes one path, the answer gives {}",
                    paths.len()
                ));
            }
            for path in paths {
                if existing(path)? && !request.directories {
                    return Err(format!(
                        "dialog: {path} is a folder, and this open takes files"
                    ));
                }
            }
        }
        kind => return Err(format!("dialog: unknown kind {kind}")),
    }
    Ok(paths.clone())
}

/// Checks the place of a save or a download at path.
fn save_place(path: &str, replace: bool) -> Result<(), String> {
    let place = Path::new(path);
    if !place.is_absolute() {
        return Err(format!("dialog: {path} is not absolute"));
    }
    let Some(name) = place
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|_| !path.ends_with('/'))
    else {
        return Err(format!("dialog: {path} has no name"));
    };
    if name.contains(':') {
        return Err(format!("dialog: the name of {path} holds ':'"));
    }
    if name.starts_with('.') {
        return Err(format!("dialog: the name of {path} starts with '.'"));
    }
    // default: an absolute path with a file name has a parent.
    let parent = place.parent().unwrap_or(Path::new("/"));
    match std::fs::metadata(parent) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(format!("dialog: the folder of {path} does not exist"));
        }
        Err(error) => return Err(format!("dialog: {path}: {error}")),
        Ok(folder) if !folder.is_dir() => {
            return Err(format!("dialog: the folder of {path} is not a folder"));
        }
        Ok(_) => {}
    }
    match std::fs::metadata(place) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("dialog: {path}: {error}")),
        Ok(found) if found.is_dir() => Err(format!("dialog: {path} is a folder")),
        Ok(_) if !replace => Err(format!(
            "dialog: {path} exists; an answer that replaces it sets replace"
        )),
        Ok(_) => Ok(()),
    }
}

/// Whether the absolute path names a folder; a relative or a missing path is an error.
fn existing(path: &str) -> Result<bool, String> {
    if !Path::new(path).is_absolute() {
        return Err(format!("dialog: {path} is not absolute"));
    }
    match std::fs::metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            Err(format!("dialog: {path} does not exist"))
        }
        Err(error) => Err(format!("dialog: {path}: {error}")),
        Ok(found) => Ok(found.is_dir()),
    }
}

/// A chosen path of a panel as an answer names it.
fn named(path: PathBuf) -> Result<String, String> {
    path.into_os_string().into_string().map_err(|path| {
        format!(
            "dialog: the chosen path {} is not UTF-8",
            path.to_string_lossy()
        )
    })
}

/// Asks where to save name, in directory when it is given, for window: the save panel of the person, or the answer of a
/// client that watches host.dialog of the window. None is a cancel.
pub fn save_path(
    window: &Window,
    name: &str,
    directory: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let request = Request {
        id: String::new(),
        kind: SAVE.into(),
        suggested_name: Some(name.into()),
        directory: directory.map(|directory| directory.display().to_string()),
        multiple: false,
        directories: false,
        url: None,
    };
    let chosen = window.state::<Dialogs>().ask(window.label(), request, || {
        let chosen = window
            .app_handle()
            .framework()
            .save_file(window, name, directory)
            .map_err(|error| error.to_string())?;
        chosen
            .map(|path| named(path).map(|path| vec![path]))
            .transpose()
    })?;
    Ok(chosen
        .and_then(|paths| paths.into_iter().next())
        .map(PathBuf::from))
}

/// Asks for a folder with title for window: the folder panel of the person, or the answer of a client that watches
/// host.dialog of the window. None is a cancel.
pub fn folder_path(window: &Window, title: &str) -> Result<Option<PathBuf>, String> {
    let request = Request {
        id: String::new(),
        kind: FOLDER.into(),
        suggested_name: None,
        directory: None,
        multiple: false,
        directories: false,
        url: None,
    };
    let chosen = window.state::<Dialogs>().ask(window.label(), request, || {
        let chosen = window
            .app_handle()
            .framework()
            .choose_folder(window, title)
            .map_err(|error| error.to_string())?;
        chosen
            .map(|path| named(path).map(|path| vec![path]))
            .transpose()
    })?;
    Ok(chosen
        .and_then(|paths| paths.into_iter().next())
        .map(PathBuf::from))
}

#[cfg(test)]
#[path = "dialog_test.rs"]
mod dialog_test;
