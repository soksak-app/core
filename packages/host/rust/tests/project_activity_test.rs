//! The record of the activities of the projects of the application meets the shared cases `records` of
//! docs/spec/cases/activity.json (docs/spec/activity.md#activity-of-a-project).

use serde_json::Value;
use soksak_host::project_activity::{ProjectActivities, SpaceActivity};
use std::collections::BTreeMap;

// contract: project-activity.record.cases
#[test]
fn the_project_activity_record_meets_each_case() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/activity.json"
    );
    let text = std::fs::read_to_string(path).expect("activity.json is readable");
    let file: Value = serde_json::from_str(&text).expect("activity.json is JSON");
    let cases = file["records"].as_array().expect("records is a list");
    assert!(!cases.is_empty(), "activity.json holds no case of records");
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("a case has a name");
        let record = ProjectActivities::default();
        for (index, step) in case["steps"]
            .as_array()
            .expect("a case has steps")
            .iter()
            .enumerate()
        {
            let error = if let Some(publish) = step.get("publish") {
                let spaces: BTreeMap<String, SpaceActivity> =
                    serde_json::from_value(publish["spaces"].clone()).expect("spaces of a step");
                record
                    .publish(
                        publish["window"].as_str().expect("a window"),
                        publish["owner"].as_str(),
                        publish["id"].as_str().expect("an id"),
                        spaces,
                    )
                    .err()
            } else if let Some(release) = step.get("release") {
                record.release(release["id"].as_str().expect("an id"));
                None
            } else {
                record.end(step["end"]["window"].as_str().expect("a window"));
                None
            };
            let want = step["error"].as_str().map(str::to_string);
            if error != want {
                failures.push(format!(
                    "{name}, step {index}: error {error:?}, want {want:?}"
                ));
            }
            let got = serde_json::to_value(record.record()).expect("the record serializes");
            if got != step["record"] {
                failures.push(format!(
                    "{name}, step {index}: record {got}, want {}",
                    step["record"]
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
