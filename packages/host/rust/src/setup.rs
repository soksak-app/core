//! The setup parts of the agents of the machine in the application (docs/spec/cli.md#agents-in-the-application): the host reads
//! the environment of the login shell of the person at startup, reconciles user PATH, and brings the agent skill current.
//! Setup calls use the setup library of the command line.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, Once, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use soksak_sok::setup::{self, Environment, Kind, Part};

use crate::event_log::Level;

/// The variables that the login session gives every application of the person, and the only variables of the host that the
/// login shell starts with, so the environment that it prints does not depend on the process that started the application
/// (docs/spec/cli.md#agents-in-the-application).
const SESSION_VARIABLES: [&str; 7] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "__CF_USER_TEXT_ENCODING",
];

/// The variables that a shell sets for each process that it starts, which the environment of a sidecar does not take from the
/// login shell (docs/spec/sidecars.md#processes-of-a-surface).
const SHELL_PROCESS_VARIABLES: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];

/// The time in which the login shell must print the environment: a shell that waits for input has no event that ends it.
const LOGIN_SHELL_BOUND: Duration = Duration::from_secs(10);

/// The operations of the platform that the read of the login shell environment uses (platform::Platform).
pub trait LoginShellProcesses: Send + Sync {
    fn login_shell(&self) -> Result<String, String>;
    fn new_process_group(&self, command: &mut Command) -> Result<(), String>;
    fn end_process_group(&self, pid: u32) -> Result<(), String>;
}

/// The platform of this system as the processes of the login shell.
pub struct SystemProcesses(pub &'static dyn crate::platform::Platform);

impl LoginShellProcesses for SystemProcesses {
    fn login_shell(&self) -> Result<String, String> {
        self.0.login_shell()
    }
    fn new_process_group(&self, command: &mut Command) -> Result<(), String> {
        self.0.new_process_group(command)
    }
    fn end_process_group(&self, pid: u32) -> Result<(), String> {
        self.0.end_process_group(pid)
    }
}

/// The argument of the setupInstall call. parts is received without a fixed type so that a value that is not a list of strings
/// is refused.
#[derive(Debug, serde::Deserialize)]
pub struct InstallRequest {
    pub parts: Value,
}

/// The desired state of the user PATH registration.
#[derive(Debug, serde::Deserialize)]
pub struct ChangeRequest {
    pub part: String,
    pub enabled: bool,
}

/// The answer of setupState and setupInstall.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Parts {
    pub parts: Vec<Part>,
}

/// Runs the setup operations of the application: sok is the sok of the application bundle, and the setup parts are read and
/// installed in the environment of the login shell that processes names.
#[derive(Clone)]
pub struct Setups {
    inner: Arc<Inner>,
}

struct Inner {
    start: SetupStart,
    sok: PathBuf,
    identifier: String,
    user_path_support: Result<(), String>,
    processes: Box<dyn LoginShellProcesses>,
    changed: Box<dyn Fn() + Send + Sync>,
    begin: Once,
    /// The environment that the start read, set when the start ended: the read of the environment and the skill write after it,
    /// so a setup operation never runs beside the skill write of the start.
    ready: Mutex<Option<Result<Environment, String>>>,
    ended: Condvar,
    running: Mutex<()>,
    user_path: Mutex<Option<(Environment, Option<String>)>>,
}

/// What the start of the host does with the setup files of the person (docs/spec/cli.md#agents-in-the-application). The default
/// brings them current.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SetupStart {
    /// Why the start changes no setup file of the person: a debug build, or a configuration directory that the run was given,
    /// which a check or a second application uses beside the application of the person.
    pub kept: Option<String>,
    /// The folder of an executable that runs from a folder that macOS made for App Translocation; the folder ends with the
    /// process, so a registration of its sok would name a path that no longer exists.
    pub translocated: Option<String>,
}

/// The path element of the folders that macOS makes for App Translocation.
const TRANSLOCATION_FOLDER: &str = "/AppTranslocation/";

/// The start of the setup of the application identifier, run with the configuration directory that the command line gave
/// (`None` for none) from the executable.
pub fn setup_start_of(
    identifier: &str,
    config_directory: Option<&str>,
    executable: &Path,
) -> SetupStart {
    if identifier.ends_with(".dev") {
        return SetupStart {
            kept: Some(format!("the debug build {identifier}")),
            translocated: None,
        };
    }
    if let Some(directory) = config_directory {
        return SetupStart {
            kept: Some(format!("the configuration directory {directory}")),
            translocated: None,
        };
    }
    if executable.to_string_lossy().contains(TRANSLOCATION_FOLDER) {
        // default: an executable path always has a folder.
        let folder = executable.parent().unwrap_or(Path::new("/"));
        return SetupStart {
            kept: None,
            translocated: Some(folder.to_string_lossy().into_owned()),
        };
    }
    SetupStart::default()
}

