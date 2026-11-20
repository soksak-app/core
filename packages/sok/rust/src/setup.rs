//! The setup parts of an agent (docs/spec/cli.md#setup-parts): the path entry, the skill files and the MCP registration. The
//! commands `sok setup` and the host (docs/spec/cli.md#agents-in-the-application) run the same functions.

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::json;

use crate::event_bounds::cut_text;
use crate::event_log::Level;
use crate::logged::CALL_TEXT_BYTES;
use crate::{Error, Options, indent, platform, registration, skill};

/// `HOME`, `PATH` and `CLAUDE_CONFIG_DIR` of the environment that the setup operations read, where `None` is a variable that is not
/// set, and every variable of that environment, from which the host builds the environment of its sidecars
/// (docs/spec/cli.md#agents-in-the-application).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Environment {
    pub home: Option<String>,
    pub path: Option<String>,
    pub claude_config_dir: Option<String>,
    pub variables: std::collections::BTreeMap<String, String>,
}

impl Environment {
    /// The variables of the environment of this process. A value that is not UTF-8 is an error that names the variable.
    pub fn current() -> Result<Environment, String> {
        let read = |name: &str| match std::env::var(name) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} is not valid UTF-8")),
        };
        let mut variables = std::collections::BTreeMap::new();
        for (name, value) in std::env::vars_os() {
            let name = name
                .into_string()
                .map_err(|name| format!("{} is not valid UTF-8", name.to_string_lossy()))?;
            let value = value
                .into_string()
                .map_err(|_| format!("{name} is not valid UTF-8"))?;
            variables.insert(name, value);
        }
        Ok(Environment {
            home: read("HOME")?,
            path: read("PATH")?,
            claude_config_dir: read("CLAUDE_CONFIG_DIR")?,
            variables,
        })
    }

    /// The JSON line that `sok setup environment` prints, without its line end.
    pub fn line(&self) -> Result<String, String> {
        #[derive(Serialize)]
        struct Line<'a> {
            #[serde(rename = "HOME")]
            home: &'a Option<String>,
            #[serde(rename = "PATH")]
            path: &'a Option<String>,
            #[serde(rename = "CLAUDE_CONFIG_DIR")]
            claude_config_dir: &'a Option<String>,
            environment: &'a std::collections::BTreeMap<String, String>,
        }
        serde_json::to_string(&Line {
            home: &self.home,
            path: &self.path,
            claude_config_dir: &self.claude_config_dir,
            environment: &self.variables,
        })
        .map_err(|error| error.to_string())
    }

    /// Reads the line that `sok setup environment` prints: an object whose three variables are strings or `null` and whose
    /// `environment` is an object of strings.
    pub fn from_line(line: &str) -> Result<Environment, String> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Line {
            #[serde(rename = "HOME")]
            home: Option<String>,
            #[serde(rename = "PATH")]
            path: Option<String>,
            #[serde(rename = "CLAUDE_CONFIG_DIR")]
            claude_config_dir: Option<String>,
            environment: std::collections::BTreeMap<String, String>,
        }
        let read: Line = serde_json::from_str(line)
            .map_err(|error| format!("the environment line is not valid: {error}"))?;
        Ok(Environment {
            home: read.home,
            path: read.path,
            claude_config_dir: read.claude_config_dir,
            variables: read.environment,
        })
    }

    /// The value of `HOME`; a variable that is not set or empty fails with `HOME is not set`.
    pub fn home(&self) -> Result<&str, String> {
        self.home
            .as_deref()
            .filter(|home| !home.is_empty())
            .ok_or_else(|| "HOME is not set".to_string())
    }

    /// The value of `CLAUDE_CONFIG_DIR` when it is set and not empty.
    pub fn claude_config_dir(&self) -> Option<&str> {
        self.claude_config_dir
            .as_deref()
            .filter(|folder| !folder.is_empty())
    }

    /// Sets the three variables on a command that a setup operation starts, and removes a variable that is not set.
    pub(crate) fn apply(&self, command: &mut std::process::Command) {
        for (name, value) in [
            ("HOME", &self.home),
            ("PATH", &self.path),
            ("CLAUDE_CONFIG_DIR", &self.claude_config_dir),
        ] {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
    }
}

/// The absolute path of the running sok with symbolic links resolved.
pub fn running_sok() -> Result<PathBuf, String> {
    std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|error| format!("the location of sok is unknown: {error}"))
}

