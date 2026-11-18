//! The MCP registration (docs/spec/cli.md#mcp-registration): the entry `soksak` of the user scope of the `claude` command,
//! read from its configuration file and changed only through the command.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;
use serde_json::value::RawValue;

use crate::files::file_error;
use crate::platform;
use crate::setup::{Environment, Reason, require_writable_volume, status_text};

/// The first folder of `PATH` that holds an executable regular file of the name, as a canonical path, or None. The search reads
/// the `PATH` of the environment that the setup operations are given, not the one of this process, and it accepts the regular file
/// with an execute bit that the contract names; the search of the `which` crate tests access for this process instead, so the
/// folders are searched here.
pub(crate) fn find_on_path(
    environment: &Environment,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    let platform = platform::current()?;
    // default: a PATH that is not set has no folder.
    let path = environment.path.as_deref().unwrap_or("");
    for folder in std::env::split_paths(path) {
        if folder.as_os_str().is_empty() {
            continue;
        }
        let candidate = folder.join(name);
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() || !platform.executable(&metadata) {
            continue;
        }
        let resolved = std::fs::canonicalize(&candidate)
            .map_err(|error| file_error(candidate.display(), &error))?;
        return Ok(Some(resolved));
    }
    Ok(None)
}

/// The `claude` command on `PATH`, or None.
pub fn claude_command(environment: &Environment) -> Result<Option<PathBuf>, String> {
    find_on_path(environment, "claude")
}

/// The registered sok: the running sok, which is the sok of the application bundle that runs the command. On macOS it must be
/// the sok of an application bundle.
pub fn registered_sok(sok: &Path) -> Result<PathBuf, String> {
    if !platform::current()?.registrable_sok(sok)? {
        return Err(format!(
            "the running sok, {}, is not the sok of an application bundle",
            sok.display()
        ));
    }
    Ok(sok.to_path_buf())
}

/// The configuration file of the `claude` command: `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set and not empty,
/// else `<home>/.claude.json`.
pub fn config_file(environment: &Environment) -> Result<PathBuf, String> {
    let folder = match environment.claude_config_dir() {
        Some(folder) => PathBuf::from(folder),
        None => PathBuf::from(environment.home()?),
    };
    Ok(folder.join(".claude.json"))
}

/// The error of a JSON file that does not decode: `<file> is not valid JSON at line <l> column <c>` for a syntax error, and `<file>
/// is not a JSON object` for a value of another kind.
pub(crate) fn invalid_json(file: &Path, error: &serde_json::Error) -> String {
    match error.classify() {
        serde_json::error::Category::Syntax | serde_json::error::Category::Eof => format!(
            "{} is not valid JSON at line {} column {}",
            file.display(),
            error.line(),
            error.column()
        ),
        _ => format!("{} is not a JSON object", file.display()),
    }
}

/// `mcpServers.soksak` of the file as its compact text, or None when the file or the entry does not exist.
fn read_entry(file: &Path) -> Result<Option<Box<RawValue>>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(file_error(file.display(), &error)),
    };
    let config: HashMap<String, Box<RawValue>> =
        serde_json::from_str(&text).map_err(|error| invalid_json(file, &error))?;
    let Some(servers) = config
        .get("mcpServers")
        .filter(|servers| servers.get() != "null")
    else {
        return Ok(None);
    };
    let mut servers: HashMap<String, Box<RawValue>> = serde_json::from_str(servers.get())
        .map_err(|_| format!("{}: mcpServers is not an object", file.display()))?;
    let Some(entry) = servers.remove("soksak") else {
        return Ok(None);
    };
    let compact = crate::compact_line(entry.get())?.trim_end().to_string();
    RawValue::from_string(compact)
        .map(Some)
        .map_err(|error| format!("{}: {error}", file.display()))
}

/// Whether the entry is the current registration of the registered sok.
fn is_current(entry: &RawValue, registered: &Path) -> bool {
    // default: an entry that is not an object is not current, and the install replaces it.
    let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(entry.get()) else {
        return false;
    };
    let empty_env = match entry.get("env") {
        None => true,
        Some(Value::Object(env)) => env.is_empty(),
        Some(_) => false,
    };
    entry.get("type") == Some(&Value::from("stdio"))
        && entry.get("command") == Some(&Value::from(registered.display().to_string()))
        && entry.get("args") == Some(&serde_json::json!(["mcp"]))
        && empty_env
}

/// The state of the `mcp` part: its file and None when current, a reason when missing, or the error that the part shows.
pub struct McpPart {
    pub file: PathBuf,
    pub state: Result<Option<Reason>, String>,
}

