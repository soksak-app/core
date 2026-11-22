//! The runs of the declared programs of plugin pages (docs/spec/native-surfaces.md#program-runs). A run starts its program without
//! a shell, reads both output streams to their end with a bound, and ends the program group with SIGKILL when the run ends
//! before the exit.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::event_log::Level;
use crate::event_record::emit_host;
use crate::platform::current;

/// The number of bytes that a run keeps of each output stream.
pub const OUTPUT_LIMIT: usize = 1 << 20;
/// The number of open runs that a surface may hold.
pub const RUNS_PER_SURFACE: usize = 4;

/// The cause that ends a run before its program exits; its name is the result of the run in the events.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Cancelled,
    ProcessEnded,
    SurfaceClosed,
    WindowClosed,
}

impl End {
    /// The name of the cause, as the event host.program.end writes it.
    pub fn name(self) -> &'static str {
        match self {
            End::Cancelled => "cancelled",
            End::ProcessEnded => "process-ended",
            End::SurfaceClosed => "surface-closed",
            End::WindowClosed => "window-closed",
        }
    }
}

/// One argument slot of a declaration: a text that the argument equals, or a pattern that the whole argument matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slot {
    Text(String),
    Pattern(String),
}

/// One declared program: the declared text and its argument slots, which are empty for a program that takes no argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declaration {
    pub program: String,
    pub slots: Vec<Slot>,
}

/// The declared programs of a plugin, by name.
pub type Declarations = BTreeMap<String, Declaration>;

/// One kept output stream: its text, the count of every byte the program wrote and whether bytes were discarded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stream {
    pub text: String,
    pub bytes: u64,
    pub truncated: bool,
}

/// A run that started its program and ended: end is None for an exit, or the cause that ended the run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finished {
    pub end: Option<End>,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub stdout: Stream,
    pub stderr: Stream,
    pub duration: Duration,
}

/// A view call that asks for a run of a declared program.
#[derive(Clone, Debug)]
pub struct Request {
    pub surface: String,
    pub plugin: String,
    pub id: u64,
    pub name: String,
    pub args: Vec<String>,
    /// The project folder of the surface, or None for a window that shows no project.
    pub project: Option<PathBuf>,
    /// The installed version folder of the plugin, which a program of the form `plugin:<path>` resolves in. The error is the
    /// reason that the folder is unknown, and a run reports it only when its program has that form.
    pub plugin_folder: Result<PathBuf, String>,
    /// The complete environment of the program as name and value pairs.
    pub environment: Vec<(OsString, OsString)>,
}

/// A message to the thread that runs a program: its exit, or the cause that ends it.
enum Event {
    Exited(std::io::Result<ExitStatus>),
    End(End),
}

/// An open run: the token tells this run from a later run with the same call identifier.
struct Open {
    token: u64,
    sender: Sender<Event>,
}

/// The declarations and the open runs of one surface.
#[derive(Default)]
struct SurfaceRuns {
    plugin: String,
    declarations: Declarations,
    open: BTreeMap<u64, Open>,
}

/// The open runs and the declarations of the surfaces of the host.
#[derive(Default)]
pub struct ProgramRuns {
    surfaces: Mutex<BTreeMap<String, SurfaceRuns>>,
}

/// The token of each run, which tells runs of one call identifier apart.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

impl ProgramRuns {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, SurfaceRuns>> {
        // default: a lock that a panicking thread poisoned still holds the declarations and the open runs, which the panic
        // hook records.
        self.surfaces.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stores the declared programs of surface of plugin, which replace the declarations of the surface.
    pub fn declare(&self, surface: &str, plugin: &str, declarations: Declarations) {
        let mut surfaces = self.lock();
        let state = surfaces.entry(surface.to_string()).or_default();
        state.plugin = plugin.to_string();
        state.declarations = declarations;
    }

    /// Runs the declared program of the request and waits for its end. A refused request starts no program and writes
    /// host.program.refused; a run whose program does not start, or whose kept stream is not UTF-8, fails with the reason.
    pub fn run(&self, request: Request) -> Result<Finished, String> {
        let (sender, receiver) = mpsc::channel();
        let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
        let declaration = match self.admit(&request, token, &sender) {
            Ok(declaration) => declaration,
            Err(reason) => {
                emit_host(
                    Level::Error,
                    "host.program.refused",
                    json!({
                        "plugin": request.plugin,
                        "surface": request.surface,
                        "name": request.name,
                        "reason": reason,
                    }),
                );
                return Err(reason);
            }
        };
        let result = execute(&request, &declaration, sender, receiver);
        self.leave(&request.surface, request.id, token);
        result
    }

