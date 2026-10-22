//! The migration engine of the stored files: it applies the embedded definitions at the entry of the shared reader of
//! each contract file (docs/spec/installation.md#stored-data-migration). The definitions are one source for both
//! command lines; the file here is a tracked copy of `packages/sok/migrations`, kept equal by `make migrations-check`.

use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::event_log::{EventLog, Level};
use crate::files::file_error;
use crate::install::{INSTALLED, InstalledState, PROJECTS, SETTINGS, validate_installed};
use crate::plugins::write_installed;

/// One named operation of a definition, with the scope it applies to. The engine implements the operations the contract
/// names; a definition that names another is refused when it loads.
#[derive(Deserialize)]
struct Operation {
    op: String,
    scope: String,
    #[serde(default)]
    member: String,
    #[serde(default)]
    field: String,
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: Value,
}

/// One step of the chain of one stored file.
#[derive(Deserialize)]
struct Definition {
    file: String,
    from: u64,
    to: u64,
    operations: Vec<Operation>,
}

/// The embedded definitions, parsed. A set that is not a chain of the one file it may hold is refused: a definition
/// that names another file, a step that does not start where the earlier one ends, or an operation or scope the engine
/// does not implement.
fn definitions() -> Result<Vec<Definition>, String> {
    parse_definitions(&[
        (
            "migrations/installed.json",
            include_str!("migrations/installed.json"),
        ),
        (
            "migrations/settings.json",
            include_str!("migrations/settings.json"),
        ),
        (
            "migrations/projects.json",
            include_str!("migrations/projects.json"),
        ),
    ])
}

/// Parses the definition sources (name and text of each) and refuses a set that is not a chain.
fn parse_definitions(sources: &[(&str, &str)]) -> Result<Vec<Definition>, String> {
    let mut definitions = vec![];
    for &(name, text) in sources {
        let mut parsed: Vec<Definition> = serde_json::from_str(text)
            .map_err(|error| format!("{name} is not valid JSON: {error}"))?;
        definitions.append(&mut parsed);
    }
    let mut ends_at: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    for definition in &definitions {
        if definition.file != INSTALLED
            && definition.file != SETTINGS
            && definition.file != PROJECTS
        {
            return Err(format!(
                "the embedded migration definitions: {} is neither {INSTALLED}, {SETTINGS} nor {PROJECTS}",
                definition.file
            ));
        }
        match ends_at.get(&definition.file) {
            Some(to) if definition.from != *to => {
                return Err(format!(
                    "the embedded migration definitions: {} migrates from format {}, but the earlier step ends at {to}",
                    definition.file, definition.from
                ));
            }
            _ => {
                ends_at.insert(definition.file.clone(), definition.to);
            }
        }
        for operation in &definition.operations {
            let known = matches!(
                (operation.op.as_str(), operation.scope.as_str()),
                ("removeField", "plugins")
                    | ("renameField", "plugins")
                    | ("setFormat", "document")
                    | ("wrapDocument", "document")
            );
            if !known {
                return Err(format!(
                    "the embedded migration definitions: the operation {} of scope {} is not one the engine implements",
                    operation.op, operation.scope
                ));
            }
        }
    }
    Ok(definitions)
}

thread_local! {
    /// The event writer of the process that runs the engine: a host registers it after its event log starts, and a
    /// tool run keeps its own event file in the run log of the replay module.
    static MIGRATION_LOG: RefCell<Option<Arc<EventLog>>> = const { RefCell::new(None) };
}

/// One step of a chain as the owning tests read it.
pub struct StepForTest {
    pub from: u64,
    pub to: u64,
}

/// Exposes the parsed chains for the owning tests: the chain of each file as the steps the engine applies, so a test
/// holds the engine to the definitions it embeds.
pub fn migration_chains_for_test()
-> Result<std::collections::BTreeMap<String, Vec<StepForTest>>, String> {
    let mut out = std::collections::BTreeMap::new();
    for definition in definitions()? {
        out.entry(definition.file.clone())
            .or_insert_with(Vec::new)
            .push(StepForTest {
                from: definition.from,
                to: definition.to,
            });
    }
    Ok(out)
}

/// The current format number of projects.json, the end of its definition chain.
pub fn projects_format() -> Result<u64, String> {
    format_of(PROJECTS, &definitions()?)
}

/// The current format number of settings.json, the end of its definition chain.
pub fn settings_format() -> Result<u64, String> {
    format_of(SETTINGS, &definitions()?)
}

/// The current format of one file of the definitions. A file without a chain has no current form, so it is an error: the
/// caller refuses to write a format number that the definitions do not state.
fn format_of(file: &str, definitions: &[Definition]) -> Result<u64, String> {
    definitions
        .iter()
        .rev()
        .find(|step| step.file == file)
        .map(|step| step.to)
        .ok_or_else(|| format!("the migration definitions hold no chain for {file}"))
}

#[cfg(test)]
#[path = "migrate_format_test.rs"]
mod format_tests;

/// Registers the event writer of this process for the records of the migration engine; `None` registers none.
pub fn use_migration_log(log: Option<Arc<EventLog>>) {
    MIGRATION_LOG.with(|cell| *cell.borrow_mut() = log);
}

/// The event writer of this thread's run, if one is installed.
fn process_log() -> Option<Arc<EventLog>> {
    MIGRATION_LOG
        .with(|cell| cell.borrow().clone())
        .or_else(crate::replay::current_run_log)
}

