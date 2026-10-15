//! The installed application of a connector plugin (docs/spec/installation.md#applications): each locate entry is tried
//! in order, and the first that finds the application gives its executable and the kind of the entry.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::platform;

/// An installed application that a locate entry found.
#[derive(Debug, PartialEq)]
pub struct Located {
    /// The executable.
    pub path: PathBuf,
    /// The kind of the entry: `bundle`, `command` or `path`.
    pub method: String,
}

/// Tries each locate entry in order and returns the first application it finds: a bundle identifier through the
/// metadata index of the platform, a name on the search path `search`, or an absolute path of an executable file. The
/// program, a path inside the installed folder, gives the executable of a found bundle. An entry that finds nothing
/// passes to the next one; a failure of the platform is an error.
pub fn locate(
    ways: &[Map<String, Value>],
    program: &str,
    search: &OsStr,
) -> Result<Option<Located>, String> {
    for (index, way) in ways.iter().enumerate() {
        let text = |key: &str| {
            way.get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        };
        if let Some(identifier) = text("bundle") {
            let current =
                platform::current().map_err(|error| format!("locate entry {index}: {error}"))?;
            if let Some(bundle) = current
                .application_of_bundle(identifier)
                .map_err(|error| format!("locate entry {index}: {error}"))?
            {
                // The installed folder holds the bundle, so the program names the executable from the parent of the bundle.
                let parent = bundle.parent().ok_or_else(|| {
                    format!(
                        "locate entry {index}: the bundle {} has no parent folder",
                        bundle.display()
                    )
                })?;
                let path = parent.join(program);
                if executable_file(&path) {
                    return Ok(Some(Located {
                        path,
                        method: "bundle".into(),
                    }));
                }
            }
        } else if let Some(name) = text("command") {
            // which::which reads PATH of the process; the installer passes PATH and the tests pass their own folders.
            if let Ok(path) = which::which_in(name, Some(search), "/")
                && executable_file(&path)
            {
                return Ok(Some(Located {
                    path,
                    method: "command".into(),
                }));
            }
        } else if let Some(path) = text("path") {
            if executable_file(Path::new(path)) {
                return Ok(Some(Located {
                    path: PathBuf::from(path),
                    method: "path".into(),
                }));
            }
        } else {
            return Err(format!(
                "locate entry {index} is not one of bundle, command or path"
            ));
        }
    }
    Ok(None)
}

/// Whether the path is a regular file that the platform marks executable.
fn executable_file(path: &Path) -> bool {
    match (std::fs::metadata(path), platform::current()) {
        (Ok(metadata), Ok(current)) => metadata.is_file() && current.executable(&metadata),
        _ => false,
    }
}