impl Setups {
    /// Returns the setup operations of the sok of the application identifier; start tells what the start does with the setup
    /// files of the person, and changed sends setup-changed to every window.
    pub fn new(
        sok: PathBuf,
        identifier: String,
        start: SetupStart,
        processes: Box<dyn LoginShellProcesses>,
        changed: Box<dyn Fn() + Send + Sync>,
    ) -> Result<Setups, String> {
        let user_path = soksak_sok::platform::current()?.user_path();
        Ok(Setups {
            inner: Arc::new(Inner {
                sok,
                identifier,
                start,
                user_path_support: user_path,
                processes,
                changed,
                begin: Once::new(),
                ready: Mutex::new(None),
                ended: Condvar::new(),
                running: Mutex::new(()),
                user_path: Mutex::new(None),
            }),
        })
    }

    /// Reads the environment of the login shell once, then brings the skill, the MCP registration and the hooks current and sends
    /// setup-changed. The host calls it
    /// at its start, and the read runs on a thread of its own, off the start path; a later call does nothing.
    pub fn start(&self) {
        let inner = self.inner.clone();
        self.inner.begin.call_once(move || {
            crate::routine::spawn_named("setup-environment", move || {
                let environment = inner.read_environment();
                // A start that keeps the files of the person or runs from a translocated folder only reads the environment.
                let kept = match (&inner.start.translocated, &inner.start.kept) {
                    (Some(folder), _) => {
                        crate::event_record::emit_host(
                            Level::Error,
                            "host.setup.translocated",
                            json!({ "folder": folder }),
                        );
                        true
                    }
                    (None, Some(reason)) => {
                        crate::event_record::emit_host(
                            Level::Info,
                            "host.setup.kept",
                            json!({ "reason": reason }),
                        );
                        true
                    }
                    (None, None) => false,
                };
                if kept {
                    // The user PATH part reports the environment as the start read it, without a change.
                    if let Ok(environment) = &environment
                        && let Err(error) = inner.set_path_environment(environment.clone(), None)
                    {
                        crate::application_log::log_error("setup", error);
                    }
                    // default: the state is one value that a holder sets whole, so a holder that ended by a panic left no partial value.
                    *inner.ready.lock().unwrap_or_else(PoisonError::into_inner) = Some(environment);
                    inner.ended.notify_all();
                    (inner.changed)();
                    return;
                }
                if let Ok(environment) = &environment
                    && inner.user_path_support.is_ok()
                {
                    let (effective, error) = inner.reconcile_user_path(environment.clone(), None);
                    if let Err(error) = inner.set_path_environment(effective, error) {
                        crate::application_log::log_error("setup", error);
                    }
                }
                inner.bring_skill_current(&environment);
                inner.bring_agent_parts_current(&environment);
                // default: the state is one value that a holder sets whole, so a holder that ended by a panic left no partial value.
                *inner.ready.lock().unwrap_or_else(PoisonError::into_inner) = Some(environment);
                inner.ended.notify_all();
                (inner.changed)();
            });
        });
    }

    /// Returns the environment of a sidecar: the variables of the login shell without the ones that a shell sets for each process,
    /// after the start ended; a failed read is the error of every sidecar start.
    pub fn sidecar_environment(
        &self,
    ) -> Result<std::collections::BTreeMap<String, String>, String> {
        let mut variables = self.inner.environment()?.variables;
        for name in SHELL_PROCESS_VARIABLES {
            variables.remove(name);
        }
        Ok(variables)
    }

    /// Returns the parts as `sok setup check` prints them, after the start ended.
    pub fn state(&self) -> Result<Parts, String> {
        self.read_state(true)
    }

    fn read_state(&self, refresh: bool) -> Result<Parts, String> {
        let environment = self.inner.environment()?;
        self.inner
            .with_user_path(setup::check(&self.inner.setup(&environment))?, refresh)
    }