/// The path of a sok as a person types it into a shell: as it is when it holds only `A-Za-z0-9/._-`, else between single
/// quotes with each single quote written `'\''`.
pub fn step_of(sok: &str) -> String {
    let text = sok;
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'));
    if plain {
        text.to_string()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

/// Fails with the text of a sok on a read-only volume (docs/spec/cli.md#mcp-registration): the judgement of `sok path install`
/// for the running sok and of `sok mcp install` for the registered sok.
pub fn require_writable_volume(sok: &Path) -> Result<(), String> {
    if platform::current()?.read_only_volume(sok)? {
        return Err(format!(
            "{} is on a read-only volume; move the application to a folder such as /Applications and start it again",
            sok.display()
        ));
    }
    Ok(())
}

/// A kind of setup part.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Path,
    Skill,
    Mcp,
    Hook,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::Path, Kind::Skill, Kind::Mcp, Kind::Hook];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Path => "path",
            Kind::Skill => "skill",
            Kind::Mcp => "mcp",
            Kind::Hook => "hook",
        }
    }

    pub fn parse(name: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| kind.as_str() == name)
    }
}

/// The state of a setup part.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Ok,
    Missing,
    Error,
}

/// Why a part is missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Absent,
    Differs,
    /// The codex command has no registration of soksak.
    #[serde(rename = "codex absent")]
    CodexAbsent,
    /// The registration of soksak in the codex command runs another command.
    #[serde(rename = "codex differs")]
    CodexDiffers,
}

/// One setup part as `sok setup check` prints it; `changed` is set by an install.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Part {
    pub part: &'static str,
    pub file: String,
    pub state: State,
    pub step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
}

impl Part {
    fn new(kind: Kind, file: &Path, step: String, state: Result<Option<Reason>, String>) -> Part {
        let (state, reason, error) = match state {
            Ok(None) => (State::Ok, None, None),
            Ok(Some(reason)) => (State::Missing, Some(reason), None),
            Err(error) => (State::Error, None, Some(error)),
        };
        Part {
            part: kind.as_str(),
            file: file.display().to_string(),
            state,
            step,
            reason,
            error,
            changed: None,
        }
    }
}

/// What the setup operations read and change: the environment, the sok whose setup they describe, and the path entry of its
/// application.
pub struct Setup<'a> {
    pub environment: &'a Environment,
    /// The sok of the application: the running sok for `sok setup`, the sok of the bundle for the host.
    pub sok: &'a Path,
    /// The identifier of the application, the file name of its path entry.
    pub identifier: &'a str,
    /// The folder of path entries; an error when the platform has none, and then the path part does not apply.
    pub paths_dir: Result<&'a Path, String>,
}

impl Setup<'_> {
    fn path_entry(&self) -> Option<PathBuf> {
        self.paths_dir
            .as_ref()
            // default: a platform without a path entry folder has no path part (docs/spec/cli.md#setup-parts).
            .ok()
            .map(|dir| dir.join(self.identifier))
    }
}

/// The parts of the setup in the order of the table, the skill files in the order of the agent folders. It fails only when
/// `HOME` is not set.
pub fn check(setup: &Setup) -> Result<Vec<Part>, String> {
    let mut parts = Vec::new();
    if let Some(file) = setup.path_entry() {
        parts.push(Part::new(
            Kind::Path,
            &file,
            format!(
                "sudo {} path install",
                step_of(&setup.sok.display().to_string())
            ),
            crate::path::entry_state(&file, setup.sok),
        ));
    }
    for file in skill::skill_files(setup.environment)? {
        let state = skill::skill_state(&file);
        parts.push(Part::new(
            Kind::Skill,
            &file,
            format!(
                "{} skill install",
                step_of(&setup.sok.display().to_string())
            ),
            state,
        ));
    }
    if let Some(mcp) = registration::part_state(setup.environment, setup.sok)? {
        parts.push(Part::new(
            Kind::Mcp,
            &mcp.file,
            format!("{} mcp install", step_of(&setup.sok.display().to_string())),
            mcp.state,
        ));
    }
    parts.extend(crate::hook::hook_parts(setup)?);
    Ok(parts)
}

/// The result of an install: the parts as `check` reads them afterwards, each with `changed`, and the error that names the parts of
/// the kinds that are not `ok`, followed by the error of each install that failed.
pub struct Installed {
    pub parts: Vec<Part>,
    pub error: Option<String>,
}