    /// Checks the request against the declaration and the limit of open runs, and opens the run under its id when it is admitted.
    fn admit(
        &self,
        request: &Request,
        token: u64,
        sender: &Sender<Event>,
    ) -> Result<Declaration, String> {
        if request.project.is_none() {
            return Err("program run: the window shows no project".to_string());
        }
        let mut surfaces = self.lock();
        let not_declared = || {
            format!(
                "program {} is not declared by {}",
                request.name, request.plugin
            )
        };
        let state = surfaces
            .get(&request.surface)
            .ok_or_else(|| format!("program run: surface {} has no view", request.surface))?;
        if state.plugin != request.plugin {
            return Err(not_declared());
        }
        let declaration = state
            .declarations
            .get(&request.name)
            .cloned()
            .ok_or_else(not_declared)?;
        if declaration.slots.len() != request.args.len() {
            return Err(format!(
                "program {} takes {} arguments, {} given",
                request.name,
                declaration.slots.len(),
                request.args.len()
            ));
        }
        for (index, (slot, argument)) in declaration.slots.iter().zip(&request.args).enumerate() {
            let position = index + 1;
            match slot {
                Slot::Text(text) if text != argument => {
                    return Err(format!(
                        "program {} argument {position} {argument} does not equal its text",
                        request.name
                    ));
                }
                Slot::Text(_) => {}
                Slot::Pattern(pattern) => {
                    if !pattern_matches(pattern, argument).map_err(|reason| {
                        format!(
                            "program {} pattern does not compile: {reason}",
                            request.name
                        )
                    })? {
                        return Err(format!(
                            "program {} argument {position} {argument} does not match its pattern",
                            request.name
                        ));
                    }
                }
            }
        }
        let open = state.open.len();
        if open >= RUNS_PER_SURFACE {
            return Err(format!(
                "program run: {RUNS_PER_SURFACE} runs are open on surface {}",
                request.surface
            ));
        }
        if state.open.contains_key(&request.id) {
            return Err(format!(
                "program run: call {} is already open on surface {}",
                request.id, request.surface
            ));
        }
        let state = surfaces
            .get_mut(&request.surface)
            .ok_or_else(not_declared)?;
        state.open.insert(
            request.id,
            Open {
                token,
                sender: sender.clone(),
            },
        );
        Ok(declaration)
    }

    /// Removes the open run of id when it is the run of token, and removes the surface when it holds nothing.
    fn leave(&self, surface: &str, id: u64, token: u64) {
        let mut surfaces = self.lock();
        if let Some(state) = surfaces.get_mut(surface)
            && state.open.get(&id).is_some_and(|open| open.token == token)
        {
            state.open.remove(&id);
        }
        prune(&mut surfaces, surface);
    }

    /// Sends the cause to the open runs of surface, or to the open run id only.
    fn end_runs(&self, surface: &str, id: Option<u64>, cause: End) {
        let surfaces = self.lock();
        let Some(state) = surfaces.get(surface) else {
            return;
        };
        for (_, open) in state
            .open
            .iter()
            .filter(|(open_id, _)| id.is_none_or(|wanted| **open_id == wanted))
        {
            if open.sender.send(Event::End(cause)).is_err() {
                // default: a send fails only after the run dropped its receiver, so the run has already ended and has no run left to end.
                continue;
            }
        }
    }

    /// Ends the open run id of surface with End::Cancelled. A cancel of a run that is not open does nothing.
    pub fn cancel(&self, surface: &str, id: u64) {
        self.end_runs(surface, Some(id), End::Cancelled);
    }

    /// Ends the open runs of the view of surface with End::ProcessEnded.
    pub fn end_view(&self, surface: &str) {
        self.end_runs(surface, None, End::ProcessEnded);
    }

    /// Ends the open runs of surface with End::SurfaceClosed and removes its declarations.
    pub fn end_surface(&self, surface: &str) {
        self.close(surface, End::SurfaceClosed);
    }