/// The `mcp` part, or None when neither the `claude` command nor the `codex` command is on `PATH` and the part does not apply. The part
/// is ok only when every agent on `PATH` has the current registration. It fails when `HOME` is not set or the search of `PATH` fails.
pub fn part_state(environment: &Environment, sok: &Path) -> Result<Option<McpPart>, String> {
    let claude = claude_command(environment)?;
    let codex = codex_command(environment)?;
    if claude.is_none() && codex.is_none() {
        return Ok(None);
    }
    let registered = registered_sok(sok);
    let file = match &claude {
        Some(_) => config_file(environment)?,
        None => codex_config_file(environment)?,
    };
    let claude_state = match (&claude, &registered) {
        (None, _) => Ok(None),
        (Some(_), Err(error)) => Err(error.clone()),
        (Some(_), Ok(registered)) => {
            read_entry(&config_file(environment)?).map(|entry| match entry {
                None => Some(Reason::Absent),
                Some(entry) if is_current(&entry, registered) => None,
                Some(_) => Some(Reason::Differs),
            })
        }
    };
    let state = match (claude_state, codex, &registered) {
        (Err(error), _, _) => Err(error),
        (Ok(Some(reason)), _, _) => Ok(Some(reason)),
        (Ok(None), None, _) => Ok(None),
        (Ok(None), Some(_), Err(error)) => Err(error.clone()),
        (Ok(None), Some(codex), Ok(registered)) => match codex_entry(&codex, environment) {
            Err(error) => Err(error),
            Ok(None) => Ok(Some(Reason::CodexAbsent)),
            Ok(Some(text)) if codex_current(&text, registered) => Ok(None),
            Ok(Some(_)) => Ok(Some(Reason::CodexDiffers)),
        },
    };
    Ok(Some(McpPart { file, state }))
}

/// The `codex` command on `PATH`, or None.
pub fn codex_command(environment: &Environment) -> Result<Option<PathBuf>, String> {
    find_on_path(environment, "codex")
}

/// The configuration file of the `codex` command: `<home>/.codex/config.toml`.
pub fn codex_config_file(environment: &Environment) -> Result<PathBuf, String> {
    Ok(Path::new(environment.home()?)
        .join(".codex")
        .join("config.toml"))
}

/// The registration of soksak in the `codex` command as `codex mcp get soksak --json` prints it, or None when codex has none.
/// codex exits with status 1 and "No MCP server named" on standard error for a name that is not registered.
fn codex_entry(codex: &Path, environment: &Environment) -> Result<Option<String>, String> {
    let mut command = std::process::Command::new(codex);
    command
        .args(["mcp", "get", "soksak", "--json"])
        .stdin(std::process::Stdio::null());
    environment.apply(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("codex mcp get soksak: {}", crate::files::os_reason(&error)))?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("No MCP server named") {
        return Ok(None);
    }
    // default: a command that writes nothing to its standard error has an empty first line.
    let first = stderr.lines().next().unwrap_or("");
    Err(format!(
        "codex mcp get soksak failed with {}: {first}",
        status_text(&output.status)
    ))
}

/// Whether the codex entry is enabled and runs the registered sok with the argument mcp over standard input and output.
fn codex_current(text: &str, registered: &Path) -> bool {
    let Ok(Value::Object(server)) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let Some(Value::Object(transport)) = server.get("transport") else {
        return false;
    };
    server.get("enabled") == Some(&Value::Bool(true))
        && transport.get("type") == Some(&Value::from("stdio"))
        && transport.get("command") == Some(&Value::from(registered.display().to_string()))
        && transport.get("args") == Some(&Value::Array(vec![Value::from("mcp")]))
}

/// Registers the registered sok with the `codex` command unless its registration is current, and returns the state.
fn install_codex(
    codex: &Path,
    environment: &Environment,
    registered: &Path,
) -> Result<Done, String> {
    let earlier = codex_entry(codex, environment)?;
    if let Some(text) = &earlier
        && codex_current(text, registered)
    {
        return Ok(Done::Current);
    }
    if earlier.is_some() {
        run_codex(codex, environment, "remove", &["soksak"])?;
    }
    let registered_text = registered.display().to_string();
    run_codex(
        codex,
        environment,
        "add",
        &["soksak", "--", &registered_text, "mcp"],
    )?;
    match codex_entry(codex, environment)? {
        Some(text) if codex_current(&text, registered) => Ok(Done::Registered),
        _ => Err("codex mcp add did not write the registration of soksak".into()),
    }
}

/// Runs `codex mcp <action> <args>` with the environment, and fails with the first line of its standard error when it ends with
/// another status than 0.
fn run_codex(
    codex: &Path,
    environment: &Environment,
    action: &str,
    args: &[&str],
) -> Result<(), String> {
    let mut command = std::process::Command::new(codex);
    command
        .arg("mcp")
        .arg(action)
        .args(args)
        .stdin(std::process::Stdio::null());
    environment.apply(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("codex mcp {action}: {}", crate::files::os_reason(&error)))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // default: a command that writes nothing to its standard error has an empty first line.
    let first = stderr.lines().next().unwrap_or("");
    Err(format!(
        "codex mcp {action} failed with {}: {first}",
        status_text(&output.status)
    ))
}

