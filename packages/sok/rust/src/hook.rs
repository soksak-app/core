//! The session restart hook (docs/spec/agent-roles.md#session-restart-hook): the command `sok role identity` that the hook runs, and
//! the setup part `hook`, which writes the hook entries of the user agent folders and removes them.
//!
//! A hook file is read into objects whose members keep their exact bytes. serde_json reads each member's key and value, and
//! `serde_json::value::RawValue` keeps the text of each value. The text of a key is not returned by serde_json, so the key span is
//! located in the object text, and the located span is checked against the value text of serde_json before it is used. An edit
//! rebuilds only the objects and arrays on the path to the changed entries; every other member is written as it was read. The
//! rebuilt text is indented by `jsonxf`, which, like the `encoding/json.Indent` of the Go twin, changes only the insignificant
//! whitespace and keeps every string and number as it was written (docs/spec/agent-roles.md#session-restart-hook).

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;

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

/// One member of an object: the text of its key, the key, and the text of its value. Members keep the order of the file, and a key
/// that appears twice is kept twice, as the file wrote it.
struct Member {
    raw_key: String,
    key: String,
    value: Box<RawValue>,
}

type Members = Vec<Member>;

/// The members of an object read by serde_json, before the key texts are located.
struct Pairs(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Pairs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Pairs, D::Error> {
        struct Object;

        impl<'de> Visitor<'de> for Object {
            type Value = Pairs;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Pairs, A::Error> {
                let mut pairs = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    pairs.push((key, value));
                }
                Ok(Pairs(pairs))
            }
        }

        deserializer.deserialize_map(Object)
    }
}

/// The end of the JSON whitespace at or after `at`.
fn skip_whitespace(text: &[u8], mut at: usize) -> usize {
    while at < text.len() && matches!(text[at], b' ' | b'\t' | b'\n' | b'\r') {
        at += 1;
    }
    at
}

/// The end of the string literal that starts at `at`, which holds a quote. The text is valid JSON, so the literal ends.
fn string_end(text: &[u8], at: usize) -> usize {
    let mut i = at + 1;
    loop {
        match text[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
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

/// Parses an object whose members keep their text.
///
/// Library gap: serde_json yields only the decoded key of a map entry, so the text of a key with escapes or a key that the file
/// wrote in another form is lost. A map type cannot hold this text either: `serde_json::Map` and `indexmap::IndexMap` keep one entry
/// per decoded key and merge duplicate keys, which the file keeps as separate members. The key span is therefore located here,
/// after serde_json has read the member list, and the span is accepted only when the value text that serde_json read follows it.
fn members_of(text: &str) -> Result<Members, String> {
    let Pairs(pairs) = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let bytes = text.as_bytes();
    let mut at = skip_whitespace(bytes, 0);
    if bytes.get(at) != Some(&b'{') {
        return Err("an object must start with {".to_string());
    }
    at += 1;
    let mut members = Vec::with_capacity(pairs.len());
    for (key, value) in pairs {
        at = skip_whitespace(bytes, at);
        if bytes.get(at) != Some(&b'"') {
            return Err(format!("the key {key} is not at the expected place"));
        }
        let end = string_end(bytes, at);
        let raw_key = text[at..end].to_string();
        at = skip_whitespace(bytes, end);
        if bytes.get(at) != Some(&b':') {
            return Err(format!("the key {key} has no colon"));
        }
        at = skip_whitespace(bytes, at + 1);
        if !text[at..].starts_with(value.get()) {
            return Err(format!("the value of {key} is not at the expected place"));
        }
        at += value.get().len();
        at = skip_whitespace(bytes, at);
        if bytes.get(at) == Some(&b',') {
            at += 1;
        }
        members.push(Member {
            raw_key,
            key,
            value,
        });
    }
    Ok(members)
}

/// The value of the first member with the key.
fn get<'a>(members: &'a Members, key: &str) -> Option<&'a RawValue> {
    members
        .iter()
        .find(|member| member.key == key)
        .map(|member| member.value.as_ref())
}

/// Sets the value of the first member with the key, or appends the member when there is none.
fn set(members: &mut Members, key: &str, value: Box<RawValue>) {
    match members.iter_mut().find(|member| member.key == key) {
        Some(member) => member.value = value,
        None => members.push(Member {
            raw_key: Value::String(key.to_string()).to_string(),
            key: key.to_string(),
            value,
        }),
    }
}

/// Removes the first member with the key.
fn remove(members: &mut Members, key: &str) {
    if let Some(at) = members.iter().position(|member| member.key == key) {
        members.remove(at);
    }
}

/// Parses an array whose items keep their text.
fn items_of(text: &str) -> Result<Vec<Box<RawValue>>, String> {
    serde_json::from_str(text).map_err(|error| error.to_string())
}

/// Wraps text that is valid JSON as the value of a member.
fn raw(text: String) -> Result<Box<RawValue>, String> {
    RawValue::from_string(text).map_err(|error| error.to_string())
}

/// Writes an object from its members, in their order, with the key text of each member.
fn object_text(members: &Members) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|member| format!("{}:{}", member.raw_key, member.value.get()))
        .collect();
    format!("{{{}}}", parts.join(","))
}

