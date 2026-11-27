package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"
)

// settingsTabStatus is the status core.settings-tab reports (docs/spec/settings.md#status).
type settingsTabStatus struct {
	Page   string `json:"page"`
	Scope  string `json:"scope"`
	Find   string `json:"find"`
	Query  string `json:"query"`
	Filter string `json:"filter"`
	Browse struct {
		Query         string `json:"query"`
		HideInstalled bool   `json:"hideInstalled"`
		Shown         int    `json:"shown"`
	} `json:"browse"`
	Listed  []string `json:"listed"`
	Plugin  *string  `json:"plugin"`
	Back    string   `json:"back"`
	Editing *string  `json:"editing"`
	Undo    *struct {
		Key   string `json:"key"`
		Label string `json:"label"`
		Old   any    `json:"old"`
		New   any    `json:"new"`
	} `json:"undo"`
	Confirm *struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	} `json:"confirm"`
	Results *struct {
		Settings []string `json:"settings"`
		Plugins  []string `json:"plugins"`
		Catalog  int      `json:"catalog"`
	} `json:"results"`
	Controls []struct {
		Name    string  `json:"name"`
		Key     *string `json:"key"`
		Command *struct {
			Name string `json:"name"`
		} `json:"command"`
	} `json:"controls"`
}

// tabStatus reads core.settings-tab; a closed tab reports null, which the test reads as nil.
func (f *shellFixture) tabStatus() *settingsTabStatus {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.settings-tab")
	if err != nil {
		f.t.Fatal(err)
	}
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status settingsTabStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		f.t.Fatal(err)
	}
	return &status
}

// The settings tab opens by core.settings.open and closes by core.settings.close. While it is in front its status reports the page
// of the menu, the scope and the search text; a closed tab reports null.
func TestTheSettingsTabOpensAndClosesAndItsStatusFollows(t *testing.T) {
	f := newShell(t, acme())
	if f.tabStatus() != nil {
		t.Fatal("a closed settings tab reports a status")
	}
	f.run("core.settings.open", nil)
	status := f.tabStatus()
	if status == nil {
		t.Fatal("the opened settings tab reports no status")
	}
	if status.Page != "look" || status.Scope != "common" || status.Find != "" || status.Query != "" || status.Filter != "all" {
		t.Fatalf("the opened tab reports page %q, scope %q, find %q, query %q and filter %q", status.Page, status.Scope, status.Find, status.Query, status.Filter)
	}
	f.run("core.settings.close", nil)
	if f.tabStatus() != nil {
		t.Fatal("a closed settings tab still reports a status")
	}
}

// The menu lists the pages of 설정 and 플러그인 in the order of the specification, each as core.settings-tab.nav {page}.
func TestTheSettingsTabMenuListsItsPagesInOrder(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	var keys []string
	for _, control := range f.tabStatus().Controls {
		if control.Name == "core.settings-tab.nav" && control.Key != nil {
			keys = append(keys, *control.Key)
		}
	}
	want := []string{"nav:look", "nav:workspace", "nav:sets", "nav:behavior", "nav:agents", "nav:diag", "nav:installed", "nav:browse"}
	if !slices.Equal(keys, want) {
		t.Fatalf("the menu lists %q, want %q", keys, want)
	}
}

// Every field of the status table of the specification is present while the tab is in front; a list without members is an empty
// list, not null, and browse is an object (docs/spec/settings.md#status).
func TestTheSettingsTabStatusReportsEveryFieldOfItsTable(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	value, err := f.shell.Registry().Read("core.settings-tab")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"page", "scope", "find", "query", "filter", "browse", "listed", "actions", "plugin", "back", "editing", "rows", "controls", "scroll", "undo", "confirm", "errors", "results", "missing"} {
		if _, ok := fields[name]; !ok {
			t.Fatalf("the status has no field %s: %s", name, raw)
		}
	}
	for _, name := range []string{"listed", "actions", "rows", "controls", "errors", "missing"} {
		if _, ok := fields[name].([]any); !ok {
			t.Fatalf("the field %s is %v, not a list", name, fields[name])
		}
	}
	browse, ok := fields["browse"].(map[string]any)
	if !ok {
		t.Fatalf("browse is %v, not an object", fields["browse"])
	}
	for _, name := range []string{"query", "hideInstalled", "shown"} {
		if _, ok := browse[name]; !ok {
			t.Fatalf("browse has no member %s: %v", name, browse)
		}
	}
}

// settingsTabNow reads the status of the tab, which is open.
func (f *shellFixture) settingsTabNow() *settingsTabStatus {
	f.t.Helper()
	status := f.tabStatus()
	if status == nil {
		f.t.Fatal("the settings tab reports no status")
	}
	return status
}

