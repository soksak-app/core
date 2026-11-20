//! The role file of a tab (docs/spec/agent-roles.md#role-file). Stubs of the Red state: each function answers its empty value.

use std::collections::BTreeMap;
use std::path::PathBuf;

/// Returns the fingerprint of a role: the identifier and the definition text (docs/spec/agent-roles.md#role-file).
pub fn role_fingerprint(identifier: &str, text: &str) -> String {
    let _ = (identifier, text);
    String::new()
}

/// Returns the content of the role file of a role (docs/spec/agent-roles.md#role-file).
pub fn role_file_content(identifier: &str, text: &str) -> String {
    let _ = (identifier, text);
    String::new()
}

/// Returns the texts of the role file, the identity, the change message, the reread request and the first message suffix
/// for the role file at role_file (docs/spec/agent-roles.md#stable-identity).
pub fn role_texts(role_file: &str) -> BTreeMap<String, String> {
    let _ = role_file;
    BTreeMap::new()
}

/// Writes the role file of a surface atomically and returns its path.
pub fn write_role_file(
    config: &std::path::Path,
    surface: &str,
    identifier: &str,
    text: &str,
) -> Result<PathBuf, String> {
    let _ = (config, surface, identifier, text);
    Ok(PathBuf::new())
}
