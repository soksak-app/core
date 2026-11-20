//! The role definitions of roles.json in the configuration directory (docs/spec/agent-roles.md#role-definitions).
//!
//! The reader and the writer check the whole file before they answer or store it, and each refusal names the file.

use std::fs;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::workspace::write;

/// The format of roles.json, the role definitions of the agent roles (docs/spec/agent-roles.md#role-definitions).
pub(crate) const ROLES_FORMAT: u64 = 2;

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
    write(path, &document)?;
    Ok(document["roles"].clone())
}

/// Checks a decoded roles.json document. Each refusal names the file. The members are checked in a fixed order: the format,
/// the unknown members, the roles object, then each role in identifier order, whose members are checked as the unknown
/// members, text, then ko.
fn check_roles(path: &Path, value: &Value) -> Result<(), String> {
    // default: the refusal names an absent format member as null, as docs/spec/agent-roles.md#role-definitions defines.
    let format = value.get("format").unwrap_or(&Value::Null);
    if format.as_f64() != Some(ROLES_FORMAT as f64) {
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
        let definition = definition
            .as_object()
            .ok_or_else(|| format!("{}: roles: role {id} must be an object", path.display()))?;
        if let Some(field) = definition.keys().find(|key| *key != "text" && *key != "ko") {
            return Err(format!(
                "{}: roles: role {id} unknown field {field}",
                path.display()
            ));
        }
        if definition.get("text").and_then(Value::as_str).is_none() {
            return Err(format!(
                "{}: roles: role {id} text must be a string",
                path.display()
            ));
        }
        if definition.get("ko").and_then(Value::as_str).is_none() {
            return Err(format!(
                "{}: roles: role {id} ko must be a string",
                path.display()
            ));
        }
    }
    Ok(())
}

/// Reports whether id matches the identifier rule of a role: a lowercase letter, then lowercase letters, digits and
/// hyphens, at most 64 characters in all.
fn is_role_identifier(id: &str) -> bool {
    let mut characters = id.chars();
    let starts = characters.next().is_some_and(|c| c.is_ascii_lowercase());
    starts
        && id.len() <= 64
        && characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