/// Applies the migration definitions of `plugins/installed.json` at the entry of its shared reader: a missing file is
/// left missing, a file at the current format is left untouched, a form of the chain migrates step by step through the
/// one writer of this package, and a form outside the chain — below the floor, above the current format, or not JSON —
/// is refused with an error that names the file and the format it holds. It returns the format the applied step ended
/// at, or 0 when it applied nothing.
pub fn migrate_installed(config_dir: &Path) -> Result<u64, String> {
    migrate(config_dir, INSTALLED)
}

/// Applies the migration definitions of settings.json at the entry of its shared reader, the host workspace layer. A
/// file with no format member is the form 0.
pub fn migrate_settings(config_dir: &Path) -> Result<u64, String> {
    migrate(config_dir, SETTINGS)
}

/// Applies the migration definitions of projects.json at the entry of its shared reader, the host workspace layer. A
/// file that is a bare array of projects is the form 0.
pub fn migrate_projects(config_dir: &Path) -> Result<u64, String> {
    migrate(config_dir, PROJECTS)
}

/// Applies the definitions of one stored file.
fn migrate(config_dir: &Path, file: &str) -> Result<u64, String> {
    let path = config_dir.join(file);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(file_error(path.display(), &error)),
    };
    let raw: Value =
        serde_json::from_str(&text).map_err(|_| format!("{} is not valid JSON", path.display()))?;
    let mut bare = raw.as_array().cloned();
    if !raw.is_object() && bare.is_none() {
        return Err(format!(
            "{}: the file is neither an object nor a list",
            path.display()
        ));
    }
    let mut document = raw;
    // A file with no format member is the form 0, the form before the number existed. A member that is not a non-negative
    // integer is refused with its JSON text, so no other form is read as form 0.
    let format = match document.get("format") {
        None => 0,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| format!("{}: format must be a number, found {value}", path.display()))?,
    };
    let definitions = definitions()?;
    let chain: Vec<&Definition> = definitions
        .iter()
        .filter(|step| step.file == file)
        .collect();
    // default: a definition list that holds no step migrates nothing, so its floor is 0 and every form is refused.
    let floor = chain.first().map(|step| step.from).unwrap_or(0);
    // default: a chain that holds no step has no current form, so every form is refused below.
    let current = chain.last().map(|step| step.to).unwrap_or(0);
    if format == current {
        return Ok(0);
    }
    let Some(step) = chain.iter().find(|step| step.from == format) else {
        return Err(format!(
            "{}: the file holds format {format}; the definitions migrate formats {floor} to {current}",
            path.display()
        ));
    };
    for operation in &step.operations {
        if operation.op == "wrapDocument" {
            // The earlier form is the bare list; the operation names the member it becomes under the format member.
            let Some(bare) = bare.take() else {
                return Err(format!(
                    "{}: the operation wrapDocument needs the bare list of the earlier form",
                    path.display()
                ));
            };
            let mut wrapped = serde_json::Map::new();
            wrapped.insert(operation.member.clone(), Value::Array(bare));
            document = Value::Object(wrapped);
            continue;
        }
        apply(&mut document, operation).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    if file == INSTALLED {
        let state: InstalledState = serde_json::from_value(document).map_err(|error| {
            format!(
                "{}: the migration of format {format} produced a file the reader refuses: {error}",
                path.display()
            )
        })?;
        let written = serde_json::to_value(&state).map_err(|error| error.to_string())?;
        validate_installed(&written).map_err(|error| {
            format!(
                "{}: the migration of format {format} produced a file the reader refuses: {error}",
                path.display()
            )
        })?;
        write_installed(config_dir, &state)?;
    } else {
        let text = serde_json::to_string_pretty(&document).map_err(|error| {
            format!(
                "{}: the migrated file cannot be written: {error}",
                path.display()
            )
        })?;
        crate::release::replace_file(&path, text.as_bytes())?;
    }
    // A migration happens once, at the install moment, so its record passes every gate like the events of the writer itself
    // (docs/spec/logging.md#policy); a record the full queue refuses is counted as lost by the writer.
    if let Some(log) = process_log() {
        let fields = serde_json::value::to_raw_value(
            &serde_json::json!({"file": file, "from": step.from, "to": step.to}),
        )
        .expect("a json value serializes");
        log.enqueue_writer_event(Level::Info, "log.migrated", fields);
    }
    Ok(step.to)
}

/// Applies one named operation to the document in place.
fn apply(document: &mut Value, operation: &Operation) -> Result<(), String> {
    match (operation.op.as_str(), operation.scope.as_str()) {
        ("setFormat", "document") => {
            let to = operation.to.as_u64().ok_or_else(|| {
                format!(
                    "setFormat needs the format number it sets, found {}",
                    operation.to
                )
            })?;
            if let Some(object) = document.as_object_mut() {
                object.insert("format".into(), Value::from(to));
            }
            Ok(())
        }
        (op @ ("removeField" | "renameField"), "plugins") => {
            let Some(entries) = document.get_mut("plugins").and_then(Value::as_object_mut) else {
                return Err(format!(
                    "the operation {op} of scope \"plugins\" does not name the plugin entries of the file"
                ));
            };
            for entry in entries.values_mut() {
                let Some(object) = entry.as_object_mut() else {
                    continue;
                };
                if op == "removeField" {
                    object.remove(&operation.field);
                } else if let Some(value) = object.remove(&operation.from) {
                    let name = operation.to.as_str().ok_or_else(|| {
                        format!(
                            "renameField needs the field name it sets, found {}",
                            operation.to
                        )
                    })?;
                    object.insert(name.to_string(), value);
                }
            }
            Ok(())
        }
        (op, scope) => Err(format!(
            "the operation {op} of scope {scope:?} is not one the engine implements"
        )),
    }
}
