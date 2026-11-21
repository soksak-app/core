//! Reconciles the user-owned PATH registration of the login shell (docs/spec/cli.md#user-path-registration).

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions, Permissions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::{NamedTempFile, TempDir};

use super::Darwin;
use crate::files::file_error;
use crate::platform::Platform;
use crate::registration::{find_on_path, registered_sok};
use crate::setup::{Environment, Part, Reason, State, require_writable_volume};

const START: &str = "# >>> soksak PATH >>>";
const END: &str = "# <<< soksak PATH <<<";
const POSIX: &str = "case \":${PATH-}:\" in\n  *\":$HOME/.local/bin:\"*) ;;\n  *) export PATH=\"${PATH:+$PATH:}$HOME/.local/bin\" ;;\nesac\n";
const FISH: &str = "fish_add_path --path --append \"$HOME/.local/bin\"\n";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    format: u32,
    path: Preference,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    enabled: bool,
    profiles: Vec<PathBuf>,
}

impl Registration {
    fn read(file: &Path) -> Result<(Self, bool), String> {
        let Some(data) = regular(file)? else {
            return Ok((
                Self {
                    format: 1,
                    path: Preference {
                        enabled: true,
                        profiles: Vec::new(),
                    },
                },
                false,
            ));
        };
        let invalid = || {
            let found = String::from_utf8_lossy(&data.bytes[..data.bytes.len().min(256)]);
            format!(
                "{}: expected user PATH registration format 1, found {found}",
                file.display()
            )
        };
        let record: Self = serde_json::from_slice(&data.bytes).map_err(|_| invalid())?;
        if record.format != 1 {
            return Err(invalid());
        }
        let mut profiles = BTreeSet::new();
        if record.path.profiles.iter().any(|profile| {
            !profile.is_absolute() || !is_profile(profile) || !profiles.insert(profile)
        }) {
            return Err(invalid());
        }
        Ok((record, true))
    }

    fn write(&self, file: &Path) -> Result<(), String> {
        let mut bytes =
            serde_json::to_vec(self).map_err(|error| format!("{}: {error}", file.display()))?;
        bytes.push(b'\n');
        write_file(file, &bytes, Permissions::from_mode(0o600))
    }
}

struct Paths {
    home: PathBuf,
    public: PathBuf,
    private: PathBuf,
    settings: PathBuf,
}

impl Paths {
    fn new(environment: &Environment) -> Result<Self, String> {
        let home = PathBuf::from(environment.home()?);
        if !home.is_absolute() {
            return Err(format!("HOME is not an absolute path: {}", home.display()));
        }
        Ok(Self {
            public: home.join(".local/bin/sok"),
            private: home.join(".local/share/soksak/sok"),
            settings: home.join("Library/Application Support/app.soksak/agent-setup.json"),
            home,
        })
    }
}

fn conflict(path: &Path) -> String {
    format!(
        "{}: conflicts with soksak PATH registration",
        path.display()
    )
}

fn parent(path: &Path) -> Result<&Path, String> {
    path.parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))
}

fn directory(path: &Path) -> Result<(), String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|error| file_error(path.display(), &error))
}

struct File {
    bytes: Vec<u8>,
    mode: Permissions,
}

fn regular(path: &Path) -> Result<Option<File>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            let bytes = fs::read(path).map_err(|error| file_error(path.display(), &error))?;
            Ok(Some(File {
                bytes,
                mode: metadata.permissions(),
            }))
        }
        Ok(_) => Err(conflict(path)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(file_error(path.display(), &error)),
    }
}

fn write_file(path: &Path, data: &[u8], mode: Permissions) -> Result<(), String> {
    let error = |error: &std::io::Error| file_error(path.display(), error);
    let mut file = NamedTempFile::new_in(parent(path)?).map_err(|failure| error(&failure))?;
    let result = file
        .as_file()
        .set_permissions(mode)
        .and_then(|()| file.write_all(data))
        .and_then(|()| file.as_file().sync_all());
    if let Err(failure) = result {
        return Err(cleanup(error(&failure), file));
    }
    match file.persist(path) {
        Ok(file) => Darwin.close_file(file, path),
        Err(failure) => Err(cleanup(error(&failure.error), failure.file)),
    }
}

fn cleanup(error: String, file: NamedTempFile) -> String {
    let path = file.path().to_path_buf();
    match file.close() {
        Ok(()) => error,
        Err(failure) => format!("{error}; cleanup {}", file_error(path.display(), &failure)),
    }
}

enum Link {
    Missing,
    Target(PathBuf),
    Other,
}