/// Writes an array from its items, in their order.
fn array_text(items: &[Box<RawValue>]) -> String {
    let parts: Vec<&str> = items.iter().map(|item| item.get()).collect();
    format!("[{}]", parts.join(","))
}

/// Writes a string as encoding/json.Marshal does: serde_json's form, with `<`, `>`, `&`, U+2028 and U+2029 escaped as
/// `<`, `>`, `&`, ` ` and ` `, which the Go twin escapes so that a command is read the same in HTML.
fn json_string(text: &str) -> String {
    Value::String(text.to_string())
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Parses a hook file into its members. The text must be one JSON object whose `hooks` member, when present, is an object whose
/// events are arrays.
fn hook_document(file: &Path, data: &[u8]) -> Result<Members, String> {
    if serde_json::from_slice::<Box<RawValue>>(data).is_err() {
        return Err(format!(
            "{}: hook file does not parse as JSON",
            file.display()
        ));
    }
    let text = std::str::from_utf8(data)
        .map_err(|_| format!("{}: hook file does not parse as JSON", file.display()))?;
    let root = members_of(text)
        .map_err(|_| format!("{}: hook file must hold a JSON object", file.display()))?;
    if let Some(hooks) = get(&root, "hooks") {
        let events = members_of(hooks.get())
            .map_err(|_| format!("{}: hooks must be an object", file.display()))?;
        for event in &events {
            items_of(event.value.get())
                .map_err(|_| format!("{}: hooks.{} must be an array", file.display(), event.key))?;
        }
    }
    Ok(root)
}

/// Reports whether a hook entry carries the mark of soksak: an object of type command whose command ends with the mark.
fn is_soksak_hook(hook: &str) -> bool {
    let Ok(fields) = members_of(hook) else {
        return false;
    };
    let kind =
        get(&fields, "type").and_then(|value| serde_json::from_str::<String>(value.get()).ok());
    let command =
        get(&fields, "command").and_then(|value| serde_json::from_str::<String>(value.get()).ok());
    kind.as_deref() == Some("command")
        && command.is_some_and(|command| command.ends_with(HOOK_MARK))
}

/// Removes the entries that soksak registered under every event. A group whose hooks the removal emptied is dropped, and so is an
/// event that the removal emptied and the `hooks` member that the removal emptied; every other member keeps its place and its text.
fn without_soksak_hooks(root: &mut Members) -> Result<(), String> {
    let Some(hooks) = get(root, "hooks") else {
        return Ok(());
    };
    let mut events = Members::new();
    let mut edited = false;
    for event in members_of(hooks.get())? {
        let shape = || {
            format!(
                "hooks.{} holds a group that is not an object with an array of hooks",
                event.key
            )
        };
        let groups = items_of(event.value.get())?;
        let mut kept: Vec<Box<RawValue>> = Vec::new();
        let mut changed = false;
        for group in groups {
            let mut members = members_of(group.get()).map_err(|_| shape())?;
            let Some(hook_list) = get(&members, "hooks") else {
                return Err(shape());
            };
            let hooks = items_of(hook_list.get()).map_err(|_| shape())?;
            if !hooks.iter().any(|hook| is_soksak_hook(hook.get())) {
                kept.push(group);
                continue;
            }
            changed = true;
            let keep: Vec<Box<RawValue>> = hooks
                .into_iter()
                .filter(|hook| !is_soksak_hook(hook.get()))
                .collect();
            if keep.is_empty() {
                continue;
            }
            set(&mut members, "hooks", raw(array_text(&keep))?);
            kept.push(raw(object_text(&members))?);
        }
        if !changed {
            events.push(event);
            continue;
        }
        edited = true;
        if !kept.is_empty() {
            set(&mut events, &event.key, raw(array_text(&kept))?);
        }
    }
    if edited && events.is_empty() {
        remove(root, "hooks");
    } else {
        set(root, "hooks", raw(object_text(&events))?);
    }
    Ok(())
}

/// Adds the group of the command to the SessionStart array, which is created when it is absent.
fn with_soksak_hook(root: &mut Members, command: &str) -> Result<(), String> {
    let group = format!(
        "{{\"matcher\":\"\",\"hooks\":[{{\"type\":\"command\",\"command\":{}}}]}}",
        json_string(command)
    );
    let mut events = match get(root, "hooks") {
        Some(hooks) => members_of(hooks.get())?,
        None => Members::new(),
    };
    let mut list = match get(&events, HOOK_EVENT) {
        Some(list) => items_of(list.get())?,
        None => Vec::new(),
    };
    list.push(raw(group)?);
    set(&mut events, HOOK_EVENT, raw(array_text(&list))?);
    set(root, "hooks", raw(object_text(&events))?);
    Ok(())
}

/// Indents a document in the two-space form with a final line feed, keeping the text of every string and number.
fn format_document(compact: &str) -> Result<Vec<u8>, String> {
    let mut text = jsonxf::pretty_print(compact)?;
    text.push('\n');
    Ok(text.into_bytes())
}

/// The event and command of each entry that soksak registered in the document. A group that is not in the shape of a group holds
/// no entry, as the setup check reads it.
fn soksak_hook_entries(root: &Members) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let Some(hooks) = get(root, "hooks") else {
        return entries;
    };
    let Ok(events) = members_of(hooks.get()) else {
        return entries;
    };
    for event in &events {
        let Ok(groups) = items_of(event.value.get()) else {
            continue;
        };
        for group in groups {
            let Ok(members) = members_of(group.get()) else {
                continue;
            };
            let Some(hook_list) = get(&members, "hooks") else {
                continue;
            };
            let Ok(hooks) = items_of(hook_list.get()) else {
                continue;
            };
            for hook in hooks {
                if !is_soksak_hook(hook.get()) {
                    continue;
                }
                let command = members_of(hook.get())
                    .ok()
                    .and_then(|fields| get(&fields, "command").map(|value| value.get().to_string()))
                    .and_then(|text| serde_json::from_str::<String>(&text).ok())
                    .unwrap_or_default();
                entries.push((event.key.clone(), command));
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
    let root = match hook_document(file, &data) {
        Ok(root) => root,
        Err(error) => {
            part.state = State::Error;
            part.reason = None;
            part.error = Some(error);
            return part;
        }
    };
    match soksak_hook_entries(&root).as_slice() {
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
    let mut root = hook_document(file, data)?;
    without_soksak_hooks(&mut root).map_err(|error| format!("{}: {error}", file.display()))?;
    with_soksak_hook(&mut root, command).map_err(|error| format!("{}: {error}", file.display()))?;
    format_document(&object_text(&root))
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
    let out = match hook_document(file, &data).and_then(|mut root| {
        without_soksak_hooks(&mut root).map_err(|error| format!("{}: {error}", file.display()))?;
        format_document(&object_text(&root))
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
