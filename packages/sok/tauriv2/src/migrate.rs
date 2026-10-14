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
use crate::install::{INSTALLED, INSTALLED_FORMAT, InstalledState, validate_installed};
use crate::plugins::write_installed;

/// One named operation of a definition, with the scope it applies to. The engine implements the operations the contract
/// names; a definition that names another is refused when it loads.
#[derive(Deserialize)]
struct Operation {
    op: String,
    scope: String,
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
    let text = include_str!("migrations/installed.json");
    let definitions: Vec<Definition> = serde_json::from_str(text).map_err(|error| {
        format!("the embedded migration definitions are not valid JSON: {error}")
    })?;
    let mut ends_at: Option<(String, u64)> = None;
    for definition in &definitions {
        if definition.file != INSTALLED {
            return Err(format!(
                "the embedded migration definitions: {} is not {INSTALLED}",
                definition.file
            ));
        }
        match &ends_at {
            Some((_, to)) if definition.from != *to => {
                return Err(format!(
                    "the embedded migration definitions: {INSTALLED} migrates from format {}, but the earlier step ends at {to}",
                    definition.from
                ));
            }
            _ => ends_at = Some((definition.file.clone(), definition.to)),
        }
        for operation in &definition.operations {
            let known = matches!(
                (operation.op.as_str(), operation.scope.as_str()),
                ("removeField", "plugins") | ("renameField", "plugins") | ("setFormat", "document")
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
    let path = config_dir.join(INSTALLED);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(file_error(path.display(), &error)),
    };
    let mut document: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    let format = document
        .get("format")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{}: the file holds no format", path.display()))?;
    if format == INSTALLED_FORMAT {
        return Ok(0);
    }
    let definitions = definitions()?;
    // default: a definition list that holds no step migrates nothing, so its floor is 0 and every form is refused.
    let floor = definitions.first().map(|step| step.from).unwrap_or(0);
    let Some(step) = definitions.iter().find(|step| step.from == format) else {
        return Err(format!(
            "{}: the file holds format {format}; the definitions migrate formats {floor} to {INSTALLED_FORMAT}",
            path.display()
        ));
    };
    for operation in &step.operations {
        apply(&mut document, operation).map_err(|error| format!("{}: {error}", path.display()))?;
    }
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
    if let Some(log) = process_log() {
        log.emit(
            Level::Info,
            "log.migrated",
            &serde_json::json!({"file": INSTALLED, "from": step.from, "to": step.to}),
        );
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
