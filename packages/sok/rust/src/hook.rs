//! The session restart hook (docs/spec/agent-roles.md#session-restart-hook): the command `sok role identity` that the hook runs, and
//! the setup part `hook`, which writes the hook entries of the user agent folders and removes them.
//!
//! A hook file is parsed into `Ordered`, which keeps the members of each object in the order that the file wrote them. serde_json's
//! `Value` sorts the members of an object unless its preserve_order feature is on, and that feature would change every JSON that this
//! crate prints, so the order is kept here. The output is the two-space form that serde_json::to_string_pretty writes, which the Go
//! twin writes with encoding/json.Indent. A scalar is written by serde_json, so a number or a string that the file wrote in another
//! form, for example "\/", is written in the form serde_json uses.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use crate::Error;
use crate::Options;
use crate::files::file_error;
use crate::output::replace_file;
use crate::setup::{Part, Reason, Setup, State, step_of};

/// Starts the command of the hook. The command runs sok only where the host sets SOKSAK_CONFIG_DIR, which every process of a surface
/// carries (docs/spec/sidecars.md#processes-of-a-surface); elsewhere it exits 0 before sok starts.
const HOOK_GUARD: &str = "[ -n \"$SOKSAK_CONFIG_DIR\" ] || exit 0; exec ";

/// Ends the command of every hook entry that soksak registered. An install removes every entry whose command ends with it, under
/// every event, so a stale entry never survives.
const HOOK_MARK: &str = " role identity --soksak-hook";

/// The event whose hook starts the identity of a session.
const HOOK_EVENT: &str = "SessionStart";

/// The stable identity of a tab (docs/spec/agent-roles.md#stable-identity), with `{file}` for the path of its role file.
const IDENTITY_TEXT: &str = "[soksak role] Your role is defined in the file {file}. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role.";

/// A JSON value whose objects keep the order of their members as the file wrote them.
#[derive(Clone, Debug)]
enum Ordered {
    Object(Vec<(String, Ordered)>),
    Array(Vec<Ordered>),
    Scalar(Value),
}

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Ordered, D::Error> {
        struct Shape;

        impl<'de> Visitor<'de> for Shape {
            type Value = Ordered;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON value")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut members = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Ordered>()? {
                    members.push((key, value));
                }
                Ok(Ordered::Object(members))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Ordered, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Ordered>()? {
                    items.push(item);
                }
                Ok(Ordered::Array(items))
            }

            fn visit_bool<E>(self, value: bool) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::from(value)))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::from(value)))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::from(value)))
            }

            fn visit_str<E>(self, value: &str) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::String(value.to_string())))
            }

            fn visit_string<E>(self, value: String) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::String(value)))
            }

            fn visit_unit<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Null))
            }
        }

        deserializer.deserialize_any(Shape)
    }
}

/// An object with the members in the given order.
fn object(members: Vec<(&str, Ordered)>) -> Ordered {
    Ordered::Object(
        members
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

/// A string value.
fn text(value: &str) -> Ordered {
    Ordered::Scalar(Value::String(value.to_string()))
}

/// The member of an object with the key, when the value is an object that has it.
fn member<'a>(value: &'a Ordered, key: &str) -> Option<&'a Ordered> {
    match value {
        Ordered::Object(members) => members
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, member)| member),
        _ => None,
    }
}

