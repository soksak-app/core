//! The skill files of the agent folders (docs/spec/cli.md#agent-skill).

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agents::SKILL;
use crate::files;
use crate::files::file_error;
use crate::setup::{Environment, Reason};

/// The agent folders in their order: `<home>/.claude`, `$CLAUDE_CONFIG_DIR` when it is set and not empty, and `<home>/.agents`.
fn agent_folders(environment: &Environment) -> Result<Vec<PathBuf>, String> {
    let home = Path::new(environment.home()?);
    let mut folders = vec![home.join(".claude")];
    if let Some(folder) = environment.claude_config_dir() {
        folders.push(PathBuf::from(folder));
    }
    folders.push(home.join(".agents"));
    Ok(folders)
}

/// Whether the folder is a directory after symbolic links are followed; a missing folder is an agent that the person does not run.
fn is_directory(folder: &Path) -> Result<bool, String> {
    match std::fs::metadata(folder) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            Ok(false)
        }
        Err(error) => Err(file_error(folder.display(), &error)),
    }
}

/// The canonical form of a path whose last components may not exist yet: the canonical path of its deepest existing folder
/// followed by the remaining names.
fn canonical(path: &Path) -> Result<PathBuf, String> {
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            match (path.parent(), path.file_name()) {
                (Some(parent), Some(name)) => Ok(canonical(parent)?.join(name)),
                _ => Err(file_error(path.display(), &error)),
            }
        }
        Err(error) => Err(file_error(path.display(), &error)),
    }
}

/// The skill file of each agent folder that exists; agent folders whose skill folders resolve to one folder have one file, listed
/// at its first place.
pub fn skill_files(environment: &Environment) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut seen = Vec::new();
    for folder in agent_folders(environment)? {
        if !is_directory(&folder)? {
            continue;
        }
        let skill_folder = folder.join("skills").join("soksak");
        let resolved = canonical(&skill_folder)?;
        if seen.contains(&resolved) {
            continue;
        }
        seen.push(resolved);
        files.push(skill_folder.join("SKILL.md"));
    }
    Ok(files)
}

/// Whether the skill file is current: None when its bytes equal the skill text, else why it is missing.
pub fn skill_state(file: &Path) -> Result<Option<Reason>, String> {
    match std::fs::read(file) {
        Ok(bytes) if bytes == SKILL.as_bytes() => Ok(None),
        Ok(_) => Ok(Some(Reason::Differs)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Some(Reason::Absent)),
        Err(error) => Err(file_error(file.display(), &error)),
    }
}

/// What a write did to a skill file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillState {
    Written,
    Current,
}

/// One skill file of `sok skill install`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SkillFile {
    pub file: String,
    pub state: SkillState,
}

/// A skill file or folder that could not be written, with the reason of the operating system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillFailure {
    pub file: PathBuf,
    /// The reason text of the operating system, followed by a failed cleanup of the temporary file.
    pub reason: String,
}

impl std::fmt::Display for SkillFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.file.display(), self.reason)
    }
}

impl SkillFailure {
    fn new(file: &Path, error: &std::io::Error) -> SkillFailure {
        SkillFailure {
            file: file.to_path_buf(),
            reason: files::os_reason(error),
        }
    }
}

/// Creates the folders `skills` and `skills/soksak` of the skill file at mode 0755 when they are missing.
fn create_folders(file: &Path) -> Result<(), SkillFailure> {
    // default: a skill file path always has the folders skills/soksak (skill_files).
    let Some(soksak) = file.parent() else {
        return Ok(());
    };
    for folder in [soksak.parent(), Some(soksak)].into_iter().flatten() {
        match std::fs::create_dir(folder) {
            Ok(()) => set_mode(folder, true)?,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(SkillFailure::new(folder, &error)),
        }
    }
    Ok(())
}

/// Sets the mode 0755 of a folder or 0644 of a file through the platform, whose error names the path.
fn set_mode(path: &Path, folder: bool) -> Result<(), SkillFailure> {
    let failure = |text: String| {
        let prefix = format!("{}: ", path.display());
        SkillFailure {
            file: path.to_path_buf(),
            // default: a reason that does not start with the path is kept whole.
            reason: text.strip_prefix(&prefix).unwrap_or(&text).to_string(),
        }
    };
    crate::platform::current()
        .map_err(failure)?
        .set_executable(path, folder)
        .map_err(failure)
}

/// Removes the temporary file of a failed write and appends a failed removal to the reason.
fn discard(temp: tempfile::NamedTempFile, mut failure: SkillFailure) -> SkillFailure {
    let (file, path) = temp.into_parts();
    drop(file);
    let removed = match path.keep() {
        Ok(path) => std::fs::remove_file(&path).map_err(|error| (path, error)),
        Err(error) => Err((error.path.to_path_buf(), error.error)),
    };
    if let Err((path, error)) = removed
        && error.kind() != ErrorKind::NotFound
    {
        failure.reason = format!(
            "{}; cleanup {}",
            failure.reason,
            file_error(path.display(), &error)
        );
    }
    failure
}