    /// Ends the open runs of every surface with End::WindowClosed and removes their declarations.
    pub fn end_window(&self) {
        let surfaces: Vec<String> = self.lock().keys().cloned().collect();
        for surface in surfaces {
            self.close(&surface, End::WindowClosed);
        }
    }

    fn close(&self, surface: &str, cause: End) {
        if let Some(state) = self.lock().get_mut(surface) {
            state.declarations.clear();
        }
        self.end_runs(surface, None, cause);
        prune(&mut self.lock(), surface);
    }
}

/// Removes the surface when it holds no declaration and no open run.
fn prune(surfaces: &mut BTreeMap<String, SurfaceRuns>, surface: &str) {
    if surfaces
        .get(surface)
        .is_some_and(|state| state.open.is_empty() && state.declarations.is_empty())
    {
        surfaces.remove(surface);
    }
}

/// Reports whether the whole argument matches the pattern. The pattern is compiled as declared first, so its error is the
/// error of the pattern itself, and the anchored form matches the whole argument.
fn pattern_matches(pattern: &str, argument: &str) -> Result<bool, String> {
    regex::Regex::new(pattern).map_err(|error| error.to_string())?;
    let anchored =
        regex::Regex::new(&format!(r"\A(?:{pattern})\z")).map_err(|error| error.to_string())?;
    Ok(anchored.is_match(argument))
}

/// The prefix of a program that names a file of its plugin, resolved in the installed version folder of the plugin.
const PLUGIN_PROGRAM_PREFIX: &str = "plugin:";

/// Finds the file of a program of the form `plugin:<path>` in the installed version folder of its plugin, which the view folder
/// uses (docs/spec/native-surfaces.md#program-runs). The declaration reader accepts only a path without empty, `.` or `..`
/// segments, so the file stays inside the folder. A file that does not exist is not found; any other error of the lookup is
/// returned, and so is a folder that is unknown.
fn resolve_plugin(
    program: &str,
    path: &str,
    folder: &Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let folder = folder.as_ref().map_err(Clone::clone)?;
    let file = folder.join(path);
    match std::fs::metadata(&file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("program not found: {program}"))
        }
        Err(error) => Err(format!("program {program}: {error}")),
        Ok(metadata) if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 => Err(
            format!("program {program} is not a regular executable file"),
        ),
        Ok(_) => Ok(file),
    }
}

/// Finds the program of a run as a terminal session finds its program (docs/spec/agent-roles.md#start-parameters): a path with a
/// separator resolves from the project folder, and an absolute path as it is; a bare name is searched through the PATH of the
/// run environment, in the order of the entries, for a regular file with an execute bit, as the process execution of the system does.
fn resolve(
    program: &str,
    directory: &Path,
    environment: &[(OsString, OsString)],
) -> Option<PathBuf> {
    if program.contains('/') {
        let path = Path::new(program);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            directory.join(path)
        };
        return std::fs::metadata(&resolved).is_ok().then_some(resolved);
    }
    let value = environment
        .iter()
        .rev()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.clone())?;
    for folder in std::env::split_paths(&value) {
        let folder = if folder.as_os_str().is_empty() {
            directory.to_path_buf()
        } else if folder.is_relative() {
            directory.join(folder)
        } else {
            folder
        };
        let candidate = folder.join(program);
        if let Ok(metadata) = std::fs::metadata(&candidate)
            && metadata.is_file()
            && metadata.permissions().mode() & 0o111 != 0
        {
            return Some(candidate);
        }
    }
    None
}

/// Starts the program at path with its arguments, the complete environment, the project folder as working directory, an
/// empty standard input and its own process group.
fn spawn(
    request: &Request,
    declaration: &Declaration,
    directory: &Path,
    path: &Path,
) -> Result<Child, String> {
    let start_failed = |error: &dyn std::fmt::Display| {
        format!("program {}: start failed: {error}", declaration.program)
    };
    let platform = current().map_err(|error| start_failed(&error))?;
    let mut command = Command::new(path);
    command
        .arg0(&declaration.program)
        .args(&request.args)
        .current_dir(directory)
        .env_clear()
        .envs(request.environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform
        .new_process_group(&mut command)
        .map_err(|error| start_failed(&error))?;
    command.spawn().map_err(|error| start_failed(&error))
}

/// The bounded capture of one output stream: the first OUTPUT_LIMIT bytes and the count of every byte.
struct Capture {
    kept: Vec<u8>,
    total: u64,
}

/// Reads a stream to its end, keeps its first OUTPUT_LIMIT bytes and discards the rest, so the program never blocks on a full pipe.
fn capture(mut reader: impl Read) -> std::io::Result<Capture> {
    let mut capture = Capture {
        kept: Vec::new(),
        total: 0,
    };
    let mut buffer = [0u8; 8192];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(capture),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        capture.total += read as u64;
        let room = OUTPUT_LIMIT - capture.kept.len();
        capture.kept.extend_from_slice(&buffer[..room.min(read)]);
    }
}