/// Installs the application of a release recipe into the folder `target`, which does not exist yet: it downloads the
/// release with the release limit of the fetcher, compares its SHA-256, and unpacks a zip with the bundle extraction of
/// the platform, a tar.gz with its folders, files and symbolic links that stay inside the folder, or keeps the file as
/// one executable named after the last segment of the address. A step that fails removes what it wrote and returns an
/// error that names the step.
pub fn install_application_release(
    fetcher: &crate::fetch::Fetcher,
    recipe: &Map<String, Value>,
    target: &Path,
) -> Result<(), String> {
    let at = "application release recipe";
    let field = |key: &str| field(at, recipe, key);
    let address = field("url")?;
    if crate::fetch::check_location(address).is_err() || !address.starts_with("https://") {
        return Err(format!(
            "application release {address}: the address is not an https address"
        ));
    }
    let data = fetcher
        .read(address, fetcher.release)
        .map_err(|error| format!("application release download: {error}"))?;
    let got = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&data));
    let expected = field("sha256")?;
    if got != expected {
        return Err(format!(
            "application release {address}: sha256 {got} is not {expected}"
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", target.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| crate::files::file_error(parent.display(), &error))?;
    if std::fs::symlink_metadata(target).is_ok() {
        return Err(format!("application release: {} exists", target.display()));
    }
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no name", target.display()))?;
    let temp = target.with_file_name(format!(".{name}.{}", std::process::id()));
    let result = std::fs::create_dir_all(&temp)
        .map_err(|error| crate::files::file_error(temp.display(), &error))
        .and_then(|()| match field("unpack")? {
            "zip" => unpack_zip(&data, &temp),
            "tar.gz" => unpack_application_tar(&data, &temp),
            "none" => {
                let file = file_of(address)?;
                let path = temp.join(file);
                std::fs::write(&path, &data)
                    .map_err(|error| crate::files::file_error(path.display(), &error))
                    .and_then(|()| platform::current()?.set_executable(&path, true))
            }
            other => Err(format!("unpack {other:?} is not zip, tar.gz or none")),
        })
        .map_err(|error| format!("application release unpack: {error}"))
        .and_then(|()| {
            std::fs::rename(&temp, target)
                .map_err(|error| crate::files::file_error(target.display(), &error))
        });
    result.map_err(|error| {
        crate::files::with_cleanup(error, &temp, |path| std::fs::remove_dir_all(path))
    })
}

/// Writes the zip next to the folder and extracts it with the bundle extraction of the platform, which keeps the modes,
/// the symbolic links and the signature of an application bundle.
fn unpack_zip(data: &[u8], folder: &Path) -> Result<(), String> {
    let zip = folder.with_extension("zip");
    std::fs::write(&zip, data).map_err(|error| crate::files::file_error(zip.display(), &error))?;
    let extracted = platform::current().and_then(|current| current.extract_bundle(&zip, folder));
    let removed =
        std::fs::remove_file(&zip).map_err(|error| crate::files::file_error(zip.display(), &error));
    extracted.and(removed)
}

/// Extracts folders, regular files and symbolic links whose target stays inside the folder. An application release,
/// unlike a plugin release, holds the symbolic links of its bundle.
fn unpack_application_tar(data: &[u8], folder: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut reader = tar::Archive::new(flate2::read::GzDecoder::new(data));
    for entry in reader.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let raw = String::from_utf8(entry.path_bytes().into_owned())
            .map_err(|_| "release entry name is not UTF-8".to_string())?;
        // default: a trailing / only marks a folder entry, so the name is used unchanged when there is none.
        let name = raw.strip_suffix('/').unwrap_or(&raw);
        if name.is_empty() || name.starts_with('/') || name.split('/').any(|part| part == "..") {
            return Err(format!("release entry {raw} leaves the folder"));
        }
        let path = folder.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| crate::files::file_error(parent.display(), &error))?;
        }
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            std::fs::create_dir_all(&path)
                .map_err(|error| crate::files::file_error(path.display(), &error))?;
        } else if kind.is_file() {
            let mode = entry.header().mode().map_err(|error| error.to_string())?;
            let mut content = vec![];
            entry
                .read_to_end(&mut content)
                .map_err(|error| error.to_string())?;
            std::fs::write(&path, &content)
                .map_err(|error| crate::files::file_error(path.display(), &error))?;
            platform::current()?.set_executable(&path, mode & 0o111 != 0)?;
        } else if kind.is_symlink() {
            let link = entry
                .link_name()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    format!("release entry {name} is a symbolic link without a target")
                })?;
            if !link_stays_inside(name, &link) {
                return Err(format!("release entry {name} links outside the folder"));
            }
            platform::current()?.symlink(&link, &path)?;
        } else {
            return Err(format!(
                "release entry {raw} is neither a folder, a regular file nor a symbolic link"
            ));
        }
    }
    Ok(())
}