/// Writes the skill text to the file unless the file is current: through a temporary file `.SKILL.md.*` of the same folder,
/// renamed over the file at mode 0644, so a reader never reads a partial skill. A failure names the skill file and removes the
/// temporary file. The temporary file is opened by this function, because the errors of the tempfile functions add the path to the
/// text of the operating system error.
pub fn write_skill_file(file: &Path) -> Result<SkillState, SkillFailure> {
    match std::fs::read(file) {
        Ok(bytes) if bytes == SKILL.as_bytes() => return Ok(SkillState::Current),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(SkillFailure::new(file, &error)),
    }
    // default: a skill file path always has a folder (skill_files).
    let folder = file.parent().unwrap_or(Path::new("."));
    let mut temp = tempfile::Builder::new()
        .prefix(".SKILL.md.")
        .make_in(folder, |path| std::fs::File::create_new(path))
        .map_err(|error| SkillFailure::new(file, &error))?;
    let written = temp
        .as_file_mut()
        .write_all(SKILL.as_bytes())
        .and_then(|()| temp.as_file_mut().sync_all())
        .map_err(|error| SkillFailure::new(file, &error))
        .and_then(|()| {
            set_mode(temp.path(), false).map_err(|failure| SkillFailure {
                file: file.to_path_buf(),
                reason: failure.reason,
            })
        });
    if let Err(failure) = written {
        return Err(discard(temp, failure));
    }
    if let Err(error) = temp.persist(file) {
        let failure = SkillFailure::new(file, &error.error);
        return Err(discard(error.file, failure));
    }
    Ok(SkillState::Written)
}

/// The text of a skill install without an agent folder, which names each agent folder.
fn no_agent_folder(environment: &Environment) -> Result<String, String> {
    let folders: Vec<String> = agent_folders(environment)?
        .iter()
        .map(|folder| folder.display().to_string())
        .collect();
    Ok(format!(
        "no agent folder: neither {} is a directory; sok skill print writes the skill to standard output",
        folders.join(" nor ")
    ))
}

/// Creates the missing skill folders of every skill file before it writes a file, because an agent follows changes of its skills
/// folder only when that folder existed at the start of its session, then writes each skill file whose folders exist. A skill file
/// that it cannot write does not stop the others: it returns the files that it wrote or found current and the failures, each
/// named by its skill file, in the order of the agent folders.
fn write_skill_files(files: Vec<PathBuf>) -> (Vec<SkillFile>, Vec<SkillFailure>) {
    let failed: Vec<Option<SkillFailure>> = files
        .iter()
        .map(|file| {
            create_folders(file).err().map(|failure| SkillFailure {
                file: file.clone(),
                reason: failure.reason,
            })
        })
        .collect();
    let mut done = Vec::new();
    let mut failures = Vec::new();
    for (file, failed) in files.into_iter().zip(failed) {
        if let Some(failure) = failed {
            failures.push(failure);
            continue;
        }
        match write_skill_file(&file) {
            Ok(state) => done.push(SkillFile {
                file: file.display().to_string(),
                state,
            }),
            Err(failure) => failures.push(failure),
        }
    }
    (done, failures)
}

/// The text of skill failures: each `<file>: <reason>`, joined by `; `.
pub fn failures_text(failures: &[SkillFailure]) -> String {
    failures
        .iter()
        .map(SkillFailure::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

/// `sok skill install` and the skill part of `sok setup install`: writes the skill file of each agent folder that exists and
/// returns the files that it wrote or found current with the files that it could not write. It fails before any write when `HOME`
/// is not set, an agent folder cannot be read, or no agent folder exists.
pub fn install_skill_files(
    environment: &Environment,
) -> Result<(Vec<SkillFile>, Vec<SkillFailure>), String> {
    let files = skill_files(environment)?;
    if files.is_empty() {
        return Err(no_agent_folder(environment)?);
    }
    Ok(write_skill_files(files))
}

/// Brings the skill current at the start of `sok mcp` and of the host: writes each skill file of an existing agent folder that
/// differs or is missing, and returns every failure, each with its skill file and the reason. Without an agent folder it writes
/// nothing. It fails only when `HOME` is not set or an agent folder cannot be read.
pub fn bring_skill_current(environment: &Environment) -> Result<Vec<SkillFailure>, String> {
    let (_, failures) = write_skill_files(skill_files(environment)?);
    Ok(failures)
}
