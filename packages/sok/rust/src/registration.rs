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

/// The registered sok: the first sok on `PATH` with symbolic links resolved, else the running sok. On macOS it must be the sok
/// of an application bundle.
pub fn registered_sok(environment: &Environment, sok: &Path) -> Result<PathBuf, String> {
    let registered = match find_on_path(environment, "sok")? {
        Some(found) => found,
        None => sok.to_path_buf(),
    };
    if !platform::current()?.registrable_sok(&registered)? {
        return Err(format!(
            "the first sok on PATH, {}, is not the sok of an application bundle",
            registered.display()
        ));
    }
    Ok(registered)
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

/// The `mcp` part, or None when the `claude` command is not on `PATH` and the part does not apply. It fails when `HOME` is not set
/// or the search of `PATH` fails.
pub fn part_state(environment: &Environment, sok: &Path) -> Result<Option<McpPart>, String> {
    if claude_command(environment)?.is_none() {
        return Ok(None);
    }
    let file = config_file(environment)?;
    let state = registered_sok(environment, sok).and_then(|registered| {
        Ok(match read_entry(&file)? {
            None => Some(Reason::Absent),
            Some(entry) if is_current(&entry, &registered) => None,
            Some(_) => Some(Reason::Differs),
        })
    });
    Ok(Some(McpPart { file, state }))
}

/// What `sok mcp install` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Done {
    Current,
    Registered,
}

/// The result of `sok mcp install`: the entry in the file after it, what it did, and the registered sok.
pub struct Registration {
    pub entry: Box<RawValue>,
    pub state: Done,
    pub registered: PathBuf,
}

impl Registration {
    /// `{"registration": <entry>, "state": ..., "running"?: <sok>}` on one line; `running` names the running sok when it is not
    /// the registered one.
    pub fn line(&self, sok: &Path) -> String {
        let state = match self.state {
            Done::Current => "current",
            Done::Registered => "registered",
        };
        let mut line = format!(
            "{{\"registration\":{},\"state\":\"{state}\"",
            self.entry.get()
        );
        if sok != self.registered {
            line.push_str(",\"running\":");
            line.push_str(&Value::from(sok.display().to_string()).to_string());
        }
        line.push('}');
        line
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

/// `sok mcp install`: registers the registered sok with the `claude` command unless the registration is current.
pub fn install(environment: &Environment, sok: &Path) -> Result<Registration, String> {
    let registered = registered_sok(environment, sok)?;
    require_writable_volume(&registered)?;
    let Some(claude) = claude_command(environment)? else {
        return Err(format!(
            "the claude command is not on PATH; register the MCP server \"{} mcp\" (standard input and output) with the agent",
            registered.display()
        ));
    };
    let file = config_file(environment)?;
    let earlier = read_entry(&file)?;
    if let Some(entry) = earlier.as_ref()
        && is_current(entry, &registered)
    {
        return Ok(Registration {
            entry: entry.clone(),
            state: Done::Current,
            registered,
        });
    }
    if earlier.is_some() {
        run_claude(
            &claude,
            environment,
            "remove",
            &["--scope", "user", "soksak"],
        )?;
    }
    let registered_text = registered.display().to_string();
    if let Err(error) = run_claude(
        &claude,
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
        Some(entry) if is_current(&entry, &registered) => Ok(Registration {
            entry,
            state: Done::Registered,
            registered,
        }),
        _ => Err(format!(
            "claude mcp add did not write the registration to {}",
            file.display()
        )),
    }
}
