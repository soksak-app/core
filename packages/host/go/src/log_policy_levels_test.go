package host

// The stored level of each class (docs/spec/native-surfaces.md#view-surfaces), the start value levels of a view. The same case runs in
// the Tauri host.

import (
	"reflect"
	"testing"
)

// The levels name the least severe stored level of each class, and every class stores trace while no writer gates the host.
// contract: view.start-values.levels
func TestLevelsNameTheLeastSevereStoredLevelOfEachClass(t *testing.T) {
	policy, err := ParseLogPolicy("probe.json", []byte(`{"schema":1,"classes":{"lifecycle":"off","input":"warn","call":"error","io":"info","frame":"debug"}}`))
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	got := levelsFrom(policy.Allows)
	want := map[string]string{"lifecycle": "off", "input": "warn", "call": "error", "io": "info", "frame": "debug"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("levels %v, want %v", got, want)
	}
	open := levelsFrom(func(Class, Level) bool { return true })
	for _, class := range []string{"lifecycle", "input", "call", "io", "frame"} {
		if open[class] != "trace" {
			t.Fatalf("levels without a writer %v, want trace in every class", open)
		}
	}
}
