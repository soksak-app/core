//! The record of the activities of the projects of the application, by project and not by window
//! (docs/spec/activity.md#activity-of-a-project). The Go host holds the same record, and both meet the cases `records` of
//! docs/spec/cases/activity.json.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, PoisonError};

/// The activities from the highest to the lowest (docs/spec/activity.md#activities).
const ACTIVITIES: [&str; 4] = ["attention", "running", "failed", "idle"];

/// The activity of a space of a project with those of its content cards and group cards by card identifier, as the window that
/// holds the project derives them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpaceActivity {
    pub activity: String,
    pub cards: BTreeMap<String, String>,
    pub groups: BTreeMap<String, String>,
}

/// The entry of a project in the record: its activity, the highest of its spaces, and its spaces.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProjectActivityState {
    pub activity: String,
    pub spaces: BTreeMap<String, SpaceActivity>,
}

/// The record `{revision, projects}`, which the event `project-activity` carries.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProjectActivityRecord {
    pub revision: u64,
    pub projects: BTreeMap<String, ProjectActivityState>,
}

/// The publication of the activities of the spaces of a project, the argument `request` of `project_activity`.
#[derive(Deserialize)]
pub struct ProjectActivityRequest {
    pub id: String,
    pub spaces: BTreeMap<String, SpaceActivity>,
}

#[derive(Default)]
struct Entries {
    revision: u64,
    /// The published projects by id: the window that published it and the activities of its spaces.
    projects: HashMap<String, (String, BTreeMap<String, SpaceActivity>)>,
}

/// The record of the activities of the projects of the application.
#[derive(Default)]
pub struct ProjectActivities {
    entries: Mutex<Entries>,
}

/// Refuses a value that is not an activity with the text of docs/spec/activity.md#activity-of-a-project.
fn check_activity(at: &str, value: &str) -> Result<(), String> {
    if ACTIVITIES.contains(&value) {
        return Ok(());
    }
    // default: a string always serializes.
    let text = serde_json::to_string(value).unwrap_or_default();
    Err(format!(
        "{at}: activity {text} is not one of {}",
        ACTIVITIES.join(", ")
    ))
}

fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

impl ProjectActivities {
    fn entries(&self) -> std::sync::MutexGuard<'_, Entries> {
        // default: the entries are replaced whole, and a panic while the lock is held leaves each entry whole, so the lock state is
        // recovered; the panic hook records the panic that poisoned the lock.
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sets the activities of the spaces of the project `id` that `window` publishes; `owner` is the window that holds the project,
    /// or none. Empty spaces withdraw the project. Returns whether the record changed, and refuses a publication without changing
    /// the record. The maps of the request are ordered, so the spaces, cards and groups are checked in code point order.
    pub fn publish(
        &self,
        window: &str,
        owner: Option<&str>,
        id: &str,
        spaces: BTreeMap<String, SpaceActivity>,
    ) -> Result<bool, String> {
        if !valid_project_id(id) {
            return Err("invalid project id".into());
        }
        if owner != Some(window) {
            return Err(format!("project {id} is not owned by this window"));
        }
        for (space, held) in &spaces {
            let at = format!("project {id} space {space}");
            check_activity(&at, &held.activity)?;
            for (card, activity) in &held.cards {
                check_activity(&format!("{at} card {card}"), activity)?;
            }
            for (card, activity) in &held.groups {
                check_activity(&format!("{at} group {card}"), activity)?;
            }
        }
        let mut entries = self.entries();
        if spaces.is_empty() {
            if entries.projects.remove(id).is_none() {
                return Ok(false);
            }
        } else {
            if entries
                .projects
                .get(id)
                .is_some_and(|(by, held)| by == window && *held == spaces)
            {
                return Ok(false);
            }
            entries
                .projects
                .insert(id.to_string(), (window.to_string(), spaces));
        }
        entries.revision += 1;
        Ok(true)
    }

    /// Removes the entry of the released project `id`, and returns whether the record changed.
    pub fn release(&self, id: &str) -> bool {
        let mut entries = self.entries();
        if entries.projects.remove(id).is_none() {
            return false;
        }
        entries.revision += 1;
        true
    }

    /// Removes the entries that `window` published, because its page or the window ended, and returns whether the record changed.
    pub fn end(&self, window: &str) -> bool {
        let mut entries = self.entries();
        let before = entries.projects.len();
        entries.projects.retain(|_, (by, _)| by != window);
        let ended = entries.projects.len() != before;
        if ended {
            entries.revision += 1;
        }
        ended
    }

    /// The record `{revision, projects}`; each project has the highest activity of its spaces.
    pub fn record(&self) -> ProjectActivityRecord {
        let entries = self.entries();
        let projects = entries
            .projects
            .iter()
            .map(|(id, (_, spaces))| {
                let activity = spaces
                    .values()
                    .map(|space| space.activity.as_str())
                    .min_by_key(|activity| ACTIVITIES.iter().position(|known| known == activity))
                    // default: a held project has at least one space, and each space holds an activity.
                    .unwrap_or_default()
                    .to_string();
                (
                    id.clone(),
                    ProjectActivityState {
                        activity,
                        spaces: spaces.clone(),
                    },
                )
            })
            .collect();
        ProjectActivityRecord {
            revision: entries.revision,
            projects,
        }
    }
}
