package tests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// TestTheSchemaTextMatchesEachCaseOfTheSubset replays docs/spec/cases/schema-subset.json, which the reader and the Rust matcher also
// replay: MatchesSchemaText matches each value against its schema exactly when the case says so.
func TestTheSchemaTextMatchesEachCaseOfTheSubset(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "schema-subset.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			ID      string          `json:"id"`
			Schema  json.RawMessage `json:"schema"`
			Value   json.RawMessage `json:"value"`
			Matches bool            `json:"matches"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the schema subset case table holds no case")
	}
	for _, c := range table.Cases {
		got, err := sok.MatchesSchemaText(c.Schema, c.Value)
		if err != nil || got != c.Matches {
			t.Errorf("%s: MatchesSchemaText(%s, %s) = %v, %v; want %v", c.ID, c.Schema, c.Value, got, err, c.Matches)
		}
	}
}
