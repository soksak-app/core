// The role handshake state of a tab (docs/spec/agent-roles.md#tab-role-state): the stored record of the tab in projects.json,
// the role files of its surface, and the answers of the role operations of the workspace store. Every operation of one
// surface runs under the lock of the workspace store, in arrival order, so each is judged against the state at its turn.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::role_file::{prepare_role_file, role_fingerprint};
use crate::roles::read_roles;
use crate::workspace::{check_projects, read_projects, write_projects};

/// The state of the role operations that this session of the host holds beside the stored record: the count of the changes of
/// each tab, and the tabs whose role ended with their removal from the layout. The durable state of a role is its stored
/// record, so the status is rebuilt from it after a restart.
#[derive(Default)]
pub struct RoleState {
    seq: HashMap<String, i64>,
    removed: HashSet<String>,
}

/// The fingerprint form: 16 lowercase hexadecimal characters.
fn fingerprint_holds(fingerprint: &str) -> bool {
    fingerprint.len() == 16
        && fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Returns the path of the role file of a tab.
fn role_path(directory: &Path, tab: &str) -> PathBuf {
    directory.join("agents").join(tab).join("role.md")
}

/// States the refusal of a failed write step: `role file <path>: write failed: <os error>`.
fn write_failed(path: &Path, error: &str) -> String {
    format!("role file {}: write failed: {error}", path.display())
}

/// Reads projects.json and answers it checked.
fn checked_projects(registry: &Path) -> Result<Vec<Value>, String> {
    let projects = read_projects(registry).map_err(|e| write_failed(registry, &e))?;
    check_projects(registry, projects).map_err(|e| write_failed(registry, &e))
}

/// The validated record of the role of a tab (docs/spec/agent-roles.md#tab-role-state): a record is never partial, so every
/// member read after the validation holds its form.
struct RoleRecord<'a> {
    id: &'a str,
    generation: i64,
    fingerprint: &'a str,
    confirmed: Option<&'a str>,
}

/// The found tab of a stored layout with the place that names it.
struct FoundTab<'a> {
    root: &'a str,
    space: &'a str,
    entry: &'a Map<String, Value>,
}

/// Validates the member role of a tab and returns its record, or None for the value null. An absent member or a record of
/// another form is refused with the text of the specification, which names the file, the project, the space and the tab.
fn checked_tab_role<'a>(
    registry: &Path,
    root: &str,
    space: &str,
    tab: &str,
    entry: &'a Map<String, Value>,
) -> Result<Option<RoleRecord<'a>>, String> {
    let invalid = || {
        format!(
            "{file}: project {root} space {space}: tab {tab} member role is invalid",
            file = registry.display()
        )
    };
    let Some(role) = entry.get("role") else {
        return Err(format!(
            "{file}: project {root} space {space}: tab {tab} member role is missing",
            file = registry.display()
        ));
    };
    if role.is_null() {
        return Ok(None);
    }
    let Some(record) = role.as_object() else {
        return Err(invalid());
    };
    if record.len() != 4 {
        return Err(invalid());
    }
    let Some(id) = record["id"].as_str() else {
        return Err(invalid());
    };
    let identifier_holds = (1..=64).contains(&id.len())
        && id.starts_with(|first: char| first.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !identifier_holds {
        return Err(invalid());
    }
    let Some(generation) = record["generation"].as_f64() else {
        return Err(invalid());
    };
    if generation < 1.0 || generation.fract() != 0.0 {
        return Err(invalid());
    }
    let Some(fingerprint) = record["fingerprint"].as_str() else {
        return Err(invalid());
    };
    if !fingerprint_holds(fingerprint) {
        return Err(invalid());
    }
    let confirmed = match record["confirmedFingerprint"].as_str() {
        None if record["confirmedFingerprint"].is_null() => None,
        Some(confirmed) if fingerprint_holds(confirmed) => Some(confirmed),
        _ => return Err(invalid()),
    };
    Ok(Some(RoleRecord {
        id,
        generation: generation as i64,
        fingerprint,
        confirmed,
    }))
}