/// Installs each part of the kinds (every kind for none) that is not `ok` by the rules of its own command and leaves an `ok` part
/// unchanged. The path entry is installed only when `terminal` is set, through `sudo <sok> path install` as a child that asks for
/// the password on that terminal.
pub fn install(setup: &Setup, kinds: &[Kind], terminal: bool) -> Result<Installed, String> {
    let before = check(setup)?;
    let named = |kind: Kind| kinds.is_empty() || kinds.contains(&kind);
    let pending = |kind: Kind| {
        named(kind)
            && before
                .iter()
                .any(|part| part.part == kind.as_str() && part.state != State::Ok)
    };
    let mut changed: Vec<String> = Vec::new();
    let mut failures = Vec::new();
    if pending(Kind::Path)
        && terminal
        && let Some(file) = setup.path_entry()
    {
        let file = file.display().to_string();
        let installed = sudo_path_install(setup);
        record_path_step(&file, installed.as_ref().err());
        match installed {
            Ok(()) => changed.push(file),
            Err(error) => failures.push(error),
        }
    }
    if pending(Kind::Mcp) {
        match registration::install(setup.environment, setup.sok) {
            Ok(done) => {
                if done.state == registration::Done::Registered {
                    // The mcp part reports the claude file, or the codex file when the claude command is not on PATH.
                    let file = if done.entry.is_some() {
                        registration::config_file(setup.environment)?
                    } else {
                        registration::codex_config_file(setup.environment)?
                    };
                    changed.push(file.display().to_string());
                }
            }
            Err(error) => failures.push(error),
        }
    }
    // The skills are written after the registration, which can create an agent folder, such as the Codex folder that `codex mcp
    // add` creates; the skill parts are read again, so the skill file of that folder is written too (docs/spec/cli.md#agent-skill).
    if named(Kind::Skill)
        && check(setup)?
            .iter()
            .any(|part| part.part == Kind::Skill.as_str() && part.state != State::Ok)
    {
        match skill::install_skill_files(setup.environment) {
            Ok((files, skill_failures)) => {
                for file in files {
                    if file.state == skill::SkillState::Written {
                        changed.push(file.file);
                    }
                }
                if !skill_failures.is_empty() {
                    failures.push(skill::failures_text(&skill_failures));
                }
            }
            Err(error) => failures.push(error),
        }
    }
    // The hook files are read after the registration too, which can create the Codex folder, as the skills are.
    if named(Kind::Hook)
        && check(setup)?
            .iter()
            .any(|part| part.part == Kind::Hook.as_str() && part.state != State::Ok)
    {
        let hooks = crate::hook::install_hooks(setup)?;
        changed.extend(hooks.changed);
        failures.extend(hooks.failures);
    }
    let mut parts = check(setup)?;
    for part in &mut parts {
        part.changed = Some(changed.contains(&part.file));
    }
    let error = not_current(&parts, kinds).map(|text| {
        std::iter::once(text)
            .chain(failures)
            .collect::<Vec<_>>()
            .join("; ")
    });
    Ok(Installed { parts, error })
}

/// Stores the result of `sudo <sok> path install` as `sok.setup.path` in the event file of the run (docs/spec/cli.md#event-log): the
/// path entry command runs as root and opens no event file, so the run of the person records it. A run without an event file, such
/// as a host, stores nothing.
fn record_path_step(file: &str, error: Option<&String>) {
    let Some(error) = error else {
        crate::replay::emit_run_event(
            Level::Info,
            "sok.setup.path",
            &json!({"file": file, "ok": true}),
        );
        return;
    };
    let (text, cut) = cut_text(error, CALL_TEXT_BYTES);
    let mut fields = json!({"file": file, "ok": false, "error": text});
    if cut {
        fields["truncated"] = json!(true);
    }
    crate::replay::emit_run_event(Level::Warn, "sok.setup.path", &fields);
}

/// Runs `sudo <sok> path install` with the terminal of this process for the password; its standard output is discarded, because
/// the standard output of this process holds the parts, and its standard error goes to this process.
fn sudo_path_install(setup: &Setup) -> Result<(), String> {
    let step = step_of(&setup.sok.display().to_string());
    let Some(sudo) = registration::find_on_path(setup.environment, "sudo")? else {
        return Err("the sudo command is not on PATH".into());
    };
    let mut command = std::process::Command::new(sudo);
    command
        .arg(setup.sok)
        .args(["path", "install"])
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    setup.environment.apply(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "sudo {step} path install: {}",
            crate::files::os_reason(&error)
        )
    })?;
    // The standard error of sudo is shown on the standard error of this process and its first line kept for the error.
    let mut first = String::new();
    if let Some(stderr) = child.stderr.take() {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stderr).lines() {
            let line = line.map_err(|error| {
                format!(
                    "sudo {step} path install: {}",
                    crate::files::os_reason(&error)
                )
            })?;
            eprintln!("{line}");
            if first.is_empty() {
                first = line;
            }
        }
    }
    let status = child.wait().map_err(|error| {
        format!(
            "sudo {step} path install: {}",
            crate::files::os_reason(&error)
        )
    })?;
    if status.success() {
        return Ok(());
    }
    Err(format!(
        "sudo {step} path install failed with {}: {first}",
        status_text(&status)
    ))
}

