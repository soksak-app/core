package workbench_test

import (
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
