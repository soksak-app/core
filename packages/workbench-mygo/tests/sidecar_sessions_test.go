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

// A view of a removed project sends until the placement without it, so the sessions of the project end after that placement.
func TestARemovedProjectRetainsAfterThePlacementWithoutItsViews(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.calls, stored.retains = nil, nil
	f.shell.Registry().Run("core.library.remove", json.RawMessage(`{"id":"prj-a"}`))
	f.settle()
	retain := slices.Index(stored.calls, "sidecarsRetain")
	placement := slices.Index(stored.calls, "presentSurfaces")
	if retain < 0 || placement < 0 || retain < placement {
		t.Fatalf("calls %v", stored.calls)
	}
	equal(t, retained(t, stored), [][]string{{}})
}

// A removal ends after the retain that ends the sessions of the removed project answered, as projects.close of the page awaits the
// read that retains, so a request after the answer of the removal or of diagnostics.fixture finds those sessions ended.
func TestARemovalAnswersAfterTheRetainOfTheSessionsOfTheRemovedProject(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	hold := newGate()
	stored.mu.Lock()
	stored.retains, stored.holdRetains = nil, hold
	stored.mu.Unlock()
	answered := false
	f.shell.Registry().RunLater("core.library.remove", json.RawMessage(`{"id":"prj-a"}`), func(_ any, err error) {
		if err != nil {
			t.Errorf("core.library.remove failed: %v", err)
		}
		answered = true
	})
	f.settle()
	stored.mu.Lock()
	asked := len(stored.retains)
	stored.mu.Unlock()
	if asked == 0 {
		t.Fatal("the removal asked for no retain")
	}
	if answered {
		t.Fatal("core.library.remove answered before the host answered the retain of the sessions of the removed project")
	}
	hold.open()
	f.settle()
	if !answered {
		t.Fatal("core.library.remove did not answer after the retain answered")
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
	if len(calls) != 1 || !strings.Contains(strings.Join(calls[0], ","), "/a spc-aaaaaa/left/fieldprobe.tree") {
		t.Fatalf("retained %v", calls)
	}
}

// The host keeps the service of a surface that a layout holds, so each entry names the plugin that may hold a session there: the
// plugin of the tab, and the plugin that declares the section.
func TestARetainNamesThePluginOfEachSurface(t *testing.T) {
	stored := &storedHost{installed: sidebarsInstalled, projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	newShell(t, stored).run("core.project.activate", map[string]string{"id": "prj-a"})
	var request struct {
		Surfaces []struct{ Surface, Plugin string }
	}
	if err := json.Unmarshal(stored.retains[len(stored.retains)-1], &request); err != nil {
		t.Fatal(err)
	}
	plugins := map[string]string{}
	for _, item := range request.Surfaces {
		plugins[item.Surface] = item.Plugin
	}
	if plugins["tab-aaaaaa"] != "notes" || plugins["spc-aaaaaa/left/fieldprobe.tree"] != "fieldprobe" {
		t.Fatalf("retained %v", plugins)
	}
}

// A stored card that shows the installed set on its left.
func cardWithSidebar(project map[string]any) string {
	card := project["spaces"].([]map[string]any)[0]["layout"].(map[string]any)["state"].(map[string]any)["cards"].([]map[string]any)[0]
	card["data"].(map[string]any)["sidebars"] = map[string]any{"left": map[string]any{"set": "set-install"}}
	return card["id"].(string)
}

// A restart leaves the services alive and their sessions recoverable while a layout holds the surface
// (docs/spec/persistent-services.md), and a window starts in the library, where no sidebar is drawn yet.
func TestTheStartKeepsTheSessionsOfTheSectionsOfTheStoredLayouts(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	card := cardWithSidebar(project)
	stored := &storedHost{installed: sidebarsInstalled, projects: []map[string]any{project}}
	newShell(t, stored)
	calls := retained(t, stored)
	if len(calls) != 1 {
		t.Fatalf("retained %v", calls)
	}
	for _, want := range []string{"/a tab-aaaaaa", "/a spc-aaaaaa/left/fieldprobe.tree", "/a spc-aaaaaa/" + card + ":left/fieldprobe.tree"} {
		if !slices.Contains(calls[0], want) {
			t.Fatalf("the start retains %v, without %s", calls[0], want)
		}
	}
}

// A retain of a shown project keeps the sections of its other spaces and of the other projects, which their layouts still hold.
func TestARetainKeepsTheSectionsOfTheSpacesThatAreNotShown(t *testing.T) {
	other := storedProject(tab("tab-cccccc", "notes"))
	other["id"], other["root"], other["identity"] = "prj-b", "/b", "identity of /b"
	other["spaces"].([]map[string]any)[0]["id"] = "spc-bbbbbb"
	other["activeSpaceId"] = "spc-bbbbbb"
	card := cardWithSidebar(other)
	stored := &storedHost{installed: sidebarsInstalled, projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes")), other}}
	f := newShell(t, stored)
	f.run("core.project.activate", map[string]string{"id": "prj-a"})
	stored.retains = nil
	f.run("core.tab.close", map[string]string{"tab": "tab-bbbbbb"})
	f.settle()
	calls := retained(t, stored)
	if len(calls) != 1 {
		t.Fatalf("retained %v", calls)
	}
	for _, want := range []string{"/b spc-bbbbbb/left/fieldprobe.tree", "/b spc-bbbbbb/" + card + ":left/fieldprobe.tree"} {
		if !slices.Contains(calls[0], want) {
			t.Fatalf("the retain holds %v, without %s", calls[0], want)
		}
	}
}

// The sets and the links are project settings, so the sections of a project that is not shown follow from its own overrides.
func TestARetainTakesTheSetsOfEachProject(t *testing.T) {
	other := storedProject(tab("tab-cccccc", "notes"))
	other["id"], other["root"], other["identity"] = "prj-b", "/b", "identity of /b"
	other["spaces"].([]map[string]any)[0]["id"] = "spc-bbbbbb"
	other["activeSpaceId"] = "spc-bbbbbb"
	other["settings"] = map[string]any{
		"sets":  []any{map[string]any{"id": "mine", "title": "mine", "sections": []any{"fieldprobe.bookmarks"}, "layout": "list"}},
		"links": []any{map[string]any{"place": "left", "plugin": nil, "set": "mine"}},
	}
	stored := &storedHost{installed: sidebarsInstalled, projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes")), other}}
	newShell(t, stored)
	calls := retained(t, stored)
	if len(calls) != 1 {
		t.Fatalf("retained %v", calls)
	}
	if !slices.Contains(calls[0], "/b spc-bbbbbb/left/fieldprobe.bookmarks") || slices.Contains(calls[0], "/b spc-bbbbbb/left/fieldprobe.tree") {
		t.Fatalf("the retain holds %v, want the set of the project prj-b", calls[0])
	}
	if !slices.Contains(calls[0], "/a spc-aaaaaa/left/fieldprobe.tree") {
		t.Fatalf("the retain holds %v, without the common set of the project prj-a", calls[0])
	}
}

// A card draws the side that the plugin of its active tab links, and the other tabs of the card can become active.
func TestARetainKeepsTheLinkedSideOfEachTabOfACard(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "boxprobe"))
	project["settings"] = map[string]any{
		"sets":  []any{map[string]any{"id": "mine", "title": "mine", "sections": []any{"boxprobe.history"}, "layout": "list"}},
		"links": []any{map[string]any{"place": "card-top", "plugin": "boxprobe", "set": "mine"}},
	}
	card := project["spaces"].([]map[string]any)[0]["layout"].(map[string]any)["state"].(map[string]any)["cards"].([]map[string]any)[0]
	stored := &storedHost{installed: sidebarsInstalled, projects: []map[string]any{project}}
	newShell(t, stored)
	calls := retained(t, stored)
	want := "/a spc-aaaaaa/" + card["id"].(string) + ":top/boxprobe.history"
	if len(calls) != 1 || !slices.Contains(calls[0], want) {
		t.Fatalf("retained %v, without %s", calls, want)
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
	shown, err := f.shell.Registry().Read("core.workbench.error")
	if err != nil {
		t.Fatal(err)
	}
	if text, ok := shown.(*string); !ok || text == nil || !strings.Contains(*text, "retain was not answered") {
		t.Fatalf("the status core.workbench.error is %v", shown)
	}
}

func TestTheStartRemovesTheStoredEntriesOfSurfacesInNoLayout(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))},
		sessionTabs: []string{"spc-aaaaaa/left/fieldprobe.tree", "spc-gone/left/fieldprobe.tree", "tab-aaaaaa", "tab-gone"},
		tabState:    map[string]any{"format": 1, "tabs": map[string]any{"tab-aaaaaa": map[string]any{"kept": true}, "tab-gone": map[string]any{"kept": true}}}}
	f := newTabShell(t, stored)
	slices.Sort(f.sessionPuts)
	equal(t, f.sessionPuts, []string{"spc-gone/left/fieldprobe.tree", "tab-gone"})
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
	shown, err := f.shell.Registry().Read("core.workbench.error")
	if err != nil {
		t.Fatal(err)
	}
	if text, ok := shown.(*string); !ok || text == nil || !strings.Contains(*text, "space spc-aaaaaa") {
		t.Fatalf("the status core.workbench.error is %v", shown)
	}
}