    /// Persists and applies the user PATH preference and notifies every window of the result.
    pub fn change(&self, request: ChangeRequest) -> Result<Parts, String> {
        if request.part != "path" {
            return Err("setup change requires path and a boolean enabled".into());
        }
        let _running = self.inner.begin_operation()?;
        self.inner.environment()?;
        self.inner.user_path_support.clone()?;
        let environment = if request.enabled {
            self.inner.read_environment()?
        } else {
            self.inner.path_environment()?.0
        };
        let (environment, error) = self
            .inner
            .reconcile_user_path(environment, Some(request.enabled));
        self.inner
            .set_path_environment(environment, error.clone())?;
        (self.inner.changed)();
        match error {
            Some(error) => Err(error),
            None => self.read_state(false),
        }
    }

    /// Installs the named kinds of skill and mcp as `sok setup install` does and returns its parts, then sends setup-changed.
    pub fn install(&self, request: InstallRequest) -> Result<Parts, String> {
        let kinds = kinds_of(&request.parts)?;
        let _running = self.inner.begin_operation()?;
        let environment = self.inner.environment()?;
        let installed = setup::install(&self.inner.setup(&environment), &kinds);
        // The install can have changed a part also when it failed, so every window reads the parts again.
        (self.inner.changed)();
        match installed? {
            setup::Installed {
                error: Some(error), ..
            } => Err(error),
            setup::Installed { parts, error: None } => self.inner.with_user_path(parts, false),
        }
    }
}

/// A message of a thread that reads the shell.
enum Message {
    /// The end of the read of standard output, with the environment line when one came.
    Stdout(Option<Environment>),
    /// The end of the read of standard error, with its text or the failure of the read.
    Stderr(std::io::Result<Vec<u8>>),
    Exited(std::io::Result<ExitStatus>),
}

/// Sends a message of a thread that reads the shell. The read ends at the environment line, after which the messages of the other
/// threads have no receiver.
fn deliver(sender: &mpsc::Sender<Message>, message: Message) {
    if sender.send(message).is_err() {
        crate::application_log::log_info(
            "setup",
            "a message of the login shell arrived after its read ended",
        );
    }
}

impl Inner {
    fn begin_operation(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        match self.running.try_lock() {
            Ok(guard) => Ok(guard),
            Err(TryLockError::WouldBlock) => Err("another setup operation is running".into()),
            Err(TryLockError::Poisoned(error)) => Err(format!("setup operation state: {error}")),
        }
    }

    fn path_environment(&self) -> Result<(Environment, Option<String>), String> {
        self.user_path
            .lock()
            .map_err(|error| format!("user PATH state: {error}"))?
            .clone()
            .ok_or_else(|| "the user PATH environment was not read".into())
    }

    fn set_path_environment(
        &self,
        environment: Environment,
        error: Option<String>,
    ) -> Result<(), String> {
        *self
            .user_path
            .lock()
            .map_err(|error| format!("user PATH state: {error}"))? = Some((environment, error));
        Ok(())
    }

    fn with_user_path(&self, mut parts: Vec<Part>, refresh: bool) -> Result<Parts, String> {
        if self.user_path_support.is_ok() {
            let (mut environment, error) = self.path_environment()?;
            if refresh {
                environment = self.read_environment()?;
            }
            let mut part = setup::user_path_state(&environment)?;
            if let Some(error) = error
                && part.state != setup::State::Ok
            {
                part.state = setup::State::Error;
                part.reason = None;
                part.error = Some(error);
            }
            parts.insert(0, part);
        }
        Ok(Parts { parts })
    }

    /// Applies the saved preference and verifies a change in a fresh login shell.
    fn reconcile_user_path(
        &self,
        mut environment: Environment,
        enabled: Option<bool>,
    ) -> (Environment, Option<String>) {
        let result = (|| {
            let shell = self.processes.login_shell()?;
            if !setup::configure_user_path(&environment, &shell, &self.sok, enabled)? {
                return Ok(());
            }
            environment = self.read_environment()?;
            if setup::user_path_state(&environment)?.state != setup::State::Ok {
                return Err(format!(
                    "login shell {shell}: the user PATH registration is missing"
                ));
            }
            Ok(())
        })();
        (environment, result.err())
    }

    /// The environment that the start read, after the start ended.
    fn environment(&self) -> Result<Environment, String> {
        // default: the state is one value that a holder sets whole, so a holder that ended by a panic left no partial value.
        let ready = self.ready.lock().unwrap_or_else(PoisonError::into_inner);
        let ready = self
            .ended
            .wait_while(ready, |ready| ready.is_none())
            // default: the state is one value that a holder sets whole, so a holder that ended by a panic left no partial value.
            .unwrap_or_else(PoisonError::into_inner);
        ready
            .clone()
            // default: wait_while returns only when the start set the value.
            .unwrap_or_else(|| Err("setup state: the start set no environment".into()))
    }