fn link(path: &Path) -> Result<Link, String> {
    match fs::read_link(path) {
        Ok(target) => Ok(Link::Target(target)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Link::Missing),
        // An existing entry that readlink returns EINVAL for is not a symlink.
        Err(error) if error.kind() == ErrorKind::InvalidInput => Ok(Link::Other),
        Err(error) => Err(file_error(path.display(), &error)),
    }
}

fn is_sok(path: &Path) -> Result<bool, String> {
    Ok(path.is_absolute()
        && path.file_name().is_some_and(|name| name == "sok")
        && Darwin.registrable_sok(path)?)
}

fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(file_error(path.display(), &error)),
    }
}

fn is_profile(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(
            ".zshrc"
                | ".bash_profile"
                | ".bash_login"
                | ".profile"
                | ".bashrc"
                | "soksak-path.fish"
        )
    )
}

fn profile_payload(path: &Path) -> &'static str {
    if path
        .file_name()
        .is_some_and(|name| name == "soksak-path.fish")
    {
        FISH
    } else {
        POSIX
    }
}

fn owned_block(path: &Path, text: &[u8]) -> Result<Option<std::ops::Range<usize>>, String> {
    use memchr::memmem::{find, find_iter};
    let modified = || format!("{}: contains a modified soksak PATH block", path.display());
    let Some(start) = find(text, START.as_bytes()) else {
        return if find(text, END.as_bytes()).is_none() {
            Ok(None)
        } else {
            Err(modified())
        };
    };
    if find_iter(text, START).count() != 1 || find_iter(text, END).count() != 1 {
        return Err(modified());
    }
    let block_start = match start {
        0 => 0,
        _ if text[start - 1] == b'\n' => start - 1,
        _ => return Err(modified()),
    };
    let block = format!("{START}\n{}{END}\n", profile_payload(path));
    if text[start..].starts_with(block.as_bytes()) {
        return Ok(Some(block_start..start + block.len()));
    }
    Err(modified())
}

fn insert_block(path: &Path) -> Result<bool, String> {
    let existing = regular(path)?;
    let mut bytes = Vec::new();
    let mut mode = Permissions::from_mode(0o600);
    if let Some(file) = existing {
        if owned_block(path, &file.bytes)?.is_some() {
            return Ok(false);
        }
        bytes = file.bytes;
        mode = file.mode;
        bytes.push(b'\n');
    } else {
        directory(parent(path)?)?;
    }
    bytes.extend_from_slice(format!("{START}\n{}{END}\n", profile_payload(path)).as_bytes());
    write_file(path, &bytes, mode)?;
    Ok(true)
}

fn remove_block(path: &Path) -> Result<bool, String> {
    let Some(mut file) = regular(path)? else {
        return Ok(false);
    };
    let Some(mut block) = owned_block(path, &file.bytes)? else {
        return Ok(false);
    };
    if block.start == 0 && block.end == file.bytes.len() && file.bytes.starts_with(START.as_bytes())
    {
        remove(path)?;
    } else {
        // The separator that the block added is still needed if the user since appended another line.
        if block.start > 0
            && block.end < file.bytes.len()
            && file.bytes[block.start - 1] != b'\n'
            && file.bytes[block.end] != b'\n'
        {
            block.start += 1;
        }
        drop(file.bytes.drain(block));
        write_file(path, &file.bytes, file.mode)?;
    }
    Ok(true)
}