/// Finds the tab in the projects and returns its place. No place is returned for a tab that no stored layout holds.
fn find_tab_role<'a>(projects: &'a [Value], tab: &str) -> Option<FoundTab<'a>> {
    for project in projects {
        let Some(root) = project["root"].as_str() else {
            continue;
        };
        let Some(spaces) = project["spaces"].as_array() else {
            continue;
        };
        for held in spaces {
            let Some(space) = held["id"].as_str() else {
                continue;
            };
            let Some(state) = held["layout"]["state"].as_object() else {
                continue;
            };
            if let Some(entry) = tab_entry(&state["root"], tab) {
                return Some(FoundTab { root, space, entry });
            }
        }
    }
    None
}

/// Returns the tab record of the tab id in the tree of a layout state, or None when the tree holds no such tab.
fn tab_entry<'a>(node: &'a Value, tab: &str) -> Option<&'a Map<String, Value>> {
    let Some(holder) = node.as_object() else {
        return None;
    };
    if holder.contains_key("card") {
        let tabs = holder["data"]["tabs"].as_array()?;
        return tabs
            .iter()
            .find(|entry| entry["id"].as_str() == Some(tab))
            .and_then(Value::as_object);
    }
    if holder.contains_key("box") {
        return tab_entry(&holder["inner"], tab);
    }
    let Some(kids) = holder["kids"].as_array() else {
        return None;
    };
    for kid in kids {
        if let Some(found) = tab_entry(&kid["node"], tab) {
            return Some(found);
        }
    }
    None
}

/// Answers the status of the role of a tab: the record of the tab in projects.json decides every member, and a tab without a
/// record answers the null members. A tab that no stored layout holds answers null itself.
pub fn role_get(directory: &Path, state: &mut RoleState, tab: &str) -> Result<Value, String> {
    let registry = directory.join("projects.json");
    let projects = checked_projects(&registry)?;
    match find_tab_role(&projects, tab) {
        None => Ok(Value::Null),
        Some(found) => {
            let record = checked_tab_role(&registry, found.root, found.space, tab, found.entry)?;
            Ok(answer_of(directory, state, tab, record.as_ref()))
        }
    }
}

/// Builds the answer of the state of the stored record of a tab. A record is never partial
/// (docs/spec/agent-roles.md#tab-role-state), so a present record holds every member.
fn answer_of(
    directory: &Path,
    state: &RoleState,
    tab: &str,
    record: Option<&RoleRecord<'_>>,
) -> Value {
    // A tab without a change in this session holds the count zero.
    let seq = match state.seq.get(tab) {
        Some(held) => *held,
        None => 0,
    };
    let Some(record) = record else {
        return json!({"role": null, "generation": null, "state": null, "seq": seq, "fingerprint": null, "path": null});
    };
    json!({"role": record.id, "generation": record.generation,
        "state": if record.confirmed == Some(record.fingerprint) { "ready" } else { "pending" }, "seq": seq,
        "fingerprint": record.fingerprint, "path": role_path(directory, tab).display().to_string()})
}

/// Assigns, changes and clears the role of a tab, in the order that docs/spec/agent-roles.md#tab-role-state states: the role
/// files are written under their temporary names first, the record is stored in projects.json second and the temporary files
/// are renamed third. A failure of a step removes what the step wrote and leaves the earlier state, and a failure of the
/// rename restores the earlier record. Setting the role that the tab already has, with the same definition, changes nothing.
pub fn role_put(
    directory: &Path,
    state: &mut RoleState,
    tab: &str,
    role: &Value,
) -> Result<Value, String> {
    if state.removed.contains(tab) {
        return Err(format!("tab {tab} was removed; its role cannot change"));
    }
    match role.as_str() {
        Some(id) => role_change(directory, state, tab, id),
        None if role.is_null() => role_clear(directory, state, tab),
        None => Err(format!("role {role} is not an agent role identifier")),
    }
}

