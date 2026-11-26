//! The account homes of a plugin (docs/spec/native-surfaces.md#account-runs): the folders of `accounts/` of the data folder of
//! the plugin, in which the account programs of the plugin keep the logins of a person. The account runs themselves run in the
//! run table of program_run.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};

/// The folder of the account homes in the data folder of a plugin.
const ACCOUNT_HOMES: &str = "accounts";

/// The argument of accountHomes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HomesCall {
    pub plugin: String,
}

/// The argument of accountHomeCreate and accountHomeRemove.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HomeCall {
    pub plugin: String,
    pub id: String,
}

/// Whether the text has the form `[a-z][a-z0-9-]*` and at most max bytes.
fn identifier(text: &str, max: usize) -> bool {
    text.len() <= max
        && text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The folder accounts/ of the data folder of plugin, which this does not create.
fn homes_of(config: &Path, plugin: &str) -> Result<PathBuf, String> {
    if !identifier(plugin, usize::MAX) {
        return Err(format!(
            "account home: plugin {plugin} is not a plugin identifier"
        ));
    }
    if !config.is_absolute() {
        return Err(format!(
            "account home: configuration directory {} is not absolute",
            config.display()
        ));
    }
    Ok(config
        .join(crate::documents::PLUGIN_DATA)
        .join(plugin)
        .join(ACCOUNT_HOMES))
}

/// The home of the account id of plugin.
fn home_of(config: &Path, plugin: &str, id: &str) -> Result<PathBuf, String> {
    let homes = homes_of(config, plugin)?;
    if !identifier(id, 40) {
        return Err(format!("account home {id} is not an account identifier"));
    }
    Ok(homes.join(id))
}

/// Answers `{folder, names}`: the folder accounts/ of the data folder of plugin and the names of its folders in byte order; a
/// missing accounts/ holds none.
pub fn homes(config: &Path, plugin: &str) -> Result<Value, String> {
    let folder = homes_of(config, plugin)?;
    let mut names = Vec::new();
    match std::fs::read_dir(&folder) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| format!("account homes: {error}"))?;
                let kind = entry
                    .file_type()
                    .map_err(|error| format!("account homes: {error}"))?;
                if kind.is_dir() {
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("account homes: {error}")),
    }
    names.sort();
    Ok(json!({ "folder": folder.to_string_lossy(), "names": names }))
}

/// Creates the home of the account id with mode 0700 and the folders above it.
pub fn create(config: &Path, plugin: &str, id: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let home = home_of(config, plugin, id)?;
    crate::platform::current()?
        .create_private_directories(&home)
        .map_err(|error| format!("account home {id}: {error}"))?;
    // A folder that existed keeps its mode through the creation, so the home takes 0700 also then.
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("account home {id}: {error}"))
}

/// Removes the home of the account id with its content; a home that does not exist changes nothing.
pub fn remove(config: &Path, plugin: &str, id: &str) -> Result<(), String> {
    let home = home_of(config, plugin, id)?;
    match std::fs::remove_dir_all(&home) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("account home {id}: {error}")),
    }
}

#[cfg(test)]
#[path = "account_run_test.rs"]
mod account_run_test;