// A change made on the tab shows the toast of the change with its label and both values; core.settings-tab.undo restores the old value
// and removes the toast (docs/spec/settings.md#saving-and-undo).
func TestAChangeOnTheTabShowsItsToastAndUndoRestoresTheOldValue(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 20, "scope": "common"})
	toast := f.settingsTabNow().Undo
	if toast == nil {
		t.Fatal("a change on the tab shows no toast")
	}
	if toast.Key != "gap" || toast.Label != "통로" || toast.New != float64(20) || toast.Old != float64(12) {
		t.Fatalf("the toast is %+v", toast)
	}
	f.run("core.settings-tab.undo", map[string]any{})
	if f.settingsTabNow().Undo != nil {
		t.Fatal("undo keeps the toast")
	}
	values := status[struct {
		Values map[string]any `json:"values"`
	}](t, f, "core.settings")
	if values.Values["gap"] != float64(12) {
		t.Fatalf("undo leaves gap at %v", values.Values["gap"])
	}
}

// A change made outside the tab shows no toast.
func TestAChangeOutsideTheTabShowsNoToast(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 20, "scope": "common"})
	f.run("core.settings.open", nil)
	if f.settingsTabNow().Undo != nil {
		t.Fatal("a change made before the tab opened shows a toast")
	}
}

// settingsSetIDs returns the ids of the stored sets of the common scope.
func (f *shellFixture) settingsSetIDs(t *testing.T) []string {
	t.Helper()
	values := status[struct {
		Values map[string]any `json:"values"`
	}](t, f, "core.settings")
	var ids []string
	for _, item := range values.Values["sets"].([]any) {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	return ids
}

// A removal of a set asks first: core.settings-tab.confirm with answer ask shows the confirmation, answer no closes it without a change,
// and answer yes deletes the set and closes the confirmation (docs/spec/settings.md#사이드바-세트).
func TestARemovalOfASetIsConfirmedBeforeItRuns(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.run("core.settings.sets.create", map[string]any{"scope": "common"})
	before := f.settingsSetIDs(t)
	f.run("core.settings-tab.confirm", map[string]any{"kind": "set", "id": "set-2", "answer": "ask"})
	if c := f.settingsTabNow().Confirm; c == nil || c.Kind != "set" || c.ID != "set-2" {
		t.Fatalf("the confirmation is %+v", c)
	}
	f.run("core.settings-tab.confirm", map[string]any{"kind": "set", "id": "set-2", "answer": "no"})
	if f.settingsTabNow().Confirm != nil || !slices.Equal(f.settingsSetIDs(t), before) {
		t.Fatal("answer no changed the sets or kept the confirmation")
	}
	f.run("core.settings-tab.confirm", map[string]any{"kind": "set", "id": "set-2", "answer": "ask"})
	f.run("core.settings-tab.confirm", map[string]any{"kind": "set", "id": "set-2", "answer": "yes"})
	if f.settingsTabNow().Confirm != nil {
		t.Fatal("answer yes keeps the confirmation")
	}
	if slices.Contains(f.settingsSetIDs(t), "set-2") {
		t.Fatal("answer yes did not delete the set")
	}
}

// controlsNamed returns the controls of the status with the element name, in document order.
func (f *shellFixture) controlsNamed(name string) []struct {
	Name    string  `json:"name"`
	Key     *string `json:"key"`
	Command *struct {
		Name string `json:"name"`
	} `json:"command"`
} {
	f.t.Helper()
	var found []struct {
		Name    string  `json:"name"`
		Key     *string `json:"key"`
		Command *struct {
			Name string `json:"name"`
		} `json:"command"`
	}
	for _, control := range f.settingsTabNow().Controls {
		if control.Name == name {
			found = append(found, control)
		}
	}
	return found
}

// The sets page shows each section of a set as a chip, and each chip has one × that removes it. The page has no reorder button, and the
// select 섹션 추가… lists the registered sections that the set does not contain (docs/spec/settings.md#사이드바-세트).
func TestTheSetsPageShowsSectionChipsWithOneRemoveAndAnAddSelect(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings-tab.nav", map[string]any{"page": "sets"})
	f.run("core.settings-tab.edit", map[string]any{"set": "set-1"})
	chips := f.controlsNamed("core.settings-tab.chip")
	if len(chips) == 0 {
		t.Fatal("the edited set shows no section chip")
	}
	if got := f.controlsNamed("core.settings-tab.row-act"); len(got) != len(chips) {
		t.Fatalf("%d chips have %d removal controls", len(chips), len(got))
	}
	for _, control := range f.settingsTabNow().Controls {
		if control.Name == "core.settings-tab.row-act" && control.Command != nil && control.Command.Name != "core.settings.sets.row" {
			t.Fatalf("the removal control runs %s", control.Command.Name)
		}
	}
	if add := f.controlsNamed("core.settings-tab.add"); len(add) != 1 {
		t.Fatalf("the set has %d section select boxes", len(add))
	}
}

// The toast is the element core.settings-tab.toast in the foot of the tab, with its text and the button 되돌리기 (core.settings-tab.undo),
// and it leaves the tab with the undo (docs/spec/settings.md#saving-and-undo).
func TestTheToastIsDrawnInTheFootOfTheTab(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 20, "scope": "common"})
	f.settle()
	if !f.has("core.settings-tab.toast", "") || !f.has("core.settings-tab.undo", "") {
		t.Fatal("the toast of the change is not drawn in the foot of the tab")
	}
	if !f.tester.HasText("통로: 12 → 20") {
		t.Fatalf("the toast text is not 통로: 12 → 20: %q", f.tester.Texts())
	}
	f.run("core.settings-tab.undo", map[string]any{})
	f.settle()
	if f.has("core.settings-tab.toast", "") {
		t.Fatal("the toast stays drawn after the undo")
	}
}