/// What `sok mcp install` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Done {
    Current,
    Registered,
}

/// The result of `sok mcp install`: the entry of the claude command in the file after it (None when the claude command is not on
/// `PATH`), what it did, and what it did to the registration of the codex command (None when codex is not on `PATH`).
pub struct Registration {
    pub entry: Option<Box<RawValue>>,
    pub state: Done,
    pub codex: Option<Done>,
}

impl Registration {
    /// `{"registration": <entry or null>, "state": ..., "codex": ...}` on one line; `codex` is absent when codex is not on `PATH`.
    pub fn line(&self) -> String {
        let state = done_text(self.state);
        let entry = self.entry.as_ref().map_or("null", |entry| entry.get());
        match self.codex {
            Some(codex) => format!(
                "{{\"registration\":{entry},\"state\":\"{state}\",\"codex\":\"{}\"}}",
                done_text(codex)
            ),
            None => format!("{{\"registration\":{entry},\"state\":\"{state}\"}}"),
        }
    }
}

/// The text of a state in the output of `sok mcp install`.
fn done_text(done: Done) -> &'static str {
    match done {
        Done::Current => "current",
        Done::Registered => "registered",
    }
}

/// Runs `claude mcp <args>` with the environment, and fails with the first line of its standard error when it ends with another
/// status than 0.
fn run_claude(
    claude: &Path,
    environment: &Environment,
    action: &str,
    args: &[&str],
) -> Result<(), String> {
    let mut command = std::process::Command::new(claude);
    command
        .arg("mcp")
        .arg(action)
        .args(args)
        .stdin(std::process::Stdio::null());
    environment.apply(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("claude mcp {action}: {}", crate::files::os_reason(&error)))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    // default: a command that writes nothing to its standard error has an empty first line.
    let first = stderr.lines().next().unwrap_or("");
    Err(format!(
        "claude mcp {action} failed with {}: {first}",
        status_text(&output.status)
    ))
}

/// `sok mcp install`: registers the registered sok with the `claude` command when it is on `PATH`, and with the `codex` command
/// when it is on `PATH`, each unless its registration is current. It fails when neither command is on `PATH`.
pub fn install(environment: &Environment, sok: &Path) -> Result<Registration, String> {
    let registered = registered_sok(sok)?;
    require_writable_volume(&registered)?;
    let claude = claude_command(environment)?;
    let codex = codex_command(environment)?;
    if claude.is_none() && codex.is_none() {
        return Err(format!(
            "the claude command is not on PATH; register the MCP server \"{} mcp\" (standard input and output) with the agent",
            registered.display()
        ));
    }
    let codex_state = match &codex {
        Some(codex) => Some(install_codex(codex, environment, &registered)?),
        None => None,
    };
    let Some(claude) = claude else {
        let state = if codex_state == Some(Done::Registered) {
            Done::Registered
        } else {
            Done::Current
        };
        return Ok(Registration {
            entry: None,
            state,
            codex: codex_state,
        });
    };
    let mut done = install_claude(&claude, environment, &registered)?;
    if codex_state == Some(Done::Registered) {
        done.state = Done::Registered;
    }
    done.codex = codex_state;
    Ok(done)
}

/// Registers the registered sok with the `claude` command unless the registration is current.
fn install_claude(
    claude: &Path,
    environment: &Environment,
    registered: &Path,
) -> Result<Registration, String> {
    let file = config_file(environment)?;
    let earlier = read_entry(&file)?;
    if let Some(entry) = earlier.as_ref()
        && is_current(entry, registered)
    {
        return Ok(Registration {
            entry: Some(entry.clone()),
            state: Done::Current,
            codex: None,
        });
    }
    if earlier.is_some() {
        run_claude(
            claude,
            environment,
            "remove",
            &["--scope", "user", "soksak"],
        )?;
    }
    let registered_text = registered.display().to_string();
    if let Err(error) = run_claude(
        claude,
        environment,
        "add",
        &["--scope", "user", "soksak", "--", &registered_text, "mcp"],
    ) {
        return Err(match earlier {
            Some(entry) => {
                let command = match serde_json::from_str::<Value>(entry.get()) {
                    Ok(Value::Object(entry)) => match entry.get("command") {
                        Some(Value::String(command)) => command.clone(),
                        Some(other) => other.to_string(),
                        None => "null".into(),
                    },
                    _ => entry.get().to_string(),
                };
                format!("{error}; the earlier registration {command} was removed")
            }
            None => error,
        });
    }
    match read_entry(&file)? {
        Some(entry) if is_current(&entry, registered) => Ok(Registration {
            entry: Some(entry),
            state: Done::Registered,
            codex: None,
        }),
        _ => Err(format!(
            "claude mcp add did not write the registration to {}",
            file.display()
        )),
    }
}