/// Whether a link at `name` with the target `link` resolves inside the folder: a relative target whose `..` segments do not
/// climb above the folder.
fn link_stays_inside(name: &str, link: &Path) -> bool {
    if link.is_absolute() {
        return false;
    }
    let mut depth: i64 = name.split('/').count() as i64 - 1;
    for part in link.components() {
        match part {
            std::path::Component::ParentDir => depth -= 1,
            std::path::Component::Normal(_) => depth += 1,
            _ => {}
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

/// Asks the package manager, found on the search path, whether it has the package of a package recipe as a cask or as a
/// formula, as the recipe declares, before anything is installed. brew answers through `brew info --json=v2`; a package that
/// brew does not know, or knows as the other kind, is an error that names it.
pub fn check_application_package(
    manager: &str,
    name: &str,
    cask: bool,
    search: &OsStr,
) -> Result<(), String> {
    let program = package_manager(manager, search)?;
    let (kind, list) = if cask {
        ("--cask", "casks")
    } else {
        ("--formula", "formulae")
    };
    let output = run_step(
        &format!("application package {manager} info {kind} {name}"),
        None,
        search,
        &[],
        &program,
        &["info", "--json=v2", kind, name],
    )?;
    let answer: Value = serde_json::from_str(&output).map_err(|error| {
        format!("application package {manager} info {kind} {name}: the answer is not JSON: {error}")
    })?;
    let count = answer
        .get(list)
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if count != 1 {
        return Err(format!(
            "application package {manager} has {count} {list} named {name}"
        ));
    }
    Ok(())
}

/// Installs the package of a package recipe with its manager, found on the search path, as a cask or as a formula. Where
/// the application is afterwards is found by the locate entries of the application, not guessed from the manager.
pub fn install_application_package(
    manager: &str,
    name: &str,
    cask: bool,
    search: &OsStr,
) -> Result<(), String> {
    let program = package_manager(manager, search)?;
    let mut arguments = vec!["install"];
    if cask {
        arguments.push("--cask");
    }
    arguments.push(name);
    run_step(
        &format!("application package {manager} {}", arguments.join(" ")),
        None,
        search,
        &[],
        &program,
        &arguments,
    )
    .map(|_| ())
}

/// The executable of the manager on the search path; brew is the one manager of the specification.
fn package_manager(manager: &str, search: &OsStr) -> Result<PathBuf, String> {
    if manager != "brew" {
        return Err(format!(
            "application package manager {manager:?} is not brew"
        ));
    }
    which::which_in(manager, Some(search), "/")
        .map_err(|_| format!("application package: {manager} is not on the search path"))
}

/// Clones the repository of a source recipe at the ref into the folder `target`, which does not exist yet, and runs each
/// command in it with the search path and the `environment` pairs; the clone is the installed folder. A step that fails
/// removes the folder and returns an error that names the step with its output.
pub fn install_application_source(
    repository: &str,
    reference: &str,
    commands: &[Vec<String>],
    target: &Path,
    search: &OsStr,
    environment: &[(String, String)],
) -> Result<(), String> {
    if crate::fetch::check_location(repository).is_err() || !repository.starts_with("https://") {
        return Err(format!(
            "application source {repository}: the repository is not an https address"
        ));
    }
    if std::fs::symlink_metadata(target).is_ok() {
        return Err(format!("application source: {} exists", target.display()));
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", target.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| crate::files::file_error(parent.display(), &error))?;
    let git = which::which_in("git", Some(search), "/")
        .map_err(|_| "application source: git is not on the search path".to_string())?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no name", target.display()))?;
    let temp = target.with_file_name(format!(".{name}.{}", std::process::id()));
    let clone = temp.to_string_lossy().to_string();
    let result = run_step(
        &format!("application source clone {repository}"),
        None,
        search,
        environment,
        &git,
        &["clone", "--quiet", repository, &clone],
    )
    .and_then(|_| {
        run_step(
            &format!("application source checkout {reference}"),
            Some(&temp),
            search,
            environment,
            &git,
            &["checkout", "--quiet", reference],
        )
    })
    .and_then(|_| {
        for command in commands {
            let first = command
                .first()
                .ok_or("application source command is empty")?;
            let program = which::which_in(first, Some(search), &temp).map_err(|_| {
                    format!("application source command {}: {first} is not on the search path or in the clone", command.join(" "))
                })?;
            let arguments: Vec<&str> = command[1..].iter().map(String::as_str).collect();
            run_step(
                &format!("application source command {}", command.join(" ")),
                Some(&temp),
                search,
                environment,
                &program,
                &arguments,
            )?;
        }
        Ok(())
    })
    .and_then(|()| {
        std::fs::rename(&temp, target)
            .map_err(|error| crate::files::file_error(target.display(), &error))
    });
    result.map_err(|error| {
        crate::files::with_cleanup(error, &temp, |path| std::fs::remove_dir_all(path))
    })
}

/// Runs one program of a recipe in the folder with PATH set to the search path and the environment pairs, and returns its
/// standard output; a failure names the step with the exit and the last kilobyte of the combined output.
fn run_step(
    step: &str,
    folder: Option<&Path>,
    search: &OsStr,
    environment: &[(String, String)],
    program: &Path,
    arguments: &[&str],
) -> Result<String, String> {
    let mut command = std::process::Command::new(program);
    command.args(arguments).env("PATH", search);
    for (key, value) in environment {
        command.env(key, value);
    }
    if let Some(folder) = folder {
        command.current_dir(folder);
    }
    let output = command
        .output()
        .map_err(|error| format!("{step}: {error}"))?;
    if !output.status.success() {
        let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        let tail: String = combined
            .chars()
            .rev()
            .take(1024)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("{step}: {}: {}", output.status, tail.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The place of the record of connected applications inside the configuration directory.
pub const APPLICATIONS: &str = "plugins/applications.json";

/// One connected application: its version, its executable, located or installed, and the locate kind or recipe kind that
/// gave it (docs/spec/installation.md#applications).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ApplicationRecord {
    /// The version of the application.
    pub version: String,
    /// The absolute path of the executable.
    pub path: String,
    /// `located` or `installed`.
    pub how: String,
    /// The locate kind or the recipe kind.
    pub method: String,
}

/// plugins/applications.json.
#[derive(Debug, serde::Serialize)]
pub struct ApplicationsState {
    /// The format, 1.
    pub format: u32,
    /// Each connected application by its id.
    pub applications: std::collections::BTreeMap<String, ApplicationRecord>,
}

/// Reads plugins/applications.json; an absent file is an empty record, and another form is an error that names the file
/// and what it found.
pub fn read_applications(config_dir: &Path) -> Result<ApplicationsState, String> {
    let path = config_dir.join(APPLICATIONS);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ApplicationsState {
                format: 1,
                applications: Default::default(),
            });
        }
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    validate_applications(&value).map_err(|error| format!("{}: {error}", path.display()))
}

fn validate_applications(value: &Value) -> Result<ApplicationsState, String> {
    let root = value
        .as_object()
        .ok_or("applications.json must be an object")?;
    if let Some(key) = root
        .keys()
        .find(|key| !["format", "applications"].contains(&key.as_str()))
    {
        return Err(format!("applications.json has the unknown field {key}"));
    }
    if root.get("format") != Some(&Value::from(1)) {
        return Err(format!(
            "format must be 1, not {}",
            root.get("format")
                .map_or("nothing".to_string(), Value::to_string)
        ));
    }
    let entries = root
        .get("applications")
        .and_then(Value::as_object)
        .ok_or("applications must be an object")?;
    let mut state = ApplicationsState {
        format: 1,
        applications: Default::default(),
    };
    for (id, entry) in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("application {id} must be an object"))?;
        if let Some(key) = entry
            .keys()
            .find(|key| !["version", "path", "how", "method"].contains(&key.as_str()))
        {
            return Err(format!("application {id} has the unknown field {key}"));
        }
        let text = |key: &str| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        };
        let version =
            text("version").ok_or_else(|| format!("application {id} version must be text"))?;
        let path = text("path")
            .filter(|path| Path::new(path).is_absolute())
            .ok_or_else(|| format!("application {id} path must be an absolute path"))?;
        let how = text("how")
            .filter(|how| *how == "located" || *how == "installed")
            .ok_or_else(|| {
                format!(
                    "application {id} how must be located or installed, not {}",
                    entry
                        .get("how")
                        .map_or("nothing".to_string(), Value::to_string)
                )
            })?;
        let method =
            text("method").ok_or_else(|| format!("application {id} method must be text"))?;
        state.applications.insert(
            id.clone(),
            ApplicationRecord {
                version: version.into(),
                path: path.into(),
                how: how.into(),
                method: method.into(),
            },
        );
    }
    Ok(state)
}

/// Writes the application into plugins/applications.json in one step.
pub fn record_application(
    config_dir: &Path,
    id: &str,
    record: ApplicationRecord,
) -> Result<(), String> {
    let mut state = read_applications(config_dir)?;
    state.applications.insert(id.to_string(), record);
    write_applications(config_dir, &state)
}

/// Deletes the folder of an installed application and its entry, and only the entry of a located one; an application
/// without an entry is nothing to remove.
pub fn remove_application(config_dir: &Path, id: &str) -> Result<(), String> {
    let mut state = read_applications(config_dir)?;
    let Some(record) = state.applications.remove(id) else {
        return Ok(());
    };
    if record.how == "installed" {
        let folder = config_dir.join("applications").join(id);
        match std::fs::remove_dir_all(&folder) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(crate::files::file_error(folder.display(), &error)),
        }
    }
    write_applications(config_dir, &state)
}

