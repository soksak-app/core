package tests

// Replays every case of the version range table (docs/spec/cases/version-ranges.json) through the range reader of sok.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
)

// rangeCases is the version range table of docs/spec/cases, which no package owns.
type rangeCases struct {
	Contains []struct {
		Range   string `json:"range"`
		Version string `json:"version"`
		Inside  bool   `json:"inside"`
	} `json:"contains"`
	Refused []string `json:"refused"`
}

func readRangeCases(t *testing.T) rangeCases {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "version-ranges.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table rangeCases
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Contains) == 0 || len(table.Refused) == 0 {
		t.Fatal("the version range case table holds no case")
	}
	return table
}

// contract: install.version.ranges-and-order
func TestARangeReadsTheVersionRangeCaseTable(t *testing.T) {
	table := readRangeCases(t)
	for _, c := range table.Contains {
		if got := sok.Satisfies(c.Version, c.Range); got != c.Inside {
			t.Errorf("range %q contains %s: %v, want %v", c.Range, c.Version, got, c.Inside)
		}
	}
	for _, text := range table.Refused {
		if _, err := sok.ParseRange(text); err == nil || !strings.Contains(err.Error(), "invalid version") {
			t.Errorf("range %q: %v, want an invalid version error", text, err)
		}
	}
}
