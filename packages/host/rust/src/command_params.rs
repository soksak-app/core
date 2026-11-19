//! The check of the parameters of a command against its params schema before it runs (docs/spec/exposure.md#command-parameters).

use serde_json::{Map, Value};

/// The refusal of the parameters of the command name by its params schema, or None when the command may run: the first member in
/// code point order that properties of the schema does not name, then the first member of required that the parameters lack, then
/// parameters that do not match the schema otherwise. The endpoint of the host refuses a host command with it. The check is written
/// here and not taken from a JSON Schema library, because the registries of the page and of the Go host answer the same texts, which
/// the libraries of the three languages word differently.
pub fn command_params_refusal(
    name: &str,
    schema: &Map<String, Value>,
    params: &Map<String, Value>,
) -> Option<String> {
    // default: a schema without properties declares no parameter, and one without required requires none.
    let properties = schema.get("properties").and_then(Value::as_object);
    let mut names: Vec<&String> = params.keys().collect();
    names.sort();
    if let Some(unknown) = names
        .into_iter()
        .find(|key| !properties.is_some_and(|declared| declared.contains_key(*key)))
    {
        return Some(format!("command {name}: unknown parameter {unknown}"));
    }
    let required = schema.get("required").and_then(Value::as_array);
    if let Some(missing) = required
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|key| !params.contains_key(*key))
    {
        return Some(format!("command {name}: parameter {missing} is required"));
    }
    if !soksak_sok::matches_schema(schema, &Value::Object(params.clone())) {
        return Some(format!("invalid params for {name}"));
    }
    None
}
