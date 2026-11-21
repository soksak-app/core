//! Replays docs/spec/cases/schema-subset.json, which the reader and the Go matcher also replay: matches_schema
//! matches each value against its schema exactly when the case says so.

use serde_json::Value;

// contract: cli.command.schema-subset-matcher
#[test]
fn the_schema_matcher_matches_each_case_of_the_subset() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/schema-subset.json"
    );
    let text = std::fs::read_to_string(path).expect("schema subset case table");
    let table: Value = serde_json::from_str(&text).expect("schema subset case table JSON");
    let cases = table["cases"].as_array().expect("schema subset cases");
    assert!(
        !cases.is_empty(),
        "the schema subset case table holds no case"
    );
    let mut failed = vec![];
    for case in cases {
        let schema = case["schema"].as_object().expect("a schema object");
        let want = case["matches"].as_bool().expect("matches");
        if soksak_sok::matches_schema(schema, &case["value"]) != want {
            failed.push(case["id"].as_str().expect("id").to_string());
        }
    }
    assert!(
        failed.is_empty(),
        "the cases {failed:?} do not match as the table says"
    );
}