// A toast names the values of its change in the form of its kind: a choice shows its option label, and a side switch names its side
// (docs/spec/settings.md#saving-and-undo).
func TestAToastNamesTheValuesOfAChangeByItsKind(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings.change", map[string]any{"key": "mode", "value": "light", "scope": "common"})
	f.run("core.settings.change", map[string]any{"key": "mode", "value": "dark", "scope": "common"})
	f.settle()
	if !f.tester.HasText("모드: 밝음 → 어두움") {
		t.Fatalf("the choice toast is not 모드: 밝음 → 어두움: %q", f.tester.Texts())
	}
	f.run("core.settings.change", map[string]any{"key": "left", "value": false, "scope": "common"})
	f.run("core.settings.change", map[string]any{"key": "left", "value": true, "scope": "common"})
	f.settle()
	if !f.tester.HasText("왼쪽 사이드바 보이기: 끔 → 켬") {
		t.Fatalf("the side toast is not 왼쪽 사이드바 보이기: 끔 → 켬: %q", f.tester.Texts())
	}
}

// A theme change shows the toast 테마: <old> → <new>, and its undo restores the old theme (docs/spec/settings.md#saving-and-undo).
func TestAThemeChangeShowsItsToastAndUndoRestoresTheTheme(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings.theme", map[string]any{"name": "nord", "mode": "dark", "scope": "common"})
	f.run("core.settings.theme", map[string]any{"name": "solar", "mode": "dark", "scope": "common"})
	f.settle()
	if !f.tester.HasText("테마: nord → solar") {
		t.Fatalf("the theme toast is not 테마: nord → solar: %q", f.tester.Texts())
	}
	f.run("core.settings-tab.undo", map[string]any{})
	f.settle()
	values := status[struct {
		Values map[string]any `json:"values"`
	}](t, f, "core.settings")
	if values.Values["theme"] != "nord" {
		t.Fatalf("undo leaves the theme at %v, want nord", values.Values["theme"])
	}
}

// A sidebar order shows the toast 배치 순서: <sides> with the side names joined by → (docs/spec/settings.md#saving-and-undo).
func TestASidebarOrderShowsItsSidesInItsToast(t *testing.T) {
	f := newShell(t, acme())
	f.run("core.settings.open", nil)
	f.run("core.settings.change", map[string]any{"key": "sidebarOrder", "value": []string{"top", "left", "right", "bottom"}, "scope": "common"})
	f.settle()
	if !f.tester.HasText("배치 순서: 위 → 왼쪽 → 오른쪽 → 아래") {
		t.Fatalf("the order toast is not 배치 순서: 위 → 왼쪽 → 오른쪽 → 아래: %q", f.tester.Texts())
	}
}

// The undo of a project value that was not overridden before the change resets it, so no override stays (docs/spec/settings.md#saving-and-undo).
func TestTheUndoOfANewProjectOverrideResetsIt(t *testing.T) {
	f := projectWithPlugins(t)
	f.settle()
	f.run("core.settings.open", nil)
	overridden := func() []string {
		return status[struct {
			Overridden []string `json:"overridden"`
		}](t, f, "core.settings").Overridden
	}
	if slices.Contains(overridden(), "gap") {
		t.Fatal("gap is overridden before the change")
	}
	f.run("core.settings.change", map[string]any{"key": "gap", "value": 20, "scope": "project"})
	f.settle()
	if !slices.Contains(overridden(), "gap") {
		t.Fatal("the project change does not override gap")
	}
	f.run("core.settings-tab.undo", map[string]any{})
	f.settle()
	if slices.Contains(overridden(), "gap") {
		t.Fatalf("undo leaves the override of gap: %v", overridden())
	}
}
