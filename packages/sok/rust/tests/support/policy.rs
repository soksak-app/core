//! Shared precondition of the tests of the tool's events (docs/spec/logging.md#policy-file).

use std::path::Path;

/// Writes the policy file of the configuration directory that stores every level of every class. The default policy stores only
/// errors, so a test that checks an event below error gives the tool this file before the tool starts; the tool applies the file
/// once at its start and records the policy with the event `log.policy`.
pub fn store_every_level(config: &Path) {
    std::fs::write(
        config.join("log-policy.json"),
        r#"{"schema":1,"classes":{"lifecycle":"trace","input":"trace","call":"trace","io":"trace","frame":"trace"}}"#,
    )
    .unwrap();
}
