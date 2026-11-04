package workbench_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

// retained reads the surfaces of each sidecarsRetain call of the host.
func retained(t *testing.T, stored *storedHost) [][]string {
	t.Helper()
	var calls [][]string
	for _, raw := range stored.retains {
		var request struct {
			Surfaces []struct{ Surface, Root string }
		}
		if err := json.Unmarshal(raw, &request); err != nil {
			t.Fatal(err)
		}
		surfaces := []string{}
		for _, item := range request.Surfaces {
			surfaces = append(surfaces, item.Root+" "+item.Surface)
		}
		calls = append(calls, surfaces)
	}
	return calls
}

func TestTheStartOfAWindowRetainsTheSessionsOfTheLayouts(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}}
	newTabShell(t, stored)
	equal(t, retained(t, stored), [][]string{{"/a tab-aaaaaa", "/a tab-bbbbbb"}})
}

func TestAClosedTabLeavesTheRetainedSessionsAfterTheLayoutIsStored(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.retains = nil
	if _, err := f.shell.Registry().Run("core.tab.close", json.RawMessage(`{"tab":"tab-bbbbbb"}`)); err != nil {
		t.Fatal(err)
	}
	f.settle()
	equal(t, retained(t, stored), [][]string{{"/a tab-aaaaaa"}})
}

func TestARefusedLayoutWriteKeepsTheSessions(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.retains = nil
	stored.failing = map[string]error{"workspace": errors.New("the disk refused")}
	if _, err := f.shell.Registry().Run("core.tab.close", json.RawMessage(`{"tab":"tab-bbbbbb"}`)); err != nil {
		t.Fatal(err)
	}
	f.pending.drain(t)
	equal(t, retained(t, stored), [][]string(nil))
}

func TestARemovedProjectLeavesTheRetainedSessions(t *testing.T) {
	other := storedProject(tab("tab-cccccc", "notes"))
	other["id"], other["root"], other["identity"] = "prj-b", "/b", "identity of /b"
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes")), other}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.retains = nil
	f.shell.Registry().Run("core.library.remove", json.RawMessage(`{"id":"prj-a"}`))
	f.settle()
	calls := retained(t, stored)
	if len(calls) == 0 || strings.Join(calls[len(calls)-1], ",") != "/b tab-cccccc" {
		t.Fatalf("retained %v", calls)
	}
}

func TestTheSectionsOfTheShownProjectAreRetained(t *testing.T) {
	stored := &storedHost{installed: sidebarsInstalled, projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}}
	f := newShell(t, stored)
	f.run("core.project.activate", map[string]string{"id": "prj-a"})
	stored.retains = nil
	f.run("core.tab.close", map[string]string{"tab": "tab-bbbbbb"})
	f.settle()
	calls := retained(t, stored)
	if len(calls) != 1 || !strings.Contains(strings.Join(calls[0], ","), "/a spc-aaaaaa/left/files.tree") {
		t.Fatalf("retained %v", calls)
	}
}

func TestAFailedRetainIsShown(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.failing = map[string]error{"sidecarsRetain": errors.New("sidecar vt: retain was not answered within 10s")}
	if _, err := f.shell.Registry().Run("core.tab.close", json.RawMessage(`{"tab":"tab-bbbbbb"}`)); err != nil {
		t.Fatal(err)
	}
	f.pending.drain(t)
	shown, err := f.shell.Registry().Read("core.page.error")
	if err != nil {
		t.Fatal(err)
	}
	if text, ok := shown.(*string); !ok || text == nil || !strings.Contains(*text, "retain was not answered") {
		t.Fatalf("the status core.page.error is %v", shown)
	}
}

func TestTheStartRemovesTheStoredEntriesOfSurfacesInNoLayout(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))},
		sessionTabs: []string{"spc-aaaaaa/left/files.tree", "spc-gone/left/files.tree", "tab-aaaaaa", "tab-gone"},
		tabState:    map[string]any{"format": 1, "tabs": map[string]any{"tab-aaaaaa": map[string]any{"kept": true}, "tab-gone": map[string]any{"kept": true}}}}
	f := newTabShell(t, stored)
	slices.Sort(f.sessionPuts)
	equal(t, f.sessionPuts, []string{"spc-gone/left/files.tree", "tab-gone"})
	f.timers.tick(1000)
	f.settle()
	equal(t, f.keptPuts, []string{`{"entry":null,"kind":"tabStatePut","tab":"tab-gone"}`})
}

func TestAStoredLayoutThatCannotBeReadKeepsTheStoredEntries(t *testing.T) {
	broken := storedProject(tab("tab-aaaaaa", "notes"))
	broken["spaces"].([]map[string]any)[0]["layout"] = map[string]any{"state": 5}
	stored := &storedHost{projects: []map[string]any{broken}, sessionTabs: []string{"tab-gone"}, startFails: true}
	f := newTabShell(t, stored)
	equal(t, f.sessionPuts, []string(nil))
	shown, err := f.shell.Registry().Read("core.page.error")
	if err != nil {
		t.Fatal(err)
	}
	if text, ok := shown.(*string); !ok || text == nil || !strings.Contains(*text, "space spc-aaaaaa") {
		t.Fatalf("the status core.page.error is %v", shown)
	}
}
