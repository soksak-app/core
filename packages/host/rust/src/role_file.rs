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
/// The Korean translation of the first line, the first line of role.ko.md (texts_ko of the case file).
const ROLE_FILE_FIRST_LINE_KO: &str = "이 파일 전체를 읽는다. 이 파일이 정의하는 role을 따른다. 그다음 마지막 줄의 fingerprint로 확인한다: `sok role confirm <fingerprint>`를 실행하거나, 답에 `soksak role <fingerprint>`를 쓴다.";
const FIRST_MESSAGE_SUFFIX_TEXT: &str = "This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question.";
/// The heading of the files block of role.md, and its Korean translation in role.ko.md (texts and texts_ko of the case file).
const FILES_HEADING_TEXT: &str = "Files this role reads:";
const FILES_HEADING_KO_TEXT: &str = "이 role이 읽는 파일:";

/// The file name of the role file inside the folder of a surface.
const ROLE_FILE_NAME: &str = "role.md";
/// The file name of the Korean file of the role file.
const ROLE_KO_FILE_NAME: &str = "role.ko.md";
/// The prefix and suffix of the temporary files of the role file writer.
const ROLE_TEMP_PREFIX: &str = ".role-";
const ROLE_TEMP_SUFFIX: &str = ".tmp";

/// Returns the fingerprint of a role: the first 16 lowercase hexadecimal characters of the SHA-256 digest of the identifier, one
/// line feed, the definition text, one line feed, and the file list as a compact JSON array (docs/spec/agent-roles.md#role-file).
pub fn role_fingerprint(identifier: &str, text: &str, files: &[String]) -> String {
    let digest =
        Sha256::digest(format!("{identifier}\n{text}\n{}", file_list_json(files)).as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Returns the file list as a compact JSON array. Only the double quote, the backslash and the control characters below U+0020
/// are escaped, with the short forms \b \f \n \r \t and \u00XX in uppercase hexadecimal for the others; other characters stay
/// as UTF-8 (docs/spec/cases/agent-roles/fingerprint.json, algorithm).
fn file_list_json(files: &[String]) -> String {
    let mut list = String::from("[");
    for (index, file) in files.iter().enumerate() {
        if index > 0 {
            list.push(',');
        }
        list.push('"');
        for c in file.chars() {
            match c {
                '"' => list.push_str("\\\""),
                '\\' => list.push_str("\\\\"),
                '\u{8}' => list.push_str("\\b"),
                '\u{c}' => list.push_str("\\f"),
                '\n' => list.push_str("\\n"),
                '\r' => list.push_str("\\r"),
                '\t' => list.push_str("\\t"),
                c if (c as u32) < 0x20 => list.push_str(&format!("\\u{:04X}", c as u32)),
                c => list.push(c),
            }
        }
        list.push('"');
    }
    list.push(']');
    list
}

/// Returns the files block of a role file: the heading and one line `- <path>` per file, or nothing when the list is empty.
fn files_block(heading: &str, files: &[String]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut block = format!("{heading}\n");
    for file in files {
        block.push_str(&format!("- {file}\n"));
    }
    block
}

/// Returns the content of the role file of a role: the first line, the definition text with one line feed at its end when it
/// has none, the files block when the list is not empty, and the fingerprint on the last line, each line ending with one line
/// feed (docs/spec/agent-roles.md#role-file).
pub fn role_file_content(identifier: &str, text: &str, files: &[String]) -> String {
    let body = if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    };
    format!(
        "{ROLE_FILE_FIRST_LINE}\n{body}{}{}\n",
        files_block(FILES_HEADING_TEXT, files),
        role_fingerprint(identifier, text, files)
    )
}

/// Returns the content of role.ko.md: the Korean first line, the Korean text with one line feed at its end when it has none,
/// the files block with the Korean heading, and the fingerprint of role.md, which is computed over the English text
/// (docs/spec/agent-roles.md#role-file).
fn role_ko_file_content(identifier: &str, text: &str, ko: &str, files: &[String]) -> String {
    let body = if ko.ends_with('\n') {
        ko.to_string()
    } else {
        format!("{ko}\n")
    };
    format!(
        "{ROLE_FILE_FIRST_LINE_KO}\n{body}{}{}\n",
        files_block(FILES_HEADING_KO_TEXT, files),
        role_fingerprint(identifier, text, files)
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
        ("files_heading".to_string(), FILES_HEADING_TEXT.to_string()),
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

/// Writes the role file of a surface and its Korean file role.ko.md atomically and returns the path of the role file. The
/// folder of the surface is created with mode 0700. Leftover temporary files of earlier writes are removed before the write.
/// Each content goes to a temporary file of mode 0600; role.md is renamed first and role.ko.md second, so a reader sees the
/// earlier file or the new one whole.
pub fn write_role_file(
    config: &Path,
    surface: &str,
    identifier: &str,
    text: &str,
    ko: &str,
    files: &[String],
) -> Result<PathBuf, String> {
    let path = {
        let prepared = prepare_role_file(config, surface, identifier, text, ko, files)?;
        let path = prepared.path.clone();
        prepared.commit()?;
        path
    };
    Ok(path)
}

/// A write of the role files that holds both temporary files and persists them in its commit: step 1 of the ordered change of
/// a role, whose step 3 the commit is (docs/spec/agent-roles.md#tab-role-state). A failure of the commit renames no later
/// file, and the drop of a temporary file that was not persisted removes it.
pub struct PreparedRole {
    path: PathBuf,
    ko_path: PathBuf,
    file: tempfile::NamedTempFile,
    ko_file: tempfile::NamedTempFile,
}

/// Performs step 1 of the ordered change: it creates the folder of the surface, removes the leftover temporary files of
/// earlier writes, and writes both contents to temporary files of mode 0600. A failure is refused with `role file <path>:
/// write failed: <os error>` or the mode text of the spec, removes what it wrote, and stores nothing.
pub fn prepare_role_file(
    config: &Path,
    surface: &str,
    identifier: &str,
    text: &str,
    ko: &str,
    files: &[String],
) -> Result<PreparedRole, String> {
    check_surface(surface)?;
    let folder = config.join("agents").join(surface);
    platform::current()?
        .create_private_directories(&folder)
        .map_err(|e| write_failed(&folder, &e.to_string()))?;
    let entries = std::fs::read_dir(&folder).map_err(|e| write_failed(&folder, &e.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| write_failed(&folder, &e.to_string()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(ROLE_TEMP_PREFIX) && name.ends_with(ROLE_TEMP_SUFFIX) {
            std::fs::remove_file(entry.path())
                .map_err(|e| write_failed(&entry.path(), &e.to_string()))?;
        }
    }
    let path = folder.join(ROLE_FILE_NAME);
    let file = write_role_temporary(&folder, &path, &role_file_content(identifier, text, files))?;
    let ko_path = folder.join(ROLE_KO_FILE_NAME);
    // If the second write fails, dropping file removes the first temporary file.
    let ko_file = write_role_temporary(
        &folder,
        &ko_path,
        &role_ko_file_content(identifier, text, ko, files),
    )?;
    Ok(PreparedRole {
        path,
        ko_path,
        file,
        ko_file,
    })
}

impl PreparedRole {
    /// Performs step 3 of the ordered change: role.md is renamed first and role.ko.md second. A failed rename is refused
    /// with `role file <path>: rename failed: <os error>`, and the temporary files that were not persisted are removed.
    pub fn commit(self) -> Result<(), String> {
        let PreparedRole {
            path,
            ko_path,
            file,
            ko_file,
        } = self;
        file.persist(&path)
            .map_err(|e| rename_failed(&path, &e.error.to_string()))?;
        ko_file
            .persist(&ko_path)
            .map_err(|e| rename_failed(&ko_path, &e.error.to_string()))?;
        Ok(())
    }
}

/// States the refusal of a failed write step: `role file <path>: write failed: <os error>`.
fn write_failed(path: &Path, error: &str) -> String {
    format!("role file {}: write failed: {error}", path.display())
}

/// States the refusal of a failed rename of a role file: `role file <path>: rename failed: <os error>`.
fn rename_failed(path: &Path, error: &str) -> String {
    format!("role file {}: rename failed: {error}", path.display())
}

/// Writes content to a new temporary file in folder, syncs it and checks its mode 0600. A failure names path, the file that
/// the temporary file replaces, and removes the temporary file.
fn write_role_temporary(
    folder: &Path,
    path: &Path,
    content: &str,
) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::Builder::new()
        .prefix(ROLE_TEMP_PREFIX)
        .suffix(ROLE_TEMP_SUFFIX)
        .tempfile_in(folder)
        .map_err(|e| write_failed(path, &e.to_string()))?;
    let temporary = file.path().to_path_buf();
    let written = (|| -> Result<(), String> {
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        let mode = file.as_file().metadata().map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        let mode = mode.permissions().mode() & 0o777;
        if mode != 0o600 {
            return Err(format!(
                "role file {}: mode {mode:o} is not 0600",
                path.display()
            ));
        }
        Ok(())
    })();
    if let Err(e) = written {
        return Err(match file.close() {
            Ok(()) => write_failed(path, &e),
            Err(remove) => format!(
                "{}; removing {}: {remove}",
                write_failed(path, &e),
                temporary.display()
            ),
        });
    }
    Ok(file)
}
