package workbench_test

import (
	"math"
	"testing"
)

// The value in a refusal is the JSON text that the web workbench and the hosts write, which does not escape <, > and &.
func TestARefusedValueIsWrittenAsJSONWithoutHTMLEscapes(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	err := store.Set(map[string]any{"projectsFolder": "<a> & b"}, "common")
	if want := `Invalid setting projectsFolder: "<a> & b" is not an absolute path or a path that starts with ~/`; err == nil || err.Error() != want {
		t.Fatalf("Set = %v, want %s", err, want)
	}
}

// A refused value that JSON cannot write is reported with the encoding error; no text stands in for the value.
func TestARefusedValueThatJSONCannotWriteReportsTheEncodingError(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"projectsFolder", "memorySaver", "textSize", "memorySaverDelay"} {
		err := store.Set(map[string]any{key: math.NaN()}, "common")
		if want := "Invalid setting " + key + ": json: unsupported value: NaN"; err == nil || err.Error() != want {
			t.Errorf("Set(%s NaN) = %v, want %s", key, err, want)
		}
	}
	if len(writes) != 0 {
		t.Fatalf("a refused change was written %d times", len(writes))
	}
}