/// Decodes a kept stream. A truncated stream ends at the last whole character; the flag is false when the bytes are not UTF-8,
/// and the text then holds them with replacement characters.
fn decode(mut kept: Vec<u8>, truncated: bool) -> (String, bool) {
    if truncated
        && let Err(error) = std::str::from_utf8(&kept)
        && error.error_len().is_none()
    {
        kept.truncate(error.valid_up_to());
    }
    match String::from_utf8(kept) {
        Ok(text) => (text, true),
        Err(error) => (
            String::from_utf8_lossy(&error.into_bytes()).into_owned(),
            false,
        ),
    }
}

/// The name of a signal that ended a program, as the event host.program.end writes it.
fn signal_name(signal: i32) -> String {
    let name = match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        10 => "SIGBUS",
        11 => "SIGSEGV",
        12 => "SIGSYS",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("signal {signal}"),
    };
    name.to_string()
}

/// Starts the program of the request and waits for its end, and writes host.program.start, host.program.end and
/// host.program.failed. The thread that waits for the exit owns the child; this thread ends the group on a cause.
fn execute(
    request: &Request,
    declaration: &Declaration,
    sender: Sender<Event>,
    receiver: Receiver<Event>,
) -> Result<Finished, String> {
    let failed = |reason: &str| {
        emit_host(
            Level::Error,
            "host.program.failed",
            json!({
                "plugin": request.plugin,
                "surface": request.surface,
                "name": request.name,
                "reason": reason,
            }),
        );
    };
    let Some(directory) = request.project.as_deref() else {
        let reason = "program run: the window shows no project".to_string();
        failed(&reason);
        return Err(reason);
    };
    let resolved = match declaration.program.strip_prefix(PLUGIN_PROGRAM_PREFIX) {
        Some(path) => resolve_plugin(&declaration.program, path, &request.plugin_folder),
        None => resolve(&declaration.program, directory, &request.environment)
            .ok_or_else(|| format!("program not found: {}", declaration.program)),
    };
    let path = match resolved {
        Ok(path) => path,
        Err(reason) => {
            failed(&reason);
            return Err(reason);
        }
    };
    let mut child = match spawn(request, declaration, directory, &path) {
        Ok(child) => child,
        Err(reason) => {
            failed(&reason);
            return Err(reason);
        }
    };
    let started = Instant::now();
    emit_host(
        Level::Info,
        "host.program.start",
        json!({
            "plugin": request.plugin,
            "surface": request.surface,
            "name": request.name,
            "program": declaration.program,
            "args": request.args,
            "cwd": directory.to_string_lossy(),
        }),
    );
    let pid = child.id();
    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            let mut reason = format!("program {}: output pipes are missing", declaration.program);
            // The child started, so its group ends and the child is reaped before the failure returns; a failure of either
            // step is part of the reason.
            if let Err(error) = current().and_then(|platform| platform.end_process_group(pid)) {
                reason = format!("{reason}; end failed: {error}");
            }
            if let Err(error) = child.wait() {
                reason = format!("{reason}; wait failed: {error}");
            }
            failed(&reason);
            return Err(reason);
        }
    };
    let stdout_reader = crate::routine::spawn_named("program-stdout", move || capture(stdout));
    let stderr_reader = crate::routine::spawn_named("program-stderr", move || capture(stderr));
    let exit_sender = sender;
    crate::routine::spawn_named("program-wait", move || {
        if exit_sender.send(Event::Exited(child.wait())).is_err() {
            // default: a send fails only after the run dropped its receiver, so the exit arrived after the run ended without it.
        }
    });
    let outcome = wait_and_collect(
        request,
        declaration,
        pid,
        &receiver,
        stdout_reader,
        stderr_reader,
        started,
    );
    let ran = match outcome {
        Ok(ran) => ran,
        Err(reason) => {
            failed(&reason);
            return Err(reason);
        }
    };
    emit_host(
        Level::Info,
        "host.program.end",
        json!({
            "plugin": request.plugin,
            "surface": request.surface,
            "name": request.name,
            "result": ran.finished.end.map_or("exited", End::name),
            "code": ran.finished.code,
            "signal": ran.finished.signal,
            "stdoutBytes": ran.finished.stdout.bytes,
            "stderrBytes": ran.finished.stderr.bytes,
            "stdoutTruncated": ran.finished.stdout.truncated,
            "stderrTruncated": ran.finished.stderr.truncated,
            // default: a duration beyond u64::MAX microseconds, about 584,000 years, is reported as u64::MAX.
            "durationUs": u64::try_from(ran.finished.duration.as_micros()).unwrap_or(u64::MAX),
        }),
    );
    match ran.invalid {
        Some(reason) => {
            failed(&reason);
            Err(reason)
        }
        None => Ok(ran.finished),
    }
}