    /// The input of the setup library in the environment.
    fn setup<'a>(&'a self, environment: &'a Environment) -> setup::Setup<'a> {
        setup::Setup {
            environment,
            sok: &self.sok,
            identifier: &self.identifier,
        }
    }

    /// Writes a differing skill file of each agent folder that exists, as `sok mcp` does, and records each skill file that it could
    /// not write, or another failure, as one error host.setup.skill. No agent folder is no error.
    fn bring_skill_current(&self, environment: &Result<Environment, String>) {
        let failures = match environment {
            Ok(environment) => soksak_sok::skill::bring_skill_current(environment),
            Err(error) => Err(error.clone()),
        };
        match failures {
            Ok(failures) => {
                for failure in failures {
                    crate::event_record::emit_host(
                        Level::Error,
                        "host.setup.skill",
                        json!({ "file": failure.file.display().to_string(), "reason": failure.reason }),
                    );
                }
            }
            Err(error) => crate::event_record::emit_host(
                Level::Error,
                "host.setup.skill",
                json!({ "file": null, "reason": error }),
            ),
        }
    }

    /// Installs the MCP registration and the hooks that are not current, as `sok setup install mcp hook` does, so each start registers
    /// the sok of this bundle, and records a part that it could not install as one error host.setup.install. A failed read of the
    /// environment is recorded once, as host.setup.skill by bring_skill_current.
    fn bring_agent_parts_current(&self, environment: &Result<Environment, String>) {
        let Ok(environment) = environment else {
            return;
        };
        let error = match setup::install(&self.setup(environment), &[Kind::Mcp, Kind::Hook]) {
            Ok(installed) => installed.error,
            Err(error) => Some(error),
        };
        if let Some(reason) = error {
            crate::event_record::emit_host(
                Level::Error,
                "host.setup.install",
                json!({ "reason": reason }),
            );
        }
    }

    /// Runs `<shell> -l -i -c '<sok> setup environment'` in a process group of its own with standard input from /dev/null, and
    /// returns the environment of the JSON line that it prints. The read ends at that line, not at the end of the output or of the
    /// shell, because a process that the start files of the shell started can hold the output open; the process group ends in
    /// every outcome.
    fn read_environment(&self) -> Result<Environment, String> {
        let shell = self.processes.login_shell()?;
        let fail = |reason: String| format!("login shell {shell}: {reason}");
        let mut command = Command::new(&shell);
        command.env_clear();
        for name in SESSION_VARIABLES {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let sok = setup::step_of(&self.sok.display().to_string());
        let line = if Path::new(&shell)
            .file_name()
            .is_some_and(|name| name == "zsh")
        {
            // zsh permits ZDOTDIR to be local to the shell. The setup part needs its effective value.
            format!("export ZDOTDIR; {sok} setup environment")
        } else {
            format!("{sok} setup environment")
        };
        command
            .args(["-l", "-i", "-c"])
            .arg(line)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.processes
            .new_process_group(&mut command)
            .map_err(fail)?;
        let mut child = command
            .spawn()
            .map_err(|error| fail(format!("start: {}", os_reason(&error))))?;
        let group = child.id();
        // default: a child spawned with piped standard output and error has both pipes.
        let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let ended = self.processes.end_process_group(group);
            return Err(fail(match ended {
                Ok(()) => "the shell has no output pipes".into(),
                Err(ended) => format!("the shell has no output pipes\n{ended}"),
            }));
        };
        let (send, receive) = mpsc::channel();
        let sender = send.clone();
        crate::routine::spawn_named("login-shell-stdout", move || {
            deliver(&sender, Message::Stdout(environment_line(stdout)));
        });
        let sender = send.clone();
        crate::routine::spawn_named("login-shell-stderr", move || {
            let mut text = Vec::new();
            let read = stderr.read_to_end(&mut text).map(|_| text);
            deliver(&sender, Message::Stderr(read));
        });
        crate::routine::spawn_named("login-shell-wait", move || {
            deliver(&send, Message::Exited(child.wait()));
        });
        let read = self.read_output(&receive, group).map_err(fail);
        let ended = self.processes.end_process_group(group).map_err(fail);
        match (read, ended) {
            (read, Ok(())) => read,
            (Ok(_), Err(ended)) => Err(ended),
            (Err(read), Err(ended)) => Err(format!("{read}\n{ended}")),
        }
    }

