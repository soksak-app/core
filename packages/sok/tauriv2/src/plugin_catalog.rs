//! The classes of the events of the installed plugins (docs/spec/logging.md#plugin-catalogs). The class table generated from
//! the core catalog declares no plugin event; each plugin declares its events in the catalog that the member `events` of its
//! plugin.json names, and the writer gives a plugin event the class of that catalog.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::event_classes::Class;
use crate::plugins::read_installed;

/// Reads the catalogs of the enabled installed plugins and returns the class of each event they declare. A catalog that cannot
/// be used is an error that names its file, and the other plugins keep their classes; the errors are in the order of the
/// plugin ids.
pub fn plugin_event_classes(config_dir: &Path) -> (HashMap<String, Class>, Vec<String>) {
    let state = match read_installed(config_dir) {
        Ok(state) => state,
        Err(error) => return (HashMap::new(), vec![error]),
    };
    let mut classes = HashMap::new();
    let mut errors = Vec::new();
    // The plugins of the state are in the order of their ids.
    for (id, plugin) in state.plugins.iter().filter(|(_, plugin)| plugin.enabled) {
        match catalog_classes(&config_dir.join(&plugin.path), id) {
            Ok(declared) => classes.extend(declared),
            Err(error) => errors.push(error),
        }
    }
    (classes, errors)
}

/// Reads the catalog that the plugin.json in `folder` names. A plugin without the member `events` declares no event.
fn catalog_classes(folder: &Path, id: &str) -> Result<HashMap<String, Class>, String> {
    let manifest_path = folder.join("plugin.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|_| {
        format!(
            "{}: the manifest of plugin {id} cannot be read",
            manifest_path.display()
        )
    })?;
    let manifest: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "{}: the manifest of plugin {id} is not JSON",
            manifest_path.display()
        )
    })?;
    let Some(events) = manifest.get("events").and_then(Value::as_str) else {
        return Ok(HashMap::new());
    };
    let path = folder.join(events);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "{}: the event catalog of plugin {id} does not exist",
                path.display()
            ))
        }
        Err(_) => {
            return Err(format!(
                "{}: the event catalog of plugin {id} cannot be read",
                path.display()
            ))
        }
    };
    let catalog: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "{}: the event catalog of plugin {id} is not JSON",
            path.display()
        )
    })?;
    let prefix = format!("plugin.{id}.");
    let mut names: Vec<(&String, &Value)> = catalog
        .get("events")
        .and_then(Value::as_object)
        .map(|events| events.iter().collect())
        // default: a catalog without the member events declares no event, as a plugin without a catalog does.
        .unwrap_or_default();
    names.sort_by(|a, b| a.0.cmp(b.0));
    let mut classes = HashMap::new();
    for (name, entry) in names {
        if !name.starts_with(&prefix) || name.len() == prefix.len() {
            return Err(format!(
                "{}: the event {name} is not an event of plugin {id} (plugin.{id}.<event>)",
                path.display()
            ));
        }
        // default: an entry without a class is refused by the parse below with the empty class in its error.
        let class = entry.get("class").and_then(Value::as_str).unwrap_or("");
        let Some(parsed) = Class::parse(class) else {
            return Err(format!(
                "{}: the event {name} has the class {class}, which is not lifecycle, input, call, io or frame",
                path.display()
            ));
        };
        classes.insert(name.clone(), parsed);
    }
    Ok(classes)
}
