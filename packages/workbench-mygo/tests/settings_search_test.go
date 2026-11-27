package workbench_test

import (
	"bytes"
	"encoding/json"
	"os"
	"slices"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// searchCases is the cases file that the web host reads too (settings-search-cases.json). Each query matches the listed setting keys in
// the order of the declared table and then the plugin settings, the ids of the installed plugins, and the count of the catalog plugins,
// on both hosts (docs/spec/settings.md#search).
type searchCases struct {
	Cases []struct {
		Query    string   `json:"query"`
		Settings []string `json:"settings"`
		Plugins  []string `json:"plugins"`
		Catalog  int      `json:"catalog"`
	} `json:"cases"`
}

// readSearchAnswer reads the host answer of the fixture (plugin-host-answer.json) that the web host reads too. The installed document and
// the environment are the inputs of the shell at its start. The pluginsState answer is decoded as the host sends it, and its registry
// index is checked by sok.ValidateRegistryIndex, the reader of the index that the host uses.
func readSearchAnswer(t *testing.T) (installed, environment string, state map[string]any) {
	t.Helper()
	text, err := os.ReadFile("testdata/plugin-host-answer.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Installed    json.RawMessage `json:"installed"`
		Environment  json.RawMessage `json:"environment"`
		PluginsState json.RawMessage `json:"pluginsState"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(file.PluginsState))
	decoder.UseNumber()
	if err := decoder.Decode(&state); err != nil {
		t.Fatal(err)
	}
	index, err := sok.ValidateRegistryIndex(state["index"])
	if err != nil {
		t.Fatal(err)
	}
	state["index"] = index
	return string(file.Installed), string(file.Environment), state
}

// TestTheSearchResultsListTheSameRowsAsTheWebForEachCase finds each query of the cases file on the host answer of the fixture and compares
// the matched setting keys, plugin ids and catalog count of the results status with the cases file.
func TestTheSearchResultsListTheSameRowsAsTheWebForEachCase(t *testing.T) {
	text, err := os.ReadFile("testdata/settings-search-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases searchCases
	if err := json.Unmarshal(text, &cases); err != nil {
		t.Fatal(err)
	}
	installed, environment, state := readSearchAnswer(t)
	f := newShell(t, &storedHost{installed: installed, environment: []byte(environment), plugins: &pluginsHost{answer: state}})
	f.click("core.chrome.settings", "")
	for _, c := range cases.Cases {
		f.run("core.settings-tab.find", map[string]any{"query": c.Query})
		status := f.modal()
		if status.Results == nil {
			t.Fatalf("the results of %q are not shown", c.Query)
		}
		if !slices.Equal(status.Results.Settings, c.Settings) && !(len(c.Settings) == 0 && len(status.Results.Settings) == 0) {
			t.Fatalf("the query %q matches settings %q, want %q", c.Query, status.Results.Settings, c.Settings)
		}
		if !slices.Equal(status.Results.Plugins, c.Plugins) && !(len(c.Plugins) == 0 && len(status.Results.Plugins) == 0) {
			t.Fatalf("the query %q matches plugins %q, want %q", c.Query, status.Results.Plugins, c.Plugins)
		}
		if status.Results.Catalog != c.Catalog {
			t.Fatalf("the query %q matches %d catalog plugins, want %d", c.Query, status.Results.Catalog, c.Catalog)
		}
		// The drawn rows are the matched settings in the same order, each with its key.
		var drawn []string
		for _, row := range status.Rows {
			drawn = append(drawn, row.Key)
		}
		if !slices.Equal(drawn, c.Settings) && !(len(c.Settings) == 0 && len(drawn) == 0) {
			t.Fatalf("the query %q draws the rows %q, want %q", c.Query, drawn, c.Settings)
		}
		if c.Catalog > 0 {
			if _, ok := exposedNode(f.tester.ElementTree(), "core.settings-tab.browse-find", ""); !ok {
				t.Fatalf("the query %q shows no catalog card", c.Query)
			}
		}
		f.settle()
		if len(c.Settings) == 0 && len(c.Plugins) == 0 && c.Catalog == 0 && !f.tester.HasText("일치하는 설정이 없다.") {
			t.Fatalf("the query %q shows no empty result line", c.Query)
		}
	}
}
