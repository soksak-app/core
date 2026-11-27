use serde_json::{Value, json};

use super::validate_manifest;

/// A valid view plugin that declares accounts whose three programs run the program run.
fn accounts_manifest() -> Value {
    json!({
        "id": "probe",
        "name": "Probe",
        "description": "Sample.",
        "surface": {"composition": {"kind": "view", "page": "ui/page.html"}},
        "mark": "P",
        "icon": "<svg></svg>",
        "programs": {"run": {"program": "git", "args": [{"pattern": "[a-z]+"}, {"pattern": "[a-z]+"}]}},
        "accounts": {
            "kinds": [{"value": "claude", "label": "Claude"}],
            "programs": {"status": "run", "login": "run", "logout": "run"}
        }
    })
}

// contract: install.plugin-accounts
// Accounts whose programs name a declaration that the manifest lacks are refused with the reason that the programs declaration is missing.
#[test]
fn accounts_without_a_programs_declaration_are_refused() {
    let mut manifest = accounts_manifest();
    manifest.as_object_mut().unwrap().remove("programs");
    let error = validate_manifest(&manifest).unwrap_err();
    assert_eq!(
        error, "plugin probe: accounts need a programs declaration",
        "error = {error}"
    );
}