    /// Reads the messages of the shell until its environment line, its end with its output, or the bound.
    fn read_output(
        &self,
        receive: &mpsc::Receiver<Message>,
        group: u32,
    ) -> Result<Environment, String> {
        let deadline = Instant::now() + LOGIN_SHELL_BOUND;
        let mut exited: Option<std::io::Result<ExitStatus>> = None;
        let mut stdout_done = false;
        let mut stderr_read: Option<std::io::Result<Vec<u8>>> = None;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receive.recv_timeout(remaining) {
                Ok(Message::Stdout(Some(environment))) => return Ok(environment),
                Ok(Message::Stdout(None)) => stdout_done = true,
                Ok(Message::Exited(status)) => {
                    // The output that the shell wrote before it ended is in the pipes. A process that the start files started can
                    // hold them open, so the process group ends first and the reads then take the output and end at the end of the
                    // pipes. A process that left the group and holds them leaves the read to the bound.
                    self.processes.end_process_group(group)?;
                    exited = Some(status);
                }
                Ok(Message::Stderr(read)) => stderr_read = Some(read),
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "no environment within {} s",
                        LOGIN_SHELL_BOUND.as_secs()
                    ));
                }
                // default: each thread sends its last message before it ends, and the three last messages end the read above.
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("the reads of the shell ended without their results".into());
                }
            }
            if let (Some(status), true, Some(read)) = (&exited, stdout_done, &stderr_read) {
                let mut reason = exit_reason(status);
                let text = match read {
                    Ok(text) => String::from_utf8_lossy(text),
                    Err(error) => {
                        return Err(format!(
                            "{reason}; read the standard error: {}",
                            os_reason(error)
                        ));
                    }
                };
                if let Some(line) = text.trim().lines().next().filter(|line| !line.is_empty()) {
                    reason.push_str(": ");
                    reason.push_str(line);
                }
                return Err(reason);
            }
        }
    }
}

/// Reads the parts of a setupInstall request: a non-empty list of setup part names without repetition.
/// The kinds of setup parts that `setupInstall` installs.
const SETUP_PART_KINDS: [Kind; 2] = [Kind::Skill, Kind::Mcp];

fn kinds_of(value: &Value) -> Result<Vec<Kind>, String> {
    let invalid = || "parts must be a non-empty list of setup parts without repetition".to_string();
    let list = value
        .as_array()
        .filter(|list| !list.is_empty())
        .ok_or_else(invalid)?;
    let mut names: Vec<&str> = Vec::new();
    for item in list {
        let name = item
            .as_str()
            .filter(|name| !names.contains(name))
            .ok_or_else(invalid)?;
        names.push(name);
    }
    names
        .into_iter()
        .map(|name| {
            Kind::parse(name)
                .filter(|kind| SETUP_PART_KINDS.contains(kind))
                .ok_or_else(|| format!("unknown setup part: {name}"))
        })
        .collect()
}

/// The longest line of the output of the shell, with its line end.
const MAX_LINE: u64 = 1 << 20;

/// Reads lines until one is the JSON object of `sok setup environment`; the lines before it are output of the start files of
/// the shell.
fn environment_line(reader: impl Read) -> Option<Environment> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        // The read of a line ends at its end or past the longest line that the Go host reads, which ends the read as it does.
        match (&mut reader)
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => return None,
            Ok(_) if line.len() as u64 > MAX_LINE => return None,
            Ok(_) => {}
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        let text = text.trim();
        if text.starts_with('{')
            && let Ok(environment) = Environment::from_line(text)
        {
            return Some(environment);
        }
    }
}

/// The exit status of a shell, or the signal that ended it.
fn exit_reason(status: &std::io::Result<ExitStatus>) -> String {
    use std::os::unix::process::ExitStatusExt;
    match status {
        Ok(status) => match (status.code(), status.signal()) {
            (_, Some(signal)) => format!("signal {signal}"),
            (Some(code), None) => format!("exit status {code}"),
            (None, None) => status.to_string(),
        },
        Err(error) => os_reason(error),
    }
}

/// The reason text of an operating system error, as the Go host writes it: lowercase, without the "(os error N)" that the
/// standard library appends.
pub(crate) fn os_reason(error: &std::io::Error) -> String {
    let text = error.to_string();
    let reason = match text.rfind(" (os error ") {
        Some(at) if error.raw_os_error().is_some() => &text[..at],
        _ => text.as_str(),
    };
    let mut chars = reason.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}
