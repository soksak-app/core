use serde_json::{Value, json};

use super::validate_manifest;

/// A valid view plugin whose programs member holds one entry with the given pattern.
fn programs_manifest(pattern: &str) -> Value {
    json!({
        "id": "probe",
        "name": "Probe",
        "description": "Sample.",
        "surface": {"composition": {"kind": "view", "page": "ui/page.html"}},
        "mark": "P",
        "icon": "<svg></svg>",
        "programs": {"run": {"program": "git", "args": [{"pattern": pattern}]}}
    })
}

// contract: install.plugin-program-pattern
// A pattern that the regular expression library does not compile is refused at install (docs/spec/plugins.md#pluginjson).
#[test]
fn program_pattern_that_does_not_compile_is_refused() {
    let error = validate_manifest(&programs_manifest("(")).unwrap_err();
    assert!(
        error.starts_with("plugin probe: programs.run pattern does not compile: "),
        "error = {error}"
    );
}

// contract: install.plugin-program-pattern
#[test]
fn program_pattern_that_compiles_is_accepted() {
    validate_manifest(&programs_manifest("[a-z]+")).unwrap();
}
