use serde_json::{Value, json};

use super::{PLUGIN_CATEGORIES, validate_manifest};

/// A valid view plugin with the given members added.
fn view_with(members: Value) -> Value {
    let mut manifest = json!({
        "id": "probe",
        "name": "Probe",
        "description": "Sample.",
        "surface": {"composition": {"kind": "view", "page": "ui/page.html"}},
        "mark": "P",
        "icon": "<svg></svg>"
    });
    for (key, value) in members.as_object().expect("members") {
        manifest[key.as_str()] = value.clone();
    }
    manifest
}

/// A valid plugin with sections and no surface, with the given members added.
fn sections_with(members: Value) -> Value {
    let mut manifest = json!({
        "id": "probe",
        "name": "Probe",
        "description": "Sample.",
        "sections": [{"id": "probe.a", "name": "A", "composition": {"kind": "view", "page": "ui/page.html"}, "height": "fill"}]
    });
    for (key, value) in members.as_object().expect("members") {
        manifest[key.as_str()] = value.clone();
    }
    manifest
}

/// The plugin categories of core are the list of the case file docs/spec/cases/plugin-categories.json.
// contract: plugins.category.case-file-lists-the-categories
#[test]
fn plugin_categories_are_the_list_of_the_case_file() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/plugin-categories.json"
    ))
    .expect("plugin-categories.json");
    let case: Value = serde_json::from_str(&text).expect("valid JSON");
    let listed: Vec<String> = case["categories"]
        .as_array()
        .expect("categories")
        .iter()
        .map(|item| item.as_str().expect("category").to_string())
        .collect();
    let constant: Vec<String> = PLUGIN_CATEGORIES
        .iter()
        .map(|item| item.to_string())
        .collect();
    assert_eq!(constant, listed);
}

// contract: plugins.manifest.accepts-categories-and-requires
#[test]
fn categories_and_requires_that_are_valid_are_accepted() {
    validate_manifest(&view_with(json!({"categories": ["terminal"]}))).unwrap();
    validate_manifest(&sections_with(json!({"requires": ["terminal"]}))).unwrap();
}

// contract: plugins.manifest.refuses-invalid-categories-and-requires
#[test]
fn categories_and_requires_refuse_each_invalid_value_with_its_reason() {
    let cases = [
        (
            view_with(json!({"categories": "terminal"})),
            "plugin probe: categories must be a list of plugin categories",
        ),
        (
            view_with(json!({"categories": ["shell"]})),
            "plugin probe: categories category shell is not a plugin category of core",
        ),
        (
            view_with(json!({"categories": ["terminal", "terminal"]})),
            "plugin probe: categories category terminal repeats",
        ),
        (
            sections_with(json!({"categories": ["terminal"]})),
            "plugin probe: categories require a surface",
        ),
        (
            view_with(json!({"requires": "terminal"})),
            "plugin probe: requires must be a list of plugin categories",
        ),
        (
            view_with(json!({"requires": ["shell"]})),
            "plugin probe: requires category shell is not a plugin category of core",
        ),
        (
            view_with(json!({"requires": ["terminal", "terminal"]})),
            "plugin probe: requires category terminal repeats",
        ),
        (
            view_with(json!({"categories": ["terminal"], "requires": ["terminal"]})),
            "plugin probe: requires category terminal is in categories",
        ),
        (
            json!({"id": "probe", "name": "Probe", "description": "Sample.", "requires": ["terminal"]}),
            "plugin probe: requires require a surface or sections",
        ),
    ];
    for (manifest, want) in cases {
        assert_eq!(validate_manifest(&manifest).unwrap_err(), want);
    }
}

// contract: plugins.setting.accepts-a-plugin-category
#[test]
fn plugin_setting_accepts_a_category_of_core_with_label_and_description() {
    let manifest = view_with(json!({"settings": {"shell": {
        "type": "plugin",
        "category": "terminal",
        "label": "Shell",
        "description": "The terminal plugin that runs the shell."
    }}}));
    validate_manifest(&manifest).unwrap();
}

// contract: plugins.setting.refuses-a-default-or-unknown-category
#[test]
fn plugin_setting_refuses_an_unknown_category_a_default_and_an_unknown_type() {
    let unknown = view_with(json!({"settings": {"shell": {
        "type": "plugin", "category": "shell", "label": "Shell", "description": "Sample."
    }}}));
    assert_eq!(
        validate_manifest(&unknown).unwrap_err(),
        "plugin probe.shell: category shell is not a plugin category of core"
    );
    let with_default = view_with(json!({"settings": {"shell": {
        "type": "plugin", "category": "terminal", "default": "x", "label": "Shell", "description": "Sample."
    }}}));
    assert_eq!(
        validate_manifest(&with_default).unwrap_err(),
        "plugin probe.shell: unknown field default"
    );
    let unknown_type = view_with(json!({"settings": {"x": {
        "type": "shape", "label": "X", "description": "Sample."
    }}}));
    assert_eq!(
        validate_manifest(&unknown_type).unwrap_err(),
        "plugin probe.x: setting type must be enum, integer, string, address, or plugin"
    );
}