/// Assigns or changes the role of a tab to the role id, with the ordered steps and the idempotency of the spec.
fn role_change(
    directory: &Path,
    state: &mut RoleState,
    tab: &str,
    id: &str,
) -> Result<Value, String> {
    let definitions = read_roles(&directory.join("roles.json"))?;
    let Some(definition) = definitions.get(id).and_then(Value::as_object) else {
        return Err(format!("unknown agent role {id}"));
    };
    // check_roles of roles.json guarantees the two members; the reads are stated and refuse the impossible case.
    let (Some(text), Some(ko)) = (definition["text"].as_str(), definition["ko"].as_str()) else {
        return Err(format!("role {id} holds no text or ko"));
    };
    let fingerprint = role_fingerprint(id, text);
    let registry = directory.join("projects.json");
    let projects = checked_projects(&registry)?;
    let Some(found) = find_tab_role(&projects, tab) else {
        return Err(format!("surface {tab:?} has no tab"));
    };
    let earlier = checked_tab_role(&registry, found.root, found.space, tab, found.entry)?;
    if let Some(record) = &earlier {
        if record.id == id && record.fingerprint == fingerprint {
            // The same role with the same definition: no file is written, no generation changes and no message is sent.
            return Ok(answer_of(directory, state, tab, Some(record)));
        }
    }
    // Step 1: both role files are written under their temporary names and their modes are checked.
    let prepared = prepare_role_file(directory, tab, id, text, ko)?;
    let generation = match &earlier {
        Some(record) if record.generation >= 1 => record.generation + 1,
        _ => 1,
    };
    let record = json!({"id": id, "generation": generation, "fingerprint": fingerprint, "confirmedFingerprint": null});
    // Step 2: the record is stored in projects.json; a failure removes the temporary files and stores nothing.
    store_tab_role(&registry, tab, Some(&record))?;
    // Step 3: the temporary files are renamed; a failure restores the earlier record, and a restore that also fails reports
    // both errors.
    if let Err(e) = prepared.commit() {
        let earlier_value = match &earlier {
            Some(_) => Value::Object(earlier_record(found.entry)),
            None => Value::Null,
        };
        if let Err(restore) = store_tab_role(&registry, tab, Some(&earlier_value)) {
            return Err(format!(
                "{e}; projects.json {}: restore failed: {restore}",
                registry.display()
            ));
        }
        return Err(e);
    }
    *state.seq.entry(tab.to_string()).or_insert(0) += 1;
    Ok(answer_of(
        directory,
        state,
        tab,
        Some(&RoleRecord {
            id,
            generation,
            fingerprint: &fingerprint,
            confirmed: None,
        }),
    ))
}

/// Answers the stored record of the member role of a tab entry as a JSON object, unchanged.
fn earlier_record(entry: &Map<String, Value>) -> Map<String, Value> {
    match entry.get("role").and_then(Value::as_object) {
        Some(record) => record.clone(),
        None => Map::new(),
    }
}

/// Removes the role of a tab: the record is stored as null first, then the folder of the role files of the surface is
/// removed, so a tab whose record is null holds no role file.
fn role_clear(directory: &Path, state: &mut RoleState, tab: &str) -> Result<Value, String> {
    let registry = directory.join("projects.json");
    let projects = checked_projects(&registry)?;
    let Some(found) = find_tab_role(&projects, tab) else {
        return Err(format!("surface {tab:?} has no tab"));
    };
    checked_tab_role(&registry, found.root, found.space, tab, found.entry)?;
    store_tab_role(&registry, tab, None)?;
    let folder = directory.join("agents").join(tab);
    std::fs::remove_dir_all(&folder).map_err(|e| write_failed(&folder, &e.to_string()))?;
    *state.seq.entry(tab.to_string()).or_insert(0) += 1;
    Ok(answer_of(directory, state, tab, None))
}

