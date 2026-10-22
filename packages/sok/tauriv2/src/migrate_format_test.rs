use super::*;

// A format number cannot be read when the definitions cannot be parsed: the parse error reaches the caller, so no format number
// is written for a file whose definitions are broken.
// contract: install.migration.format-without-definitions-is-an-error
#[test]
fn a_format_without_parsable_definitions_is_an_error() {
    let broken = [("migrations/projects.json", "not json")];
    let error = match parse_definitions(&broken) {
        Ok(_) => panic!("broken definitions are refused"),
        Err(error) => error,
    };
    assert!(
        error.contains("migrations/projects.json is not valid JSON"),
        "{error}"
    );
}

// A file without a chain has no current format, so its format is an error and no number is stamped.
// contract: install.migration.format-without-definitions-is-an-error
#[test]
fn a_file_without_a_chain_has_no_format() {
    let definitions = parse_definitions(&[]).expect("an empty set parses");
    let error = match format_of(PROJECTS, &definitions) {
        Ok(format) => panic!("a file without a chain has the format {format}"),
        Err(error) => error,
    };
    assert!(error.contains("hold no chain for projects.json"), "{error}");
}
