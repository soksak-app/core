//! Replays every case of the version range table (docs/spec/cases/version-ranges.json) through the range reader of sok.

use serde::Deserialize;
use soksak_sok::install;

/// One case of `contains`: whether the range contains the version.
#[derive(Deserialize)]
struct ContainsCase {
    range: String,
    version: String,
    inside: bool,
}

/// The version range table of docs/spec/cases, which no package owns.
#[derive(Deserialize)]
struct RangeCases {
    contains: Vec<ContainsCase>,
    refused: Vec<String>,
}

fn range_cases() -> RangeCases {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/version-ranges.json"
    );
    let text = std::fs::read_to_string(path).expect("version range case table");
    let table: RangeCases = serde_json::from_str(&text).expect("version range case table JSON");
    assert!(
        !table.contains.is_empty() && !table.refused.is_empty(),
        "the version range case table holds no case"
    );
    table
}

// contract: install.version.ranges-and-order
#[test]
fn a_range_reads_the_version_range_case_table() {
    let table = range_cases();
    let mut failures = vec![];
    for case in &table.contains {
        let got = install::satisfies(&case.version, &case.range);
        if got != case.inside {
            failures.push(format!(
                "range {:?} contains {}: {got}, want {}",
                case.range, case.version, case.inside
            ));
        }
    }
    for text in &table.refused {
        match install::parse_range(text) {
            Err(error) if error.contains("invalid version") => {}
            other => failures.push(format!(
                "range {text:?}: {other:?}, want an invalid version error"
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