/// The end of a child process: `status <n>`, or the text of the standard library for a process that a signal ended.
pub(crate) fn status_text(status: &std::process::ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("status {code}"),
        None => status.to_string(),
    }
}

/// The text of the parts of the kinds (every kind for none) that are not `ok`: `setup parts are not current: <part> <file>, ...`,
/// or None when every such part is `ok`.
pub fn not_current(parts: &[Part], kinds: &[Kind]) -> Option<String> {
    let open: Vec<String> = parts
        .iter()
        .filter(|part| {
            part.state != State::Ok
                && (kinds.is_empty() || kinds.iter().any(|kind| kind.as_str() == part.part))
        })
        .map(|part| format!("{} {}", part.part, part.file))
        .collect();
    (!open.is_empty()).then(|| format!("setup parts are not current: {}", open.join(", ")))
}

fn print(stdout: &mut dyn Write, value: &impl Serialize) -> Result<(), Error> {
    let out = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    writeln!(stdout, "{out}").map_err(|error| Error::Failed(error.to_string()))
}

/// Runs `sok skill print|install`, `sok mcp install` and `sok setup check|install|environment`.
pub(crate) fn run_agent_setup(
    positionals: &[String],
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let word = positionals[0].as_str();
    let action = positionals
        .get(1)
        .ok_or_else(|| Error::Usage(format!("{word} action is required")))?;
    if word == "setup" && action == "remove" {
        if positionals.len() != 3 || positionals[2] != "hook" {
            return Err(Error::Usage("setup remove takes the part hook".into()));
        }
        let environment = Environment::current()?;
        let sok = running_sok()?;
        let setup = Setup {
            environment: &environment,
            sok: &sok,
            identifier: options.identifier,
            paths_dir: options.paths_dir.clone(),
        };
        crate::hook::remove_hooks(&setup)?;
        let parts = crate::hook::hook_parts(&setup)?;
        return print(stdout, &json!({ "parts": parts }));
    }
    let extra = &positionals[2..];
    let mut kinds = Vec::new();
    if word == "setup" && action == "install" {
        for name in extra {
            kinds.push(
                Kind::parse(name)
                    .ok_or_else(|| Error::Usage(format!("unknown setup part: {name}")))?,
            );
        }
    } else if let Some(argument) = extra.first() {
        return Err(Error::Usage(format!("unexpected argument {argument}")));
    }
    let write = |stdout: &mut dyn Write, text: &str| {
        stdout
            .write_all(text.as_bytes())
            .map_err(|error| Error::Failed(error.to_string()))
    };
    match (word, action.as_str()) {
        ("skill", "print") => return write(stdout, crate::agents::SKILL),
        ("setup", "environment") => {
            let line = Environment::current()?.line()?;
            return write(stdout, &format!("{line}\n"));
        }
        ("skill", "install") | ("mcp", "install") | ("setup", "check") | ("setup", "install") => {}
        _ => return Err(Error::Usage(format!("unknown {word} action: {action}"))),
    }
    let environment = Environment::current()?;
    let sok = running_sok()?;
    let setup = Setup {
        environment: &environment,
        sok: &sok,
        identifier: options.identifier,
        paths_dir: options.paths_dir.clone(),
    };
    match (word, action.as_str()) {
        ("skill", "install") => {
            let (files, failures) = skill::install_skill_files(&environment)?;
            print(stdout, &json!({ "skills": files }))?;
            if failures.is_empty() {
                Ok(())
            } else {
                Err(Error::Failed(skill::failures_text(&failures)))
            }
        }
        ("mcp", "install") => {
            let done = registration::install(&environment, &sok)?;
            write(stdout, &indent(&done.line())?)
        }
        ("setup", "check") => {
            let parts = check(&setup)?;
            print(stdout, &json!({ "parts": parts }))?;
            match not_current(&parts, &[]) {
                None => Ok(()),
                Some(text) => Err(Error::Failed(text)),
            }
        }
        _ => {
            let installed = install(&setup, &kinds, std::io::stdin().is_terminal())?;
            print(stdout, &json!({ "parts": installed.parts }))?;
            match installed.error {
                None => Ok(()),
                Some(text) => Err(Error::Failed(text)),
            }
        }
    }
}