/// The text of a string value.
fn as_text(value: &Ordered) -> Option<&str> {
    match value {
        Ordered::Scalar(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// The command of the hook for the sok at `sok`: the guard, then sok with the mark.
pub fn hook_command(sok: &str) -> String {
    format!("{HOOK_GUARD}{}{HOOK_MARK}", step_of(sok))
}

/// The hook files of the user agent folders that exist (docs/spec/agent-roles.md#session-restart-hook): settings.json of each Claude
/// folder, <home>/.claude and CLAUDE_CONFIG_DIR, and hooks.json of the Codex folder, CODEX_HOME or <home>/.codex.
fn hook_files(setup: &Setup) -> Result<Vec<PathBuf>, String> {
    let home = PathBuf::from(setup.environment.home()?);
    let mut claude = vec![home.join(".claude")];
    if let Some(dir) = setup
        .environment
        .claude_config_dir()
        .filter(|dir| !dir.is_empty())
    {
        let dir = PathBuf::from(dir);
        if dir != claude[0] {
            claude.push(dir);
        }
    }
    let mut files = Vec::new();
    for dir in claude {
        if dir.is_dir() {
            files.push(dir.join("settings.json"));
        }
    }
    let codex = match setup
        .environment
        .variables
        .get("CODEX_HOME")
        .filter(|dir| !dir.is_empty())
    {
        Some(dir) => PathBuf::from(dir),
        None => home.join(".codex"),
    };
    if codex.is_dir() {
        files.push(codex.join("hooks.json"));
    }
    Ok(files)
}

/// Parses a hook file and checks that it is an object whose `hooks` member, when present, is an object whose events are arrays.
fn hook_document(file: &Path, data: &[u8]) -> Result<Ordered, String> {
    let document: Ordered = serde_json::from_slice(data)
        .map_err(|_| format!("{}: hook file does not parse as JSON", file.display()))?;
    let Ordered::Object(members) = &document else {
        return Err(format!(
            "{}: hook file must hold a JSON object",
            file.display()
        ));
    };
    if let Some((_, hooks)) = members.iter().find(|(name, _)| name == "hooks") {
        let Ordered::Object(events) = hooks else {
            return Err(format!("{}: hooks must be an object", file.display()));
        };
        for (event, value) in events {
            if !matches!(value, Ordered::Array(_)) {
                return Err(format!(
                    "{}: hooks.{event} must be an array",
                    file.display()
                ));
            }
        }
    }
    Ok(document)
}

/// Reports whether a hook entry carries the mark of soksak.
fn is_soksak_hook(hook: &Ordered) -> bool {
    member(hook, "type").and_then(as_text) == Some("command")
        && member(hook, "command")
            .and_then(as_text)
            .is_some_and(|command| command.ends_with(HOOK_MARK))
}

/// Removes the entries that soksak registered under every event. A group whose hooks the removal emptied is dropped, and so is an
/// event that the removal emptied and the `hooks` member that the removal emptied; every other member keeps its place.
fn without_soksak_hooks(document: &mut Ordered) -> Result<(), String> {
    let Ordered::Object(root) = document else {
        return Ok(());
    };
    let Some(hooks_at) = root.iter().position(|(name, _)| name == "hooks") else {
        return Ok(());
    };
    let empty_events = {
        let Ordered::Object(events) = &mut root[hooks_at].1 else {
            return Ok(());
        };
        let mut emptied = Vec::new();
        let mut edited = false;
        for (event, list) in events.iter_mut() {
            let Ordered::Array(groups) = &mut *list else {
                continue;
            };
            let mut kept = Vec::new();
            let mut changed = false;
            for group in std::mem::take(groups) {
                let Ordered::Object(mut members) = group else {
                    return Err(format!(
                        "hooks.{event} holds a group that is not an object with an array of hooks"
                    ));
                };
                let Some(hooks_index) = members.iter().position(|(name, _)| name == "hooks") else {
                    return Err(format!(
                        "hooks.{event} holds a group that is not an object with an array of hooks"
                    ));
                };
                let Ordered::Array(hooks) = &members[hooks_index].1 else {
                    return Err(format!(
                        "hooks.{event} holds a group that is not an object with an array of hooks"
                    ));
                };
                if !hooks.iter().any(is_soksak_hook) {
                    kept.push(Ordered::Object(members));
                    continue;
                }
                changed = true;
                let keep: Vec<Ordered> = hooks
                    .iter()
                    .filter(|hook| !is_soksak_hook(hook))
                    .cloned()
                    .collect();
                if keep.is_empty() {
                    continue;
                }
                members[hooks_index].1 = Ordered::Array(keep);
                kept.push(Ordered::Object(members));
            }
            if !changed {
                *list = Ordered::Array(kept);
            } else {
                edited = true;
                if kept.is_empty() {
                    emptied.push(event.clone());
                } else {
                    *list = Ordered::Array(kept);
                }
            }
        }
        events.retain(|(event, _)| !emptied.contains(event));
        edited && events.is_empty()
    };
    if empty_events {
        root.remove(hooks_at);
    }
    Ok(())
}

/// Adds the group of the command to the SessionStart array, which is created when it is absent.
fn with_soksak_hook(document: &mut Ordered, command: &str) -> Result<(), String> {
    let group = object(vec![
        ("matcher", text("")),
        (
            "hooks",
            Ordered::Array(vec![object(vec![
                ("type", text("command")),
                ("command", text(command)),
            ])]),
        ),
    ]);
    let Ordered::Object(root) = document else {
        return Err("hook file must hold a JSON object".to_string());
    };
    let Some(hooks_at) = root.iter().position(|(name, _)| name == "hooks") else {
        root.push((
            "hooks".to_string(),
            object(vec![(HOOK_EVENT, Ordered::Array(vec![group]))]),
        ));
        return Ok(());
    };
    let Ordered::Object(events) = &mut root[hooks_at].1 else {
        return Err("hooks must be an object".to_string());
    };
    match events.iter().position(|(event, _)| event == HOOK_EVENT) {
        Some(at) => {
            let Ordered::Array(list) = &mut events[at].1 else {
                return Err(format!("hooks.{HOOK_EVENT} must be an array"));
            };
            list.push(group);
        }
        None => events.push((HOOK_EVENT.to_string(), Ordered::Array(vec![group]))),
    }
    Ok(())
}

/// Writes a value in the two-space form with the members in their order.
fn write_pretty(value: &Ordered, depth: usize, out: &mut String) {
    match value {
        Ordered::Object(members) if members.is_empty() => out.push_str("{}"),
        Ordered::Object(members) => {
            out.push_str("{\n");
            for (at, (key, member)) in members.iter().enumerate() {
                push_indent(depth + 1, out);
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_pretty(member, depth + 1, out);
                if at + 1 < members.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            push_indent(depth, out);
            out.push('}');
        }
        Ordered::Array(items) if items.is_empty() => out.push_str("[]"),
        Ordered::Array(items) => {
            out.push_str("[\n");
            for (at, item) in items.iter().enumerate() {
                push_indent(depth + 1, out);
                write_pretty(item, depth + 1, out);
                if at + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            push_indent(depth, out);
            out.push(']');
        }
        Ordered::Scalar(scalar) => out.push_str(&scalar.to_string()),
    }
}

/// Writes two spaces for each level of depth.
fn push_indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// Writes a document in the two-space form with a final line feed.
fn format_document(document: &Ordered) -> Vec<u8> {
    let mut text = String::new();
    write_pretty(document, 0, &mut text);
    text.push('\n');
    text.into_bytes()
}

/// The event and command of each entry that soksak registered in the document.
fn soksak_hook_entries(document: &Ordered) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let Some(Ordered::Object(events)) = member(document, "hooks") else {
        return entries;
    };
    for (event, groups) in events {
        let Ordered::Array(groups) = groups else {
            continue;
        };
        for group in groups {
            let Some(Ordered::Array(hooks)) = member(group, "hooks") else {
                continue;
            };
            for hook in hooks {
                if is_soksak_hook(hook) {
                    let command = member(hook, "command").and_then(as_text).unwrap_or("");
                    entries.push((event.clone(), command.to_string()));
                }
            }
        }
    }
    entries
}

/// The state of one hook file: ok when it holds exactly the current soksak entry under SessionStart.
fn hook_part(file: &Path, sok: &str) -> Part {
    let command = hook_command(sok);
    let mut part = Part {
        part: "hook",
        file: file.display().to_string(),
        state: State::Missing,
        step: format!("{} setup install hook", step_of(sok)),
        reason: Some(Reason::Absent),
        error: None,
        changed: None,
    };
    let data = match std::fs::read(file) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return part,
        Err(error) => {
            part.state = State::Error;
            part.reason = None;
            part.error = Some(file_error(file.display(), &error));
            return part;
        }
    };
    let document = match hook_document(file, &data) {
        Ok(document) => document,
        Err(error) => {
            part.state = State::Error;
            part.reason = None;
            part.error = Some(error);
            return part;
        }
    };
    match soksak_hook_entries(&document).as_slice() {
        [] => {}
        [(event, found)] if event == HOOK_EVENT && *found == command => {
            part.state = State::Ok;
            part.reason = None;
        }
        _ => part.reason = Some(Reason::Differs),
    }
    part
}

/// The hook part of each hook file that exists for this setup.
pub fn hook_parts(setup: &Setup) -> Result<Vec<Part>, String> {
    let sok = setup.sok.display().to_string();
    Ok(hook_files(setup)?
        .iter()
        .map(|file| hook_part(file, &sok))
        .collect())
}

/// The outcome of writing one hook file: whether its bytes changed, and the failure of the write when there is one.
struct Written {
    changed: bool,
    failure: Option<String>,
}

impl Written {
    fn unchanged() -> Written {
        Written {
            changed: false,
            failure: None,
        }
    }

    fn failed(failure: String) -> Written {
        Written {
            changed: false,
            failure: Some(failure),
        }
    }

    fn changed() -> Written {
        Written {
            changed: true,
            failure: None,
        }
    }
}

/// Restores the permission bits of the file that the rewrite replaced. A failure keeps the change of the rewrite.
fn keep_mode(file: &Path, mode: std::fs::Permissions, written: Written) -> Written {
    match std::fs::set_permissions(file, mode) {
        Ok(()) => written,
        Err(error) => Written {
            changed: written.changed,
            failure: Some(file_error(file.display(), &error)),
        },
    }
}

/// The bytes of a hook file after an install: the file without the soksak entries, with the current entry added.
fn rewrite_for_install(file: &Path, data: &[u8], command: &str) -> Result<Vec<u8>, String> {
    let mut document = hook_document(file, data)?;
    without_soksak_hooks(&mut document).map_err(|error| format!("{}: {error}", file.display()))?;
    with_soksak_hook(&mut document, command)
        .map_err(|error| format!("{}: {error}", file.display()))?;
    Ok(format_document(&document))
}

/// Writes the current soksak entry into a hook file, creating a missing file and keeping every other entry.
fn install_hook_file(file: &Path, command: &str) -> Written {
    let mode = match std::fs::metadata(file) {
        Ok(info) => Some(info.permissions()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Written::failed(file_error(file.display(), &error)),
    };
    let data = match mode {
        Some(_) => match std::fs::read(file) {
            Ok(data) => data,
            Err(error) => return Written::failed(file_error(file.display(), &error)),
        },
        None => b"{}".to_vec(),
    };
    let out = match rewrite_for_install(file, &data, command) {
        Ok(out) => out,
        Err(error) => return Written::failed(error),
    };
    if mode.is_some() && out == data {
        return Written::unchanged();
    }
    if let Err(error) = replace_file(file, &out) {
        return Written::failed(error);
    }
    match mode {
        Some(mode) => keep_mode(file, mode, Written::changed()),
        None => Written::changed(),
    }
}

/// Removes the soksak entries of a hook file, which is left untouched when it is absent or holds none.
fn remove_hook_file(file: &Path) -> Written {
    let data = match std::fs::read(file) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Written::unchanged(),
        Err(error) => return Written::failed(file_error(file.display(), &error)),
    };
    let out = match hook_document(file, &data).and_then(|mut document| {
        without_soksak_hooks(&mut document)
            .map_err(|error| format!("{}: {error}", file.display()))?;
        Ok(format_document(&document))
    }) {
        Ok(out) => out,
        Err(error) => return Written::failed(error),
    };
    if out == data {
        return Written::unchanged();
    }
    let mode = match std::fs::metadata(file) {
        Ok(info) => info.permissions(),
        Err(error) => return Written::failed(file_error(file.display(), &error)),
    };
    if let Err(error) = replace_file(file, &out) {
        return Written::failed(error);
    }
    keep_mode(file, mode, Written::changed())
}

/// The result of writing every hook file: the files that changed, and the failure of each file that could not be written.
pub struct HookInstall {
    pub changed: Vec<String>,
    pub failures: Vec<String>,
}

/// Writes the current soksak entry into each hook file that exists.
pub fn install_hooks(setup: &Setup) -> Result<HookInstall, String> {
    let command = hook_command(&setup.sok.display().to_string());
    let mut install = HookInstall {
        changed: Vec::new(),
        failures: Vec::new(),
    };
    for file in hook_files(setup)? {
        let written = install_hook_file(&file, &command);
        if written.changed {
            install.changed.push(file.display().to_string());
        }
        install.failures.extend(written.failure);
    }
    Ok(install)
}

/// Removes the soksak entries of each hook file that exists. It fails with the failures of the files that could not be written.
pub fn remove_hooks(setup: &Setup) -> Result<(), String> {
    let failures: Vec<String> = hook_files(setup)?
        .iter()
        .filter_map(|file| remove_hook_file(file).failure)
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// Reports whether text holds a control character.
fn has_control_character(text: &str) -> bool {
    text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

/// `sok role` accepts only the action `identity`, with the mark of the hook and the option of the configuration directory.
pub fn run_role(args: &[String], stdout: &mut dyn Write, options: &Options) -> Result<(), Error> {
    let parsed = crate::parse_scoped_arguments(args, &["soksak-hook"], &["config-dir"])?;
    if parsed.positionals.len() != 1 || parsed.positionals[0] != "identity" {
        return Err(Error::Usage("role takes the action identity".into()));
    }
    run_role_identity(stdout, options, &parsed.values)
}

/// `sok role identity` prints the identity of the tab of this process as the additionalContext of a SessionStart hook. It prints
/// nothing when the process is outside a window, the tab has no role, or the environment has no configuration directory
/// (docs/spec/agent-roles.md#session-restart-hook).
fn run_role_identity(
    stdout: &mut dyn Write,
    options: &Options,
    values: &std::collections::HashMap<String, String>,
) -> Result<(), Error> {
    if options
        .config_dir_variable
        .filter(|dir| !dir.is_empty())
        .is_none()
    {
        return Ok(());
    }
    let config_dir = crate::config_dir_of(values, options)?;
    let config_text = config_dir.display().to_string();
    if config_text.contains(['"', '\'', '`', '\\']) || has_control_character(&config_text) {
        return Err(Error::Failed(format!(
            "configuration directory {config_text} holds a quote or a control character"
        )));
    }
    let mut client = crate::connect_to(values, options)?;
    let answer = crate::agent_window::own_surface(&mut |method: &str, params: Option<Value>| {
        client.request(method, params, &mut crate::no_notify)
    });
    let closed = client.close();
    let answer = answer.map_err(Error::from)?;
    closed.map_err(Error::Failed)?;
    let surface = match answer {
        crate::agent_window::OwnSurface::Refused(_) => return Ok(()),
        crate::agent_window::OwnSurface::Surface(surface) => surface,
    };
    if surface.contains(['/', '\\']) || surface == ".." || has_control_character(&surface) {
        return Err(Error::Failed(format!(
            "surface {surface:?} holds a path part or a control character"
        )));
    }
    let file = config_dir.join("agents").join(&surface).join("role.md");
    match std::fs::metadata(&file) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(Error::Failed(file_error(file.display(), &error))),
    }
    let identity = IDENTITY_TEXT.replacen("{file}", &file.display().to_string(), 1);
    // The fields are declared in the order that the hook reads them, which serde writes in that order.
    #[derive(serde::Serialize)]
    struct Output<'a> {
        #[serde(rename = "hookSpecificOutput")]
        hook_specific_output: HookOutput<'a>,
    }
    #[derive(serde::Serialize)]
    struct HookOutput<'a> {
        #[serde(rename = "hookEventName")]
        hook_event_name: &'a str,
        #[serde(rename = "additionalContext")]
        additional_context: &'a str,
    }
    let output = Output {
        hook_specific_output: HookOutput {
            hook_event_name: HOOK_EVENT,
            additional_context: &identity,
        },
    };
    let text = serde_json::to_string(&output).map_err(|error| Error::Failed(error.to_string()))?;
    stdout
        .write_all(format!("{text}\n").as_bytes())
        .map_err(|error| Error::Failed(error.to_string()))
}
