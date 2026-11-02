//! The stored level of each class (docs/spec/native-surfaces.md#view-surfaces), the start value `levels` of a view. The same case
//! runs in the Go host.

use serde_json::json;

use super::{LogPolicy, levels_from};

// contract: view.start-values.levels
#[test]
fn the_levels_name_the_least_severe_stored_level_of_each_class() {
    let policy = LogPolicy::parse(
        "probe.json",
        br#"{"schema":1,"classes":{"lifecycle":"off","input":"warn","call":"error","io":"info","frame":"debug"}}"#,
    )
    .expect("the policy has its form");
    assert_eq!(
        serde_json::Value::Object(levels_from(|class, level| policy.allows(class, level))),
        json!({"lifecycle": "off", "input": "warn", "call": "error", "io": "info", "frame": "debug"})
    );
    assert_eq!(
        serde_json::Value::Object(levels_from(|_, _| true)),
        json!({"lifecycle": "trace", "input": "trace", "call": "trace", "io": "trace", "frame": "trace"}),
        "without a writer every gate is open"
    );
}
