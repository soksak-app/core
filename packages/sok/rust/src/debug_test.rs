use super::*;

// A number outside the range of float64 is refused as a line that is not JSON. The message never shows `undefined` in place of
// the number, and the Go host refuses the same line with the same message.
// contract: debug.rows.out-of-range-number-is-refused
#[test]
fn an_out_of_range_number_is_refused_as_not_json() {
    let raw = r#"{"ts_us":1e400,"seq":1}"#;
    let error = row_of("events.jsonl", 3, raw)
        .err()
        .expect("a number out of range is refused");
    assert_eq!(error, format!("events.jsonl:3: not JSON: {raw}"));
}