fn profiles(environment: &Environment, home: &Path, shell: &str) -> Result<Vec<PathBuf>, String> {
    let configured_folder = |variable: &str, default: &Path| -> Result<PathBuf, String> {
        let value = environment
            .variables
            .get(variable)
            .filter(|value| !value.is_empty());
        let path = value.map_or_else(|| default.to_path_buf(), PathBuf::from);
        if !path.is_absolute() {
            return Err(format!(
                "{variable} is not an absolute path: {}",
                path.display()
            ));
        }
        Ok(path)
    };
    match Path::new(shell).file_name().and_then(|part| part.to_str()) {
        Some("zsh") => Ok(vec![configured_folder("ZDOTDIR", home)?.join(".zshrc")]),
        Some("bash") => {
            let mut login = home.join(".bash_profile");
            for name in [".bash_profile", ".bash_login", ".profile"] {
                let path = home.join(name);
                match fs::symlink_metadata(&path) {
                    Ok(_) => {
                        login = path;
                        break;
                    }
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => return Err(file_error(path.display(), &error)),
                }
            }
            Ok(vec![login, home.join(".bashrc")])
        }
        Some("fish") => {
            let directory = environment
                .variables
                .get("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                // default: a relative XDG_CONFIG_HOME does not specify an XDG configuration folder.
                .unwrap_or_else(|| home.join(".config"));
            Ok(vec![directory.join("fish/conf.d/soksak-path.fish")])
        }
        _ => Err(format!(
            "the login shell {shell} does not support soksak PATH registration"
        )),
    }
}

pub(super) fn state(environment: &Environment) -> Result<Part, String> {
    let paths = Paths::new(environment)?;
    let (record, _) = Registration::read(&paths.settings)?;
    let mut part = Part {
        part: "path",
        file: paths.public.display().to_string(),
        state: State::Ok,
        step: String::new(),
        reason: None,
        error: None,
        changed: None,
        enabled: Some(record.path.enabled),
    };
    if record.path.enabled {
        match path_command(environment) {
            Ok(Some(path)) => part.file = path.display().to_string(),
            Ok(None) => {
                part.state = State::Missing;
                part.reason = Some(Reason::Absent);
            }
            Err(error) => {
                part.state = State::Error;
                part.error = Some(error);
            }
        }
    } else {
        match registration_remains(&paths, &record.path.profiles) {
            Ok(false) => {}
            Ok(true) => {
                part.state = State::Missing;
                part.reason = Some(Reason::Differs);
            }
            Err(error) => {
                part.state = State::Error;
                part.error = Some(error);
            }
        }
    }
    Ok(part)
}

fn path_command(environment: &Environment) -> Result<Option<PathBuf>, String> {
    let command = find_on_path(environment, "sok")?;
    if let Some(path) = &command
        && !is_sok(path)?
    {
        return Err(conflict(path));
    }
    Ok(command)
}

fn registration_remains(paths: &Paths, profiles: &[PathBuf]) -> Result<bool, String> {
    match link(&paths.public)? {
        Link::Target(target) if target == paths.private => return Ok(true),
        Link::Missing => match link(&paths.private)? {
            Link::Target(target) if is_sok(&target)? => return Ok(true),
            Link::Missing => {}
            _ => return Err(conflict(&paths.private)),
        },
        _ => {}
    }
    for file in profiles {
        if let Some(existing) = regular(file)?
            && owned_block(file, &existing.bytes)?.is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn disable(paths: &Paths, record: &mut Registration) -> Result<bool, String> {
    let mut changed = false;
    let mut failures = Vec::new();
    let links = (|| {
        let public = link(&paths.public)?;
        let owned = matches!(&public, Link::Target(target) if target == &paths.private);
        if owned {
            remove(&paths.public)?;
            changed = true;
        }
        if owned || matches!(public, Link::Missing) {
            match link(&paths.private)? {
                Link::Target(target) if is_sok(&target)? => {
                    remove(&paths.private)?;
                    changed = true;
                }
                Link::Missing => {}
                _ => return Err(conflict(&paths.private)),
            }
        }
        Ok(())
    })();
    if let Err(error) = links {
        failures.push(error);
    }
    let mut retained = Vec::new();
    for file in &record.path.profiles {
        match remove_block(file) {
            Ok(edited) => changed |= edited,
            Err(error) => {
                failures.push(error);
                retained.push(file.clone());
            }
        }
    }
    if retained != record.path.profiles {
        record.path.profiles = retained;
        match record.write(&paths.settings) {
            Ok(()) => changed = true,
            Err(error) => failures.push(error),
        }
    }
    if failures.is_empty() {
        Ok(changed)
    } else {
        Err(failures.join("\n"))
    }
}

fn enable(
    paths: &Paths,
    record: &mut Registration,
    environment: &Environment,
    shell: &str,
    executable: &Path,
) -> Result<bool, String> {
    if path_command(environment)?.is_some() {
        return Ok(false);
    }

    let public_missing = match link(&paths.public)? {
        Link::Missing => true,
        Link::Target(target) if target == paths.private => false,
        _ => return Err(conflict(&paths.public)),
    };
    let private = link(&paths.private)?;
    let target_is_ready = match &private {
        Link::Missing => false,
        Link::Target(target) if is_sok(target)? => match fs::metadata(target) {
            Ok(info) if info.is_file() && Darwin.executable(&info) => {
                let resolved = fs::canonicalize(target)
                    .map_err(|error| file_error(target.display(), &error))?;
                if !is_sok(&resolved)? {
                    return Err(conflict(&paths.private));
                }
                require_writable_volume(&resolved)?;
                true
            }
            Ok(_) => return Err(conflict(&paths.private)),
            Err(error) if error.kind() == ErrorKind::NotFound => false,
            Err(error) => return Err(file_error(target.display(), &error)),
        },
        _ => return Err(conflict(&paths.private)),
    };
    // default: an unset PATH has no folders to search before the user's bin folder.
    let path = environment.path.as_deref().unwrap_or("");
    let bin = parent(&paths.public)?;
    let in_path = std::env::split_paths(path).any(|entry| entry == bin);
    let profiles_to_edit = if in_path {
        None
    } else {
        Some(profiles(environment, &paths.home, shell)?)
    };

    let mut changed = false;
    if !target_is_ready {
        let target = fs::canonicalize(executable)
            .map_err(|error| file_error(executable.display(), &error))?;
        let target = registered_sok(&target)?;
        let info = fs::metadata(&target).map_err(|error| file_error(target.display(), &error))?;
        if !info.is_file()
            || !Darwin.executable(&info)
            || target.file_name().is_none_or(|name| name != "sok")
        {
            return Err(format!("{}: expected an executable sok", target.display()));
        }
        require_writable_volume(&target)?;
        directory(parent(&paths.private)?)?;
        match private {
            Link::Missing => symlink(&target, &paths.private)
                .map_err(|error| file_error(paths.private.display(), &error))?,
            // The private link is owned and serialized by the registration lock.
            _ => {
                let stage = TempDir::new_in(parent(&paths.private)?)
                    .map_err(|error| file_error(paths.private.display(), &error))?;
                let staged = stage.path().join("sok");
                let replaced =
                    symlink(&target, &staged).and_then(|()| fs::rename(&staged, &paths.private));
                let closed = stage.close();
                match (replaced, closed) {
                    (Ok(()), Ok(())) => {}
                    (Err(error), Ok(())) | (Ok(()), Err(error)) => {
                        return Err(file_error(paths.private.display(), &error));
                    }
                    (Err(error), Err(cleanup)) => {
                        return Err(format!(
                            "{}; cleanup {}",
                            file_error(paths.private.display(), &error),
                            file_error(paths.private.display(), &cleanup)
                        ));
                    }
                }
            }
        }
        changed = true;
    }

    if let Some(required) = profiles_to_edit {
        // Store potential ownership before editing, so removal can recover from a partial installation.
        let before = record.path.profiles.clone();
        for file in &required {
            if !record.path.profiles.contains(file) {
                record.path.profiles.push(file.clone());
            }
        }
        if before != record.path.profiles {
            record.write(&paths.settings)?;
            changed = true;
        }
        for file in &required {
            changed |= insert_block(file)?;
        }
        if record.path.profiles != required {
            for file in &record.path.profiles {
                if !required.contains(file) {
                    remove_block(file)?;
                }
            }
            record.path.profiles = required;
            record.write(&paths.settings)?;
            changed = true;
        }
    }
    if public_missing {
        directory(parent(&paths.public)?)?;
        symlink(&paths.private, &paths.public)
            .map_err(|error| file_error(paths.public.display(), &error))?;
        changed = true;
    }
    Ok(changed)
}

pub(super) fn configure(
    environment: &Environment,
    shell: &str,
    executable: &Path,
    enabled: Option<bool>,
) -> Result<bool, String> {
    // SAFETY: geteuid reads the effective uid and takes no arguments or memory.
    if unsafe { libc::geteuid() } == 0 {
        return Err("user PATH registration cannot be changed as root".to_string());
    }
    let paths = Paths::new(environment)?;
    let (_, present) = Registration::read(&paths.settings)?;
    if !present && enabled.is_none() && path_command(environment)?.is_some() {
        return Ok(false);
    }
    let folder = parent(&paths.settings)?;
    directory(folder)?;
    let lock_path = folder.join("agent-setup.lock");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&lock_path)
        .map_err(|error| file_error(lock_path.display(), &error))?;
    let result = (|| {
        let info = lock
            .metadata()
            .map_err(|error| file_error(lock_path.display(), &error))?;
        if !info.is_file() {
            return Err(conflict(&lock_path));
        }
        Darwin.lock_file(&lock)?;
        let (mut record, present) = Registration::read(&paths.settings)?;
        let mut changed = false;
        if let Some(enabled) = enabled
            && (!present || enabled != record.path.enabled)
        {
            record.path.enabled = enabled;
            record.write(&paths.settings)?;
            changed = true;
        }
        if record.path.enabled {
            changed |= enable(&paths, &mut record, environment, shell, executable)?;
        } else {
            changed |= disable(&paths, &mut record)?;
        }
        Ok(changed)
    })();
    match (result, Darwin.close_file(lock, &lock_path)) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(close)) => Err(format!("{error}; close {close}")),
    }
}
