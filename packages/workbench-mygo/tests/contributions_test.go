package workbench_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The Go resolution gives the items of each published contribution case.
func TestContributionCases(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("testdata", "contributions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			ID        string                      `json:"id"`
			Installed []workbench.InstalledPlugin `json:"installed"`
			Output    []map[string]any            `json:"output"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) != 8 {
		t.Fatalf("the contract has %d cases", len(file.Cases))
	}
	for _, kase := range file.Cases {
		t.Run(kase.ID, func(t *testing.T) {
			resolved, err := workbench.ResolveContributions(kase.Installed)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(resolved)
			if err != nil {
				t.Fatal(err)
			}
			got := []map[string]any{}
			if err := json.Unmarshal(encoded, &got); err != nil {
				t.Fatal(err)
			}
			if len(kase.Output) != 0 || len(got) != 0 {
				if !reflect.DeepEqual(got, kase.Output) {
					t.Fatalf("resolved %s, want %v", encoded, kase.Output)
				}
			}
		})
	}
}

// contributed is an installed provider of the point list and a contributor of two items.
func contributed(t *testing.T) []workbench.InstalledPlugin {
	t.Helper()
	var installed []workbench.InstalledPlugin
	err := json.Unmarshal([]byte(`[
		{"id": "probe", "package": "@scope/plugin-probe", "version": "0.1.0", "folder": "/installed/probe", "manifest": {
			"extends": {"list": {"version": "1.0.0", "schema": {"type": "object", "properties": {"label": {"type": "string"}}}}}}},
		{"id": "tidy", "package": "@scope/plugin-tidy", "version": "0.0.1", "folder": "/installed/tidy", "manifest": {
			"contributes": {"probe.list": [
				{"range": "^1.0.0", "module": "ui/a.js", "label": "first"},
				{"range": "^1.0.0", "module": "ui/b.js", "label": "second"}]}}}]`), &installed)
	if err != nil {
		t.Fatal(err)
	}
	return installed
}

// The provider draws its connected items. An item that fails leaves the provider, its state tells why, and the status keeps it.
func TestAFailedContributionLeavesTheProvider(t *testing.T) {
	contributions := workbench.NewContributions()
	changes := 0
	contributions.OnChange(func() { changes++ })
	if err := contributions.Install(contributed(t)); err != nil {
		t.Fatal(err)
	}
	var items []workbench.ConnectedItem
	tester := ui.NewTester(func(c *ui.Context) {
		var err error
		items, err = contributions.Of("probe", "list")
		if err != nil {
			t.Fatal(err)
		}
		ui.Column(c).Children(func() {
			for _, item := range items {
				ui.Text(c, fmt.Sprint(item.Item["label"]))
			}
		})
	}, 200, 100)
	tester.Frame()
	if !tester.HasText("first") || !tester.HasText("second") {
		t.Fatalf("the provider shows %q", tester.Texts())
	}
	if items[0].Module != "/modules/@scope/plugin-tidy/ui/a.js" || items[0].Folder != "/installed/tidy" || items[1].Index != 1 || items[1].Plugin != "tidy" {
		t.Fatalf("the items are %+v", items)
	}

	items[0].Fail(fmt.Errorf("the module has no export"))
	tester.Frame()
	if tester.HasText("first") || !tester.HasText("second") {
		t.Fatalf("after the failure the provider shows %q", tester.Texts())
	}
	if changes != 1 {
		t.Fatalf("the failure reported %d changes", changes)
	}
	status, err := json.Marshal(contributions.Status())
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"plugin":"tidy","point":"probe.list","index":0,"state":"invalid","reason":"extend failed: the module has no export"},` +
		`{"plugin":"tidy","point":"probe.list","index":1,"state":"connected","reason":null}]`
	if string(status) != want {
		t.Fatalf("the status is %s, want %s", status, want)
	}
}

// A point that the provider does not declare is an error.
func TestContributionsOfAnUndeclaredPointFail(t *testing.T) {
	contributions := workbench.NewContributions()
	if err := contributions.Install(contributed(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := contributions.Of("probe", "other"); err == nil || err.Error() != "extension point other is not declared by probe" {
		t.Fatalf("the read failed with %v", err)
	}
}

// Before the page loads the status is an empty list, not null.
func TestContributionStatusStartsEmpty(t *testing.T) {
	status, err := json.Marshal(workbench.NewContributions().Status())
	if err != nil {
		t.Fatal(err)
	}
	if string(status) != "[]" {
		t.Fatalf("the status is %s", status)
	}
}

func TestTheContributionsHaveAStatus(t *testing.T) {
	f := openedShell(t)
	if got := status[[]map[string]any](t, f, "core.contributions"); got == nil {
		t.Fatal("no status")
	}
}

// An item that does not match the schema of its extension point is invalid in the status of the installed plugins, with the reason of
// the reader, and the valid item of the same plugin stays connected (docs/spec/plugins.md#extension-points).
func TestAnItemThatMismatchesItsSchemaIsInvalidInTheStatus(t *testing.T) {
	var installed []workbench.InstalledPlugin
	err := json.Unmarshal([]byte(`[
		{"id": "probe", "package": "@scope/plugin-probe", "version": "0.1.0", "folder": "/installed/probe", "manifest": {
			"extends": {"list": {"version": "1.0.0", "schema": {"type": "object", "properties": {"label": {"type": "string"}}}}}}},
		{"id": "tidy", "package": "@scope/plugin-tidy", "version": "0.0.1", "folder": "/installed/tidy", "manifest": {
			"contributes": {"probe.list": [
				{"range": "^1.0.0", "module": "ui/a.js", "label": 5},
				{"range": "^1.0.0", "module": "ui/b.js", "label": "second"}]}}}]`), &installed)
	if err != nil {
		t.Fatal(err)
	}
	contributions := workbench.NewContributions()
	if err := contributions.Install(installed); err != nil {
		t.Fatal(err)
	}
	status, err := json.Marshal(contributions.Status())
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"plugin":"tidy","point":"probe.list","index":0,"state":"invalid","reason":"item does not match the schema of probe.list"},` +
		`{"plugin":"tidy","point":"probe.list","index":1,"state":"connected","reason":null}]`
	if string(status) != want {
		t.Fatalf("the status is %s, want %s", status, want)
	}
}
