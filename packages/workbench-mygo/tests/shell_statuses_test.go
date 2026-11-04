package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// status reads a status of the shell through its JSON form, as a reader of the endpoint gets it.
func status[T any](t *testing.T, f *shellFixture, name string) T {
	t.Helper()
	value, err := f.shell.Registry().Read(name)
	if err != nil {
		t.Fatalf("status %s: %v", name, err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("status %s: %v", name, err)
	}
	var out T
	if err := json.Unmarshal(text, &out); err != nil {
		t.Fatalf("status %s: %v in %s", name, err, text)
	}
	return out
}

type gridRead struct {
	Fullscreen *string `json:"fullscreen"`
	Width      float64 `json:"width"`
	Cards      []struct {
		ID         string  `json:"id"`
		X          float64 `json:"x"`
		W          float64 `json:"w"`
		Focused    bool    `json:"focused"`
		Fullscreen bool    `json:"fullscreen"`
		Pane       *int    `json:"pane"`
		Active     *string `json:"active"`
		Tabs       []struct {
			ID     string `json:"id"`
			Plugin string `json:"plugin"`
		} `json:"tabs"`
		Acts map[string]any `json:"acts"`
	} `json:"cards"`
}

func TestGridStatusShowsTheCardsOfTheSplit(t *testing.T) {
	f, _ := surfaceShell(t)
	before := status[gridRead](t, f, "core.grid")
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right"})
	grid := status[gridRead](t, f, "core.grid")
	if len(grid.Cards) != len(before.Cards)+1 {
		t.Fatalf("the grid holds %d cards after %d", len(grid.Cards), len(before.Cards))
	}
	focused, panes := 0, 0
	for _, card := range grid.Cards {
		if card.Focused {
			focused++
		}
		if len(card.Tabs) == 0 {
			continue
		}
		if card.Active == nil || card.Pane == nil || card.Acts["fit"] == nil {
			t.Fatalf("card %s has no active tab, pane or tools: %+v", card.ID, card)
		}
		panes++
	}
	if focused != 1 || panes != len(f.tabbedCards()) {
		t.Fatalf("the grid has %d focused cards and %d panes", focused, panes)
	}
}

func TestFullscreenCoversThePlaneAndKeepsTheLayout(t *testing.T) {
	f, _ := surfaceShell(t)
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right"})
	cards := f.tabbedCards()
	f.click("core.card.fullscreen", cards[0])
	grid := status[gridRead](t, f, "core.grid")
	if grid.Fullscreen == nil || *grid.Fullscreen != cards[0] {
		t.Fatalf("the fullscreen card is %v", grid.Fullscreen)
	}
	for _, card := range grid.Cards {
		if card.ID == cards[0] && (!card.Fullscreen || card.W != grid.Width || card.X != 0) {
			t.Fatalf("the fullscreen card stands at %+v in a plane of width %v", card, grid.Width)
		}
	}
	if f.has("core.card.close", cards[1]) {
		t.Fatal("a card stays drawn under the fullscreen card")
	}
	if _, err := f.answer("core.card.split", map[string]string{"card": cards[0], "side": "right"}); err == nil || !strings.Contains(err.Error(), "fullscreen") {
		t.Fatalf("a split under the fullscreen card answers %v", err)
	}
	f.run("core.card.focus", map[string]string{"card": cards[1]})
	if grid := status[gridRead](t, f, "core.grid"); grid.Fullscreen != nil {
		t.Fatalf("a focus of another card leaves fullscreen %v", *grid.Fullscreen)
	}
}

func TestProjectStatusesFollowTheWindow(t *testing.T) {
	f, _ := surfaceShell(t)
	project := status[map[string]any](t, f, "core.project")
	if project["open"] != true || project["id"] == nil {
		t.Fatalf("core.project is %v", project)
	}
	projects := status[[]map[string]any](t, f, "core.projects")
	if len(projects) == 0 || projects[0]["open"] != true {
		t.Fatalf("core.projects is %v", projects)
	}
	f.run("core.projects.browse", nil)
	if value, err := f.shell.Registry().Read("core.project"); err != nil || value != nil {
		t.Fatalf("core.project over the library is %v, %v", value, err)
	}
	library := status[map[string]any](t, f, "core.library")
	if library["page"] != "projects" || library["form"] != false || library["returnVisible"] != true {
		t.Fatalf("core.library is %v", library)
	}
}

func TestLayoutStatusIsTheSavedFormOfTheSpace(t *testing.T) {
	f, _ := surfaceShell(t)
	layout := status[map[string]any](t, f, "core.layout")
	state, ok := layout["state"].(map[string]any)
	if !ok || state["cards"] == nil || layout["focusedId"] == nil {
		t.Fatalf("core.layout is %v", layout)
	}
}

func TestSurfacesStatusListsTheHeldViews(t *testing.T) {
	f, stored := surfaceShell(t)
	surfaces := status[[]map[string]any](t, f, "core.surfaces")
	if len(surfaces) != len(stored.lastSurfaces(t)) || len(surfaces) == 0 {
		t.Fatalf("core.surfaces is %v", surfaces)
	}
	for _, surface := range surfaces {
		if surface["visible"] != true || surface["declared"] == nil || surface["kind"] != "tab" {
			t.Fatalf("surface %v", surface)
		}
	}
}

func TestRailStatusHasNoGroupWithoutAnOverride(t *testing.T) {
	f, _ := surfaceShell(t)
	rail := status[map[string]any](t, f, "core.rail")
	if rail["path"] != "" || rail["focusMark"] != nil {
		t.Fatalf("core.rail is %v", rail)
	}
}

func TestFocusCornersStandAroundTheSlot(t *testing.T) {
	f, _ := surfaceShell(t)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"focusInd": "corner"}})
	rail := status[map[string]any](t, f, "core.rail")
	mark, ok := rail["focusMark"].(map[string]any)
	if !ok || mark["w"].(float64) <= 0 || mark["h"].(float64) <= 0 {
		t.Fatalf("core.rail is %v", rail)
	}
}

