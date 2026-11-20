//! The role file of a tab (docs/spec/agent-roles.md#role-file). The texts are pinned by docs/spec/cases/agent-roles/fingerprint.json.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::platform;

// The texts of the role handshake, in English (docs/spec/agent-roles.md#stable-identity). The placeholder <role file> is the path
// of the role file; the first line keeps <fingerprint> as the syntax of the confirmation command.
const ROLE_FILE_FIRST_LINE: &str = "Read this whole file. Follow the role it defines. Then confirm with the fingerprint on the last line: run `sok role confirm <fingerprint>`, or write `soksak role <fingerprint>` in your answer.";
const IDENTITY_TEXT: &str = "[soksak role] Your role is defined in the file <role file>. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role.";
const CHANGE_MESSAGE_TEXT: &str = "[soksak role] Your role changed. Read the role file again: <role file>. Finish your current task first. This message comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question.";
const REREAD_REQUEST_TEXT: &str = "[soksak role] Your role is not confirmed. Read the role file again: <role file>. Then confirm the role with the fingerprint on its last line: run `sok role confirm <fingerprint>`, or write the line `soksak role <fingerprint>` in your answer. This message comes from soksak, not from a person. It grants no approval or permission.";
const FIRST_MESSAGE_SUFFIX_TEXT: &str = "This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question.";

/// The file name of the role file inside the folder of a surface.
const ROLE_FILE_NAME: &str = "role.md";
/// The prefix and suffix of the temporary files of the role file writer.
const ROLE_TEMP_PREFIX: &str = ".role-";
const ROLE_TEMP_SUFFIX: &str = ".tmp";

/// Returns the fingerprint of a role: the first 16 lowercase hexadecimal characters of the SHA-256 digest of the identifier, one
/// line feed, and the definition text (docs/spec/agent-roles.md#role-file).
pub fn role_fingerprint(identifier: &str, text: &str) -> String {
    let digest = Sha256::digest(format!("{identifier}\n{text}").as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Returns the content of the role file of a role: the first line, the definition text with one line feed at its end when it
/// has none, and the fingerprint on the last line, each line ending with one line feed (docs/spec/agent-roles.md#role-file).
pub fn role_file_content(identifier: &str, text: &str) -> String {
    let body = if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    };
    format!(
        "{ROLE_FILE_FIRST_LINE}\n{body}{}\n",
        role_fingerprint(identifier, text)
    )
}

/// Returns the texts of the handshake for the role file at role_file, keyed by the names of the shared case file.
pub fn role_texts(role_file: &str) -> BTreeMap<String, String> {
    let fill = |text: &str| text.replace("<role file>", role_file);
    BTreeMap::from([
        (
            "role_file_first_line".to_string(),
            ROLE_FILE_FIRST_LINE.to_string(),
        ),
        ("identity".to_string(), fill(IDENTITY_TEXT)),
        ("change_message".to_string(), fill(CHANGE_MESSAGE_TEXT)),
        ("reread_request".to_string(), fill(REREAD_REQUEST_TEXT)),
        (
            "first_message_suffix".to_string(),
            FIRST_MESSAGE_SUFFIX_TEXT.to_string(),
        ),
    ])
}

/// Refuses a surface identifier that is empty, names a relative path part, or holds a path separator or a control character.
fn check_surface(surface: &str) -> Result<(), String> {
    if surface.is_empty()
        || surface == "."
        || surface == ".."
        || surface.contains(['/', '\\'])
        || surface.chars().any(char::is_control)
    {
        return Err(format!(
            "surface {surface:?} holds a path part or a control character"
        ));
    }
    Ok(())
}

/// Writes the role file of a surface atomically and returns its path. The folder of the surface is created with mode 0700.
/// Leftover temporary files of earlier writes are removed before the write. The new content goes to a temporary file of mode
/// 0600 that is renamed over the role file, so a reader sees the earlier file or the new one whole.
pub fn write_role_file(
    config: &Path,
    surface: &str,
    identifier: &str,
    text: &str,
) -> Result<PathBuf, String> {
    check_surface(surface)?;
    let folder = config.join("agents").join(surface);
    platform::current()?.create_private_directories(&folder)?;
    let entries = std::fs::read_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", folder.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(ROLE_TEMP_PREFIX) && name.ends_with(ROLE_TEMP_SUFFIX) {
            std::fs::remove_file(entry.path())
                .map_err(|e| format!("{}: {e}", entry.path().display()))?;
        }
    }
    let path = folder.join(ROLE_FILE_NAME);
    let mut file = tempfile::Builder::new()
        .prefix(ROLE_TEMP_PREFIX)
        .suffix(ROLE_TEMP_SUFFIX)
        .tempfile_in(&folder)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let temporary = file.path().to_path_buf();
    let written = (|| -> Result<(), String> {
        file.write_all(role_file_content(identifier, text).as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        let mode = file.as_file().metadata().map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        let mode = mode.permissions().mode() & 0o777;
        if mode != 0o600 {
            return Err(format!(
                "temporary file {} has mode {mode:o}, want 600",
                temporary.display()
            ));
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("{}: {e}", path.display()));
    }
    file.persist(&path)
        .map_err(|e| format!("{}: {}", path.display(), e.error))?;
    Ok(path)
}