/// Judges a confirmed fingerprint against the state of the tab at its turn: the current fingerprint in state pending stores
/// the confirmation and gives ready, in state ready it changes nothing, and an earlier fingerprint is refused as stale with
/// the path of the current role file (docs/spec/agent-roles.md#confirmation).
pub fn role_confirm(
    directory: &Path,
    state: &mut RoleState,
    tab: &str,
    fingerprint: &str,
) -> Result<Value, String> {
    if !fingerprint_holds(fingerprint) {
        return Err(format!(
            "fingerprint {fingerprint} is not 16 lowercase hexadecimal characters"
        ));
    }
    if state.removed.contains(tab) {
        return Err(format!("tab {tab} has no role"));
    }
    let registry = directory.join("projects.json");
    let projects = checked_projects(&registry)?;
    let Some(found) = find_tab_role(&projects, tab) else {
        return Err(format!("surface {tab:?} has no tab"));
    };
    let Some(record) = checked_tab_role(&registry, found.root, found.space, tab, found.entry)?
    else {
        return Err(format!("tab {tab} has no role"));
    };
    if record.confirmed == Some(fingerprint) {
        return Ok(answer_of(directory, state, tab, Some(&record)));
    }
    if fingerprint != record.fingerprint {
        return Err(format!(
            "stale fingerprint: read the role file again at {}",
            role_path(directory, tab).display()
        ));
    }
    let stored = json!({"id": record.id, "generation": record.generation,
        "fingerprint": record.fingerprint, "confirmedFingerprint": fingerprint});
    store_tab_role(&registry, tab, Some(&stored))?;
    *state.seq.entry(tab.to_string()).or_insert(0) += 1;
    Ok(answer_of(
        directory,
        state,
        tab,
        Some(&RoleRecord {
            id: record.id,
            generation: record.generation,
            fingerprint: record.fingerprint,
            confirmed: Some(fingerprint),
        }),
    ))
}

/// Ends the role of a tab that left the layout: the folder of its role files is removed and every later role operation of
/// that tab is refused (docs/spec/agent-roles.md#role-file, lifecycle).
pub fn role_remove(directory: &Path, state: &mut RoleState, tab: &str) -> Result<(), String> {
    state.removed.insert(tab.to_string());
    state.seq.remove(tab);
    let folder = directory.join("agents").join(tab);
    std::fs::remove_dir_all(&folder).map_err(|e| write_failed(&folder, &e.to_string()))?;
    Ok(())
}

/// Stores the member role of the tab, as the whole record or null, and writes projects.json. The file is read again, so a
/// change of another writer between the read and this write is kept.
fn store_tab_role(registry: &Path, tab: &str, role: Option<&Value>) -> Result<(), String> {
    let mut projects = checked_projects(registry)?;
    let entry = projects
        .iter_mut()
        .filter_map(|project| project["spaces"].as_array_mut())
        .flatten()
        .filter_map(|held| held["layout"]["state"].as_object_mut())
        .find_map(|state| tab_entry_mut(&mut state["root"], tab))
        .ok_or_else(|| write_failed(registry, &format!("tab {tab} is gone")))?;
    let stored = match role {
        Some(held) => held.clone(),
        None => Value::Null,
    };
    entry.insert("role".to_string(), stored);
    write_projects(registry, &projects).map_err(|e| write_failed(registry, &e))
}

/// Returns the tab record of the tab id in the tree of a layout state as a mutable reference.
fn tab_entry_mut<'a>(node: &'a mut Value, tab: &str) -> Option<&'a mut Map<String, Value>> {
    let Some(holder) = node.as_object_mut() else {
        return None;
    };
    if holder.contains_key("card") {
        let tabs = holder.get_mut("data")?.get_mut("tabs")?.as_array_mut()?;
        return tabs
            .iter_mut()
            .find(|entry| entry["id"].as_str() == Some(tab))
            .and_then(Value::as_object_mut);
    }
    if holder.contains_key("box") {
        let inner = holder.get_mut("inner")?;
        return tab_entry_mut(inner, tab);
    }
    let kids = holder.get_mut("kids")?.as_array_mut()?;
    for kid in kids {
        if let Some(found) = tab_entry_mut(kid.get_mut("node")?, tab) {
            return Some(found);
        }
    }
    None
}