fn write_applications(config_dir: &Path, state: &ApplicationsState) -> Result<(), String> {
    let mut out = vec![];
    crate::release::print_json(&mut out, state)?;
    let path = config_dir.join(APPLICATIONS);
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| crate::files::file_error(parent.display(), &error))?;
    crate::release::replace_file(&path, &out)
}

/// The application that the plugin.json in the folder of an installed plugin declares, or `None` for a plugin without one.
pub(crate) fn installed_application(
    config_dir: &Path,
    folder: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let file = config_dir.join(folder).join("plugin.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|error| crate::files::file_error(file.display(), &error))?;
    let manifest: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", file.display()))?;
    match manifest.get("application") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(application)) => Ok(Some(application.clone())),
        Some(_) => Err(format!("{} application must be an object", file.display())),
    }
}

/// The text of the key of a declaration; a missing or empty value is an error that names the key.
fn field<'a>(at: &str, declaration: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    declaration
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "{at} {key} must be text, not {}",
                declaration
                    .get(key)
                    .map_or("nothing".to_string(), Value::to_string)
            )
        })
}

fn object<'a>(at: &str, value: Option<&'a Value>) -> Result<&'a Map<String, Value>, String> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{at} must be an object"))
}

/// Connects the application of a connector plugin on the platform: an application that a locate entry finds is recorded
/// as located, and otherwise the recipe installs it and the place it gives is recorded as installed
/// (docs/spec/installation.md#applications). `search` is PATH, for the locate entries and the programs of the recipes.
pub fn connect_application(
    config_dir: &Path,
    platform: &str,
    application: &Map<String, Value>,
    search: &OsStr,
) -> Result<(), String> {
    let id = field("application", application, "id")?;
    let version = field(&format!("application {id}"), application, "version")?;
    let platforms = object(
        &format!("application {id} platforms"),
        application.get("platforms"),
    )?;
    let Some(entry) = platforms.get(platform) else {
        return Err(format!("application {id} does not support {platform}"));
    };
    let entry = object(&format!("application {id} {platform}"), Some(entry))?;
    let program = field(&format!("application {id} {platform}"), entry, "program")?;
    let ways: Vec<Map<String, Value>> = entry
        .get("locate")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("application {id} locate must be a list"))?
        .iter()
        .enumerate()
        .map(|(index, way)| {
            object(&format!("application {id} locate entry {index}"), Some(way)).cloned()
        })
        .collect::<Result<_, _>>()?;
    if let Some(located) =
        locate(&ways, program, search).map_err(|error| format!("application {id}: {error}"))?
    {
        let record = ApplicationRecord {
            version: version.into(),
            path: located.path.display().to_string(),
            how: "located".into(),
            method: located.method,
        };
        return record_application(config_dir, id, record);
    }
    let recipe = object(&format!("application {id} recipe"), entry.get("recipe"))?;
    let at = format!("application {id} recipe");
    let kind = field(&at, recipe, "kind")?;
    let target = config_dir.join("applications").join(id).join(version);
    match kind {
        "release" => {
            install_application_release(&crate::fetch::Fetcher::default(), recipe, &target)
                .map_err(|error| format!("application {id}: {error}"))?
        }
        "source" => {
            let repository = field(&at, recipe, "repository")?;
            let reference = field(&at, recipe, "ref")?;
            let commands = recipe
                .get("commands")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{at} commands must be a list"))?
                .iter()
                .enumerate()
                .map(|(index, command)| {
                    command
                        .as_array()
                        .and_then(|parts| {
                            parts
                                .iter()
                                .map(|part| part.as_str().map(str::to_string))
                                .collect::<Option<Vec<_>>>()
                        })
                        .ok_or_else(|| {
                            format!("application {id} command {index} must be a list of text")
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            install_application_source(repository, reference, &commands, &target, search, &[])
                .map_err(|error| format!("application {id}: {error}"))?;
        }
        "package" => {
            let manager = field(&at, recipe, "manager")?;
            let name = field(&at, recipe, "name")?;
            let cask = recipe
                .get("cask")
                .and_then(Value::as_bool)
                .ok_or_else(|| format!("{at} cask must be true or false"))?;
            check_application_package(manager, name, cask, search)
                .map_err(|error| format!("application {id}: {error}"))?;
            install_application_package(manager, name, cask, search)
                .map_err(|error| format!("application {id}: {error}"))?;
            // The manager decides where the application goes, so the locate entries give its place.
            let located = locate(&ways, program, search)
                .map_err(|error| format!("application {id}: {error}"))?
                .ok_or_else(|| format!("application {id}: the package {name} is installed, and no locate entry finds the application"))?;
            let record = ApplicationRecord {
                version: version.into(),
                path: located.path.display().to_string(),
                how: "installed".into(),
                method: "package".into(),
            };
            return record_application(config_dir, id, record);
        }
        other => {
            return Err(format!(
                "application {id} recipe kind {other:?} is not release, package or source"
            ));
        }
    }
    let executable = target.join(program);
    if !executable_file(&executable) {
        let error = format!("application {id}: the recipe installed no executable {program}");
        return Err(crate::files::with_cleanup(
            error,
            &config_dir.join("applications").join(id),
            |path| std::fs::remove_dir_all(path),
        ));
    }
    let record = ApplicationRecord {
        version: version.into(),
        path: executable.display().to_string(),
        how: "installed".into(),
        method: kind.into(),
    };
    record_application(config_dir, id, record)
}

/// The last segment of the path of an address, without its query; an address whose path ends without a segment names no
/// file and is an error.
fn file_of(address: &str) -> Result<&str, String> {
    let path = match address.split_once('?') {
        Some((path, _)) => path,
        None => address,
    };
    match path.rsplit_once('/') {
        Some((_, file)) if !file.is_empty() => Ok(file),
        _ => Err(format!(
            "application release {address}: the address names no file"
        )),
    }
}
