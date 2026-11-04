package sok

import "testing"

// A number outside the range of float64 is refused as a line that is not JSON, as the Rust host refuses it. The message
// never shows `undefined` in place of the number.
// contract: debug.rows.out-of-range-number-is-refused
func TestAnOutOfRangeNumberIsRefusedAsNotJSON(t *testing.T) {
	raw := `{"ts_us":1e400,"seq":1}`
	_, err := rowOf("events.jsonl", 3, raw)
	if err == nil {
		t.Fatal("rowOf accepted a number out of the range of float64")
	}
	if want := "events.jsonl:3: not JSON: " + raw; err.Error() != want {
		t.Fatalf("rowOf error %q, want %q", err, want)
	}
}