func TestChromeStatusNamesTheProjectTabs(t *testing.T) {
	f, _ := surfaceShell(t)
	chrome := status[map[string]any](t, f, "core.chrome")
	if chrome["projectTabs"] != "top" {
		t.Fatalf("core.chrome is %v", chrome)
	}
}

func TestASectionOfAWindowSidebarHoldsItsView(t *testing.T) {
	f := sidebarShell(t)
	surfaces := status[[]map[string]any](t, f, "core.surfaces")
	sections := 0
	for _, surface := range surfaces {
		if surface["kind"] == "section" {
			sections++
			if surface["plugin"] != "files" {
				t.Fatalf("section surface %v", surface)
			}
		}
	}
	if sections == 0 {
		t.Fatalf("no section stands in core.surfaces: %v", surfaces)
	}
}

func TestAViewReadsAndWritesTheDataOfItsProject(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := anySurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "notes"}); reply["error"] != nil || reply["result"] != "none" {
		t.Fatalf("the reply of the default is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.on", nil); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.set", map[string]any{"key": "notes", "value": "kept"}); reply["error"] != nil {
		t.Fatalf("the reply of the write is %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "notes"}); reply["result"] != "kept" {
		t.Fatalf("the reply after the write is %v", reply)
	}
	encoded, err := json.Marshal(f.host.projects[0]["plugins"])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"format":2`) || !strings.Contains(string(encoded), `"value":"kept"`) {
		t.Fatalf("the stored plugins are %s", encoded)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.set", map[string]any{"key": "notes", "value": 1}); reply["error"] == nil {
		t.Fatalf("a value out of its schema is answered %v", reply)
	}
	if reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "other"}); reply["error"] == nil {
		t.Fatalf("an undeclared key is answered %v", reply)
	}
}

func TestWorkbenchStatusNamesThisStart(t *testing.T) {
	f, _ := surfaceShell(t)
	workbench := status[map[string]any](t, f, "core.window.workbench")
	if start, ok := workbench["start"].(string); !ok || start == "" || workbench["started_at"] == nil {
		t.Fatalf("core.window.workbench is %v", workbench)
	}
}