/// A run whose program ended: its result, and the reason when a kept stream of an exit is not UTF-8.
struct Ran {
    finished: Finished,
    invalid: Option<String>,
}

/// Waits for the exit or the first cause, ends the group on a cause and waits for the exit, then reads both streams to their end.
fn wait_and_collect(
    request: &Request,
    declaration: &Declaration,
    pid: u32,
    receiver: &Receiver<Event>,
    stdout_reader: std::thread::JoinHandle<std::io::Result<Capture>>,
    stderr_reader: std::thread::JoinHandle<std::io::Result<Capture>>,
    started: Instant,
) -> Result<Ran, String> {
    let name = &request.name;
    let mut cause: Option<End> = None;
    let mut kill_error: Option<String> = None;
    let status = loop {
        match receiver.recv() {
            Ok(Event::Exited(status)) => {
                break status.map_err(|error| {
                    format!("program {}: wait failed: {error}", declaration.program)
                })?;
            }
            Ok(Event::End(end)) => {
                if cause.is_none() {
                    cause = Some(end);
                    kill_error = current()
                        .and_then(|platform| platform.end_process_group(pid))
                        .err();
                }
            }
            Err(error) => {
                return Err(format!(
                    "program {}: no end channel: {error}",
                    declaration.program
                ));
            }
        }
    };
    let duration = started.elapsed();
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("program {name}: stdout reader panicked"))?
        .map_err(|error| format!("program {name}: read stdout failed: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("program {name}: stderr reader panicked"))?
        .map_err(|error| format!("program {name}: read stderr failed: {error}"))?;
    if let Some(error) = kill_error {
        return Err(format!(
            "program {}: end failed: {error}",
            declaration.program
        ));
    }
    let (code, signal) = match cause {
        Some(_) => (None, Some("SIGKILL".to_string())),
        None => match status.code() {
            Some(code) => (Some(code), None),
            None => (None, status.signal().map(signal_name)),
        },
    };
    let stdout_truncated = stdout.total > stdout.kept.len() as u64;
    let stderr_truncated = stderr.total > stderr.kept.len() as u64;
    let (stdout_text, stdout_valid) = decode(stdout.kept, stdout_truncated);
    let (stderr_text, stderr_valid) = decode(stderr.kept, stderr_truncated);
    let invalid = if cause.is_some() {
        None
    } else if !stdout_valid {
        Some(format!("program {name}: stdout is not UTF-8"))
    } else if !stderr_valid {
        Some(format!("program {name}: stderr is not UTF-8"))
    } else {
        None
    };
    Ok(Ran {
        finished: Finished {
            end: cause,
            code,
            signal,
            stdout: Stream {
                text: stdout_text,
                bytes: stdout.total,
                truncated: stdout_truncated,
            },
            stderr: Stream {
                text: stderr_text,
                bytes: stderr.total,
                truncated: stderr_truncated,
            },
            duration,
        },
        invalid,
    })
}

/// Reads the declared programs of a plugin from the value of its `programs` member (docs/spec/plugins.md#pluginjson). The host
/// checks the same limits as the workbench validator, and it compiles each pattern with the regular expression library, so
/// an invalid member is refused with an error that names the program.
pub fn parse_declarations(value: &serde_json::Value) -> Result<Declarations, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "programs is not an object".to_string())?;
    let mut declarations = Declarations::new();
    for (name, entry) in object {
        if !valid_name(name) {
            return Err(format!(
                "programs.{name} name is not of the form [a-z][a-z0-9-]*"
            ));
        }
        let fields = entry
            .as_object()
            .ok_or_else(|| format!("programs.{name} is not an object"))?;
        if let Some(member) = fields
            .keys()
            .find(|key| *key != "program" && *key != "args")
        {
            return Err(format!("programs.{name} has an unknown member {member}"));
        }
        let program = fields
            .get("program")
            .and_then(serde_json::Value::as_str)
            .filter(|program| {
                !program.is_empty() && program.len() <= 255 && !program.chars().any(char::is_control)
            })
            .ok_or_else(|| {
                format!("programs.{name} program is not a text of 1 to 255 bytes without a control character")
            })?;
        if let Some(path) = program.strip_prefix(PLUGIN_PROGRAM_PREFIX)
            && !plugin_path_valid(path)
        {
            return Err(format!(
                "programs.{name} program plugin path must be a relative path of / separated segments that are not empty, . or .., without a backslash"
            ));
        }
        let slots = match fields.get("args") {
            None => Vec::new(),
            Some(args) => {
                let items = args
                    .as_array()
                    .ok_or_else(|| format!("programs.{name} args is not an array"))?;
                if items.len() > 16 {
                    return Err(format!("programs.{name} args has more than 16 slots"));
                }
                items
                    .iter()
                    .enumerate()
                    .map(|(index, slot)| parse_slot(name, index, slot))
                    .collect::<Result<Vec<Slot>, String>>()?
            }
        };
        declarations.insert(
            name.clone(),
            Declaration {
                program: program.to_string(),
                slots,
            },
        );
    }
    Ok(declarations)
}

