//! The role definitions of roles.json in the configuration directory (docs/spec/agent-roles.md#role-definitions).
//!
//! The reader and the writer check the whole file before they answer or store it, and each refusal names the file.

use std::fs;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::workspace::write;

/// The format of roles.json, the role definitions of the agent roles (docs/spec/agent-roles.md#role-definitions).
pub(crate) const ROLES_FORMAT: u64 = 3;

/// Returns the role definitions of roles.json at path, or an empty object when the file does not exist. The file is not
/// created by a read.
pub(crate) fn read_roles(path: &Path) -> Result<Value, String> {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let value: Value =
        serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    check_roles(path, &value)?;
    Ok(value["roles"].clone())
}

/// Writes the role definitions of roles to roles.json at path after the check that the reader makes. A refused definition
/// writes nothing, and the result is the written role definitions.
pub(crate) fn write_roles(path: &Path, roles: Option<Map<String, Value>>) -> Result<Value, String> {
    let roles =
        roles.ok_or_else(|| format!("{}: roles: roles must be an object", path.display()))?;
    let document = json!({"format": ROLES_FORMAT, "roles": roles});
    check_roles(path, &document)?;
    write(path, &document).map_err(|e| format!("{}: roles: write failed: {e}", path.display()))?;
    Ok(document["roles"].clone())
}

/// Checks a decoded roles.json document. Each refusal names the file. The members are checked in a fixed order: the format,
/// the unknown top-level members, the roles object, then each role in identifier order, whose definition is checked by
/// check_definition and then whose file paths are checked in list order.
fn check_roles(path: &Path, value: &Value) -> Result<(), String> {
    // default: the refusal names an absent format member as null, as docs/spec/agent-roles.md#role-definitions defines.
    let format = value.get("format").unwrap_or(&Value::Null);
    if format.as_u64() != Some(ROLES_FORMAT) {
        return Err(format!(
            "{}: roles: format must be {ROLES_FORMAT}, found {format}",
            path.display()
        ));
    }
    // default: a value whose format member is a number is an object, so the lookup above found the member in an object.
    let document = value
        .as_object()
        .ok_or_else(|| format!("{}: roles: roles must be an object", path.display()))?;
    if let Some(field) = document
        .keys()
        .find(|key| *key != "format" && *key != "roles")
    {
        return Err(format!("{}: roles: unknown field {field}", path.display()));
    }
    let roles = document
        .get("roles")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{}: roles: roles must be an object", path.display()))?;
    for (id, definition) in roles {
        if !is_role_identifier(id) {
            return Err(format!(
                "{}: roles: invalid role identifier {id}",
                path.display()
            ));
        }
        let files = check_definition(id, definition)
            .map_err(|e| format!("{}: roles: {e}", path.display()))?;
        for file in &files {
            if let Some(fault) = path_fault(file) {
                return Err(format!(
                    "{}: roles: role {id} file {file} {}",
                    path.display(),
                    fault.reason()
                ));
            }
        }
    }
    Ok(())
}

/// Checks the members of the definition of role id in the order text, ko, files and then the unknown members, and returns its
/// file list. The refusal text names the role but not the file; the caller adds the file it names.
pub(crate) fn check_definition(id: &str, definition: &Value) -> Result<Vec<String>, String> {
    let members = definition
        .as_object()
        .ok_or_else(|| format!("role {id} must be an object"))?;
    if members.get("text").and_then(Value::as_str).is_none() {
        return Err(format!("role {id} text must be a string"));
    }
    if members.get("ko").and_then(Value::as_str).is_none() {
        return Err(format!("role {id} ko must be a string"));
    }
    let files = definition_files(definition)
        .ok_or_else(|| format!("role {id} files must be an array of strings"))?;
    if let Some(field) = members
        .keys()
        .find(|key| *key != "text" && *key != "ko" && *key != "files")
    {
        return Err(format!("role {id} unknown field {field}"));
    }
    Ok(files)
}

/// Returns the file list of a definition, or None when the member files is absent or holds a value that is not a string.
pub(crate) fn definition_files(definition: &Value) -> Option<Vec<String>> {
    definition
        .get("files")?
        .as_array()?
        .iter()
        .map(|file| file.as_str().map(str::to_string))
        .collect()
}

/// A fault of a file path of a role definition: the path is relative, or it holds a control character.
pub(crate) enum PathFault {
    NotAbsolute,
    ControlCharacter,
}

impl PathFault {
    /// Returns the words that state the fault after the path.
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            PathFault::NotAbsolute => "is not absolute",
            PathFault::ControlCharacter => "holds a control character",
        }
    }
}

/// Returns the fault of a file path of a definition, checked in the order of docs/spec/agent-roles.md#role-definitions.
pub(crate) fn path_fault(file: &str) -> Option<PathFault> {
    if !Path::new(file).is_absolute() {
        Some(PathFault::NotAbsolute)
    } else if file.chars().any(char::is_control) {
        Some(PathFault::ControlCharacter)
    } else {
        None
    }
}

/// Reports whether id matches the identifier rule of a role: a lowercase letter, then lowercase letters, digits and
/// hyphens, at most 64 characters in all.
pub(crate) fn is_role_identifier(id: &str) -> bool {
    let mut characters = id.chars();
    let starts = characters.next().is_some_and(|c| c.is_ascii_lowercase());
    starts
        && id.len() <= 64
        && characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