/// Reports whether path, the text after the plugin prefix, is a relative path of `/` separated segments that are none empty, `.`
/// or `..`, and has no backslash, so that a run names only a file inside the plugin folder (docs/spec/native-surfaces.md#program-runs).
fn plugin_path_valid(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Reports whether the name has the form `[a-z][a-z0-9-]*`.
fn valid_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

/// Reads one argument slot: a text, or an object whose single member `pattern` is a regular expression of at most 512 bytes.
fn parse_slot(name: &str, index: usize, slot: &serde_json::Value) -> Result<Slot, String> {
    if let Some(text) = slot.as_str() {
        return Ok(Slot::Text(text.to_string()));
    }
    let pattern = slot
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("pattern"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            format!("programs.{name} args.{index} is neither a text nor an object with the single member pattern")
        })?;
    if pattern.len() > 512 {
        return Err(format!("programs.{name} pattern is longer than 512 bytes"));
    }
    regex::Regex::new(pattern)
        .map_err(|error| format!("programs.{name} pattern does not compile: {error}"))?;
    Ok(Slot::Pattern(pattern.to_string()))
}

impl ProgramRuns {
    /// Ends the open runs and removes the declarations of every surface that the placement does not list
    /// (docs/spec/native-surfaces.md#program-runs).
    pub fn retain(&self, surfaces: &[&str]) {
        let stale: Vec<String> = self
            .lock()
            .keys()
            .filter(|surface| !surfaces.contains(&surface.as_str()))
            .cloned()
            .collect();
        for surface in stale {
            self.close(&surface, End::SurfaceClosed);
        }
    }
}

/// The view call that asks for a run, as the page sends it to the host command programRun.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunCall {
    pub surface: String,
    pub id: u64,
    pub name: String,
    pub args: Vec<String>,
}

/// The cancel of a view call, as the page sends it to the host command programCancel.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelCall {
    pub surface: String,
    pub id: u64,
}

/// The reply of a run that exited, which answers its view call as `{code, stdout, stderr, truncated}`. A run that ended before
/// its exit has no reply, because its view call has already ended.
pub fn reply(finished: &Finished) -> Option<Value> {
    finished.end.is_none().then(|| {
        json!({
            "code": finished.code,
            "stdout": finished.stdout.text,
            "stderr": finished.stderr.text,
            "truncated": {
                "stdout": finished.stdout.truncated,
                "stderr": finished.stderr.truncated,
            },
        })
    })
}

#[cfg(test)]
#[path = "program_run_test.rs"]
mod program_run_test;
