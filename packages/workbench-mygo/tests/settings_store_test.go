package workbench_test

import (
	"encoding/json"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// saved is one write of the settings to the host.
type saved struct {
	project string
	patch   map[string]any
	remove  []string
}

func settingsStore(t *testing.T, writes *[]saved, definitions ...workbench.SettingDefinition) *workbench.SettingsStore {
	t.Helper()
	store, err := workbench.NewSettingsStore(definitions, func(project string, patch map[string]any, remove []string) {
		*writes = append(*writes, saved{project, patch, remove})
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestTheSettingsAreTheDefaultsTheCommonValuesAndTheProjectOverrides(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(map[string]any{"mode": "light", "gap": 8.0}, map[string]any{"gap": 12.0}, "prj-a"); err != nil {
		t.Fatal(err)
	}
	values := store.Status().Values
	if values["theme"] != "midnight" || values["mode"] != "light" || values["gap"] != 12.0 || values["font"] != "mono-system" {
		t.Fatalf("effective values %v", values)
	}
	for key, value := range values {
		if !reflect.DeepEqual(store.Value(key), value) {
			t.Fatalf("value of %s %v, want %v", key, store.Value(key), value)
		}
	}
	if store.Scoped("gap", "common") != 8.0 || store.Scoped("gap", "project") != 12.0 {
		t.Fatalf("the scoped gap is %v and %v", store.Scoped("gap", "common"), store.Scoped("gap", "project"))
	}
	if !store.Overridden("gap") || store.Overridden("mode") {
		t.Fatal("the override of the project is not the gap alone")
	}
}

func TestAChangeIsCheckedAppliedAndWrittenToItsScope(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, "prj-a"); err != nil {
		t.Fatal(err)
	}
	if err := store.Change("gap", "12", "project"); err != nil {
		t.Fatal(err)
	}
	if err := store.Change("dim", "true", "common"); err != nil {
		t.Fatal(err)
	}
	want := []saved{{"prj-a", map[string]any{"gap": 12.0}, nil}, {"", map[string]any{"dim": true}, nil}}
	if !reflect.DeepEqual(writes, want) {
		t.Fatalf("writes %+v, want %+v", writes, want)
	}
	if store.Status().Values["gap"] != 12.0 || store.Status().Values["dim"] != true {
		t.Fatalf("values %v", store.Status().Values)
	}
	if err := store.Reset("gap"); err != nil {
		t.Fatal(err)
	}
	if last := writes[len(writes)-1]; last.project != "prj-a" || !reflect.DeepEqual(last.remove, []string{"gap"}) {
		t.Fatalf("the reset wrote %+v", last)
	}
}

func TestAValueOfAnotherFormIsRefusedWithItsReason(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes, workbench.SettingDefinition{Key: "acme.level", Plugin: "acme", Type: "integer", Minimum: 1, Maximum: 5, Default: 2.0})
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		key   string
		value any
		want  string
	}{
		{"mode", "dusk", `Invalid setting mode: "dusk" is not one of "dark", "light"`},
		{"dim", "yes", `Invalid setting dim: "yes" is not a boolean`},
		{"gap", 99.0, `Invalid setting gap: 99 is not an integer from 0 to 24`},
		{"memorySaverDelay", 1.0, `Invalid setting memorySaverDelay: 1`},
		{"acme.level", 9.0, `Invalid setting acme.level: integer value is outside its declared range`},
		{"nothing", 1.0, `Unknown setting: nothing`},
	}
	for _, c := range cases {
		err := store.Set(map[string]any{c.key: c.value}, "common")
		if err == nil || err.Error() != c.want {
			t.Errorf("%s = %v: %v, want %s", c.key, c.value, err, c.want)
		}
	}
	if len(writes) != 0 {
		t.Fatalf("a refused change was written: %+v", writes)
	}
	err := store.Set(map[string]any{"sidebarWidth": 40.0 + 60}, "common")
	if err == nil || !strings.Contains(err.Error(), "sidebarMinWidth <= sidebarWidth <= sidebarMaxWidth") {
		t.Fatalf("a width below the minimum: %v", err)
	}
}

func TestACommonOnlyKeyHasNoProjectValueAndAProjectScopeNeedsAProject(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(map[string]any{"gap": 2.0}, "project"); err == nil || err.Error() != "No project is selected" {
		t.Fatalf("no project: %v", err)
	}
	if err := store.Begin(nil, nil, "prj-a"); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(map[string]any{"memorySaver": false}, "project"); err == nil || err.Error() != "memorySaver is common-only" {
		t.Fatalf("common-only: %v", err)
	}
	if err := store.Begin(nil, map[string]any{"textSize": 1.0}, "prj-a"); err == nil || !strings.Contains(err.Error(), "textSize is common-only") {
		t.Fatalf("a stored common-only override: %v", err)
	}
}

func TestChoosingAThemeSetsItsShape(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.Theme("paper", "", "common"); err != nil {
		t.Fatal(err)
	}
	patch := writes[0].patch
	if patch["theme"] != "paper" || patch["mode"] != "dark" {
		t.Fatalf("patch %v", patch)
	}
	for _, key := range []string{"gap", "radius", "font", "size"} {
		if _, ok := patch[key]; !ok {
			t.Fatalf("the theme leaves %s: %v", key, patch)
		}
	}
	if err := store.Theme("nothing", "", "common"); err == nil || err.Error() != "unknown theme: nothing" {
		t.Fatalf("unknown theme: %v", err)
	}
}

func TestTheDebugSwitchIsTheTraceAndEveryClassAtTrace(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	if store.DebugOn() {
		t.Fatal("the switch starts on")
	}
	if err := store.Debug(true); err != nil {
		t.Fatal(err)
	}
	if !store.DebugOn() {
		t.Fatalf("the switch stays off: %v", store.Status().Values)
	}
	if err := store.Debug(false); err != nil {
		t.Fatal(err)
	}
	if store.DebugOn() || store.Status().Values["diagnostics.performance"] != false {
		t.Fatalf("the switch stays on: %v", store.Status().Values)
	}
}

func TestTheStatusOfTheSettingsHasItsDeclaredMembers(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(nil, map[string]any{"gap": 2.0}, "prj-a"); err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(store.Status())
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.Unmarshal(text, &status); err != nil {
		t.Fatal(err)
	}
	if status["project"] != "prj-a" || !reflect.DeepEqual(status["overridden"], []any{"gap"}) || status["saving"] != false {
		t.Fatalf("status %v", status)
	}
}

func set(id string, sections ...string) workbench.StoredSet {
	return workbench.StoredSet{ID: id, Title: id, Sections: sections, Layout: "list"}
}

func TestANewSetTakesTheFirstFreeNumber(t *testing.T) {
	got := workbench.CreateSet([]workbench.StoredSet{set("set-1"), set("set-3")})
	last := got[len(got)-1]
	if last.ID != "set-2" || last.Title != "새 세트" || last.Layout != "list" || len(last.Sections) != 0 {
		t.Fatalf("new set %+v", last)
	}
}

func TestASetChangesItsTitleAndItsLayoutWithinTheirForms(t *testing.T) {
	sets := []workbench.StoredSet{set("a")}
	title, layout := "이름", "tabs"
	got, err := workbench.UpdateSet(sets, "a", &title, &layout)
	if err != nil || got[0].Title != "이름" || got[0].Layout != "tabs" || sets[0].Title != "a" {
		t.Fatalf("%+v %v, the input %+v", got, err, sets)
	}
	empty := ""
	if _, err := workbench.UpdateSet(sets, "a", &empty, nil); err == nil || err.Error() != "set title must be 1 to 40 characters" {
		t.Fatalf("empty title: %v", err)
	}
	wrong := "grid"
	if _, err := workbench.UpdateSet(sets, "a", nil, &wrong); err == nil || err.Error() != "set layout must be list or tabs" {
		t.Fatalf("wrong layout: %v", err)
	}
	if _, err := workbench.UpdateSet(sets, "b", &title, nil); err == nil || err.Error() != "unknown set b" {
		t.Fatalf("unknown set: %v", err)
	}
}

func TestTheRowsOfASetChooseMoveRemoveAndAdd(t *testing.T) {
	registered := []string{"p", "q", "r"}
	sets := []workbench.StoredSet{set("a", "p", "q")}
	row := func(sets []workbench.StoredSet, action string, index int, section string) ([]workbench.StoredSet, error) {
		return workbench.ChangeRow(sets, "a", action, index, section, registered)
	}
	got, err := row(sets, "choose", 1, "r")
	if err != nil || !reflect.DeepEqual(got[0].Sections, []string{"p", "r"}) {
		t.Fatalf("choose %+v %v", got, err)
	}
	if _, err := row(sets, "choose", 1, "p"); err == nil || err.Error() != "section p is already in set a" {
		t.Fatalf("a repeated section: %v", err)
	}
	if _, err := row(sets, "choose", 0, "x"); err == nil || err.Error() != "unknown section x" {
		t.Fatalf("unknown section: %v", err)
	}
	got, err = row(sets, "down", 0, "")
	if err != nil || !reflect.DeepEqual(got[0].Sections, []string{"q", "p"}) {
		t.Fatalf("down %+v %v", got, err)
	}
	got, err = row(sets, "up", 1, "")
	if err != nil || !reflect.DeepEqual(got[0].Sections, []string{"q", "p"}) {
		t.Fatalf("up %+v %v", got, err)
	}
	if _, err := row(sets, "up", 0, ""); err == nil || err.Error() != "row 0 cannot move up" {
		t.Fatalf("up at the start: %v", err)
	}
	got, err = row(sets, "remove", 0, "")
	if err != nil || !reflect.DeepEqual(got[0].Sections, []string{"q"}) {
		t.Fatalf("remove %+v %v", got, err)
	}
	got, err = row(sets, "add", 0, "")
	if err != nil || !reflect.DeepEqual(got[0].Sections, []string{"p", "q", "r"}) {
		t.Fatalf("add %+v %v", got, err)
	}
	if _, err := row(got, "add", 0, ""); err == nil || err.Error() != "set a already contains every registered section" {
		t.Fatalf("add with none left: %v", err)
	}
	if !reflect.DeepEqual(sets[0].Sections, []string{"p", "q"}) {
		t.Fatalf("the input changed: %+v", sets)
	}
}

func TestAChoiceOfASidebarReplacesItsLinkAndOffRemovesIt(t *testing.T) {
	links, err := workbench.ChooseLink(nil, "left", "", "a")
	if err != nil || !reflect.DeepEqual(links, []workbench.StoredLink{{Place: "left", Set: "a"}}) {
		t.Fatalf("%+v %v", links, err)
	}
	links, err = workbench.ChooseLink(links, "left", "", "b")
	if err != nil || len(links) != 1 || links[0].Set != "b" {
		t.Fatalf("%+v %v", links, err)
	}
	links, err = workbench.ChooseLink(links, "left", "", "off")
	if err != nil || len(links) != 0 {
		t.Fatalf("%+v %v", links, err)
	}
	if _, err := workbench.ChooseLink(nil, "left", "acme", "a"); err == nil || err.Error() != "invalid plugin for left" {
		t.Fatalf("a plugin of a general choice: %v", err)
	}
	if _, err := workbench.ChooseLink(nil, "window-left", "", "a"); err == nil || err.Error() != "invalid plugin for window-left" {
		t.Fatalf("no plugin of a window choice: %v", err)
	}
	if _, err := workbench.ChooseLink(nil, "left", "", "inherit"); err == nil || err.Error() != "left has no inherit choice" {
		t.Fatalf("inherit: %v", err)
	}
}

func TestDeletingASetRemovesTheLinksToIt(t *testing.T) {
	sets, links, err := workbench.DeleteSet([]workbench.StoredSet{set("a"), set("b")},
		[]workbench.StoredLink{{Place: "left", Set: "a"}, {Place: "right", Set: "b"}}, "a")
	if err != nil || len(sets) != 1 || sets[0].ID != "b" || len(links) != 1 || links[0].Set != "b" {
		t.Fatalf("%+v %+v %v", sets, links, err)
	}
	if _, _, err := workbench.DeleteSet(nil, nil, "a"); err == nil || err.Error() != "unknown set a" {
		t.Fatalf("unknown set: %v", err)
	}
}

func TestAStoredSettingOfALoadedPluginMustBeDeclared(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(map[string]any{"acme.gone": 1.0}, nil, ""); err != nil {
		t.Fatalf("the setting of a plugin that is not loaded stays in the file: %v", err)
	}
	store.Loaded(workbench.LoadedPlugin{ID: "acme"})
	err := store.Begin(map[string]any{"acme.gone": 1.0}, nil, "")
	if err == nil || !strings.Contains(err.Error(), "unknown setting acme.gone") {
		t.Fatalf("the error is %v", err)
	}
}

// The application is written in the languages of its menu, its default language first, so the language it shows follows the system.
func TestTheApplicationIsWrittenInTheLanguagesOfItsMenu(t *testing.T) {
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	languages := catalog.AppLanguages()
	if len(languages) != len(catalog.MenuLanguages) || languages[0] != catalog.Default {
		t.Fatalf("the languages are %v of the menu languages %v with the default %s", languages, catalog.MenuLanguages, catalog.Default)
	}
	for _, language := range catalog.MenuLanguages {
		if !slices.Contains(languages, language.ID) {
			t.Fatalf("the languages %v lack %s", languages, language.ID)
		}
	}
}

// core.settings reports the common value of every setting apart from its effective value: a setting that the selected project
// overrides has its project value in values and its common value in common, the default when the common settings store none
// (docs/spec/settings.md#status).
func TestTheStatusReportsTheCommonValueOfEverySetting(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	if err := store.Begin(map[string]any{"gap": 8.0}, map[string]any{"gap": 12.0}, "prj-a"); err != nil {
		t.Fatal(err)
	}
	status := store.Status()
	if status.Values["gap"] != 12.0 || status.Common["gap"] != 8.0 {
		t.Fatalf("the gap is %v in values and %v in common", status.Values["gap"], status.Common["gap"])
	}
	if status.Common["mode"] != store.Defaults()["mode"] {
		t.Fatalf("the common mode is %v, not the default %v", status.Common["mode"], store.Defaults()["mode"])
	}
	if !slices.Equal(slices.Sorted(maps.Keys(status.Common)), slices.Sorted(maps.Keys(status.Values))) {
		t.Fatalf("common holds %v and values %v", slices.Sorted(maps.Keys(status.Common)), slices.Sorted(maps.Keys(status.Values)))
	}
}

// The sets and links of the settings are checked as validateSidebars and checkSidebarReferences of @soksak/plugin-api check them, with
// the same messages: a change that breaks a rule writes nothing, and a reference to a plugin that is not loaded is kept
// (docs/spec/settings.md#stored-sets-and-links).
func TestTheSetsAndLinksAreCheckedAsThePageChecksThem(t *testing.T) {
	var writes []saved
	store := settingsStore(t, &writes)
	store.Loaded(workbench.LoadedPlugin{ID: "acme", Surface: true, Sections: []workbench.LoadedSection{{ID: "acme.tree"}}})
	store.Loaded(workbench.LoadedPlugin{ID: "solo"})
	if err := store.Begin(nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	const good = `{"id":"a","title":"a","sections":["acme.tree"],"layout":"list"}`
	places := "settings: every link requires a place (left, right, window-left, window-right, card-left, card-right, card-top, card-bottom) and a known set"
	cases := []struct{ sets, links, want string }{
		{`{}`, `[]`, "settings: sidebars requires sets and links"},
		{`[{"id":"a","sections":[],"layout":"list"}]`, `[]`, "settings: every set requires id, title, and sections"},
		{`[{"id":"","title":"a","sections":[],"layout":"list"}]`, `[]`, "settings: every set requires id, title, and sections"},
		{`[{"id":"a","title":"a","sections":[],"layout":"list","color":"red"}]`, `[]`, "settings set a: unknown field color"},
		{`[{"id":"a","title":"","sections":[],"layout":"list"}]`, `[]`, "settings: set a title must be 1 to 40 characters"},
		{`[{"id":"a","title":"` + strings.Repeat("가", 41) + `","sections":[],"layout":"list"}]`, `[]`, "settings: set a title must be 1 to 40 characters"},
		{`[{"id":"a","title":"a","sections":[""],"layout":"list"}]`, `[]`, "settings: set a sections must be section ids"},
		{`[{"id":"a","title":"a","sections":["acme.tree","acme.tree"],"layout":"list"}]`, `[]`, "settings: set a lists section acme.tree twice"},
		{`[{"id":"a","title":"a","sections":[],"layout":"grid"}]`, `[]`, "settings: set a layout must be list or tabs"},
		{`[{"id":"off","title":"a","sections":[],"layout":"list"}]`, `[]`, "settings: set id off is reserved"},
		{`[` + good + `,` + good + `]`, `[]`, "settings: duplicate set a"},
		{`[` + good + `]`, `[{"place":"middle","plugin":null,"set":"a"}]`, places},
		{`[` + good + `]`, `[{"place":"left","plugin":null,"set":"a","x":1}]`, "settings link: unknown field x"},
		{`[` + good + `]`, `[{"place":"card-left","plugin":"","set":"a"}]`, "settings: a link plugin is null or a plugin id"},
		{`[` + good + `]`, `[{"place":"left","plugin":"acme","set":"a"}]`, "settings: a general window link requires plugin null"},
		{`[` + good + `]`, `[{"place":"card-left","plugin":null,"set":"a"}]`, "settings: a card-left link names a plugin"},
		{`[` + good + `]`, `[{"place":"card-left","plugin":"acme","set":"b"}]`, "settings: a card-left link requires a known set"},
		{`[` + good + `]`, `[{"place":"left","plugin":null,"set":"a"},{"place":"left","plugin":null,"set":"a"}]`, "settings: link left general appears twice"},
		{`[{"id":"a","title":"a","sections":["acme.gone"],"layout":"list"}]`, `[]`, "settings: set a names unknown section acme.gone"},
		{`[` + good + `]`, `[{"place":"card-left","plugin":"solo","set":"a"}]`, "settings: link names plugin solo without a surface"},
	}
	parse := func(text string) any {
		var value any
		if err := json.Unmarshal([]byte(text), &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, c := range cases {
		err := store.Set(map[string]any{"sets": parse(c.sets), "links": parse(c.links)}, "common")
		if err == nil || err.Error() != c.want {
			t.Errorf("sets %s links %s: %v, want %s", c.sets, c.links, err, c.want)
		}
	}
	if len(writes) != 0 {
		t.Fatalf("a refused change was written: %+v", writes)
	}
	// A link of a plugin that is not loaded keeps a set that only that plugin declared, and a set keeps a section of such a plugin.
	kept := map[string]any{"sets": parse(`[{"id":"a","title":"a","sections":["acme.tree","other.view"],"layout":"tabs"}]`),
		"links": parse(`[{"place":"card-left","plugin":"other","set":"other.side"},{"place":"left","plugin":null,"set":"a"}]`)}
	if err := store.Set(kept, "common"); err != nil {
		t.Fatalf("the references to a plugin that is not loaded are refused: %v", err)
	}
}

// A window takes the sets and links that the settings accepted, also a link of a plugin that is not loaded to a set that only that
// plugin declared, and its sidebars keep showing.
func TestAWindowTakesALinkThatTheSettingsKeep(t *testing.T) {
	f := sidebarShell(t)
	links := []any{map[string]any{"place": "left", "plugin": nil, "set": "set-install"},
		map[string]any{"place": "window-right", "plugin": "browser", "set": "set-browser"},
		map[string]any{"place": "card-left", "plugin": "other", "set": "other.side"}}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"links": links}})
	if name := element(t, f.tester, "core.sidebar.section.name", "left/files.tree"); name.Label != "파일 트리" {
		t.Fatalf("the left sidebar shows %q", name.Label)
	}
}

// core.settings declares overridden as an array in exposure.json, including
// an empty array before overrides exist and after the last reset.
func TestCoreSettingsOverriddenIsAnArrayAcrossEmptyAndReset(t *testing.T) {
	f := viewShell(t)
	read := func() []any {
		t.Helper()
		observed := status[map[string]any](t, f, "core.settings")
		keys, ok := observed["overridden"].([]any)
		if !ok {
			t.Fatalf("public core.settings.overridden must be an array, got %#v in %+v", observed["overridden"], observed)
		}
		return keys
	}
	initial := status[struct {
		Overridden []string `json:"overridden"`
	}](t, f, "core.settings")
	for _, key := range initial.Overridden {
		f.run("core.settings.reset", map[string]string{"key": key})
	}
	if keys := read(); len(keys) != 0 {
		t.Fatalf("reset settings retained overrides: %v", keys)
	}
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"gap": 10.0}, "scope": "project"})
	if keys := read(); !reflect.DeepEqual(keys, []any{"gap"}) {
		t.Fatalf("the actual project override is %v", keys)
	}
	f.run("core.settings.reset", map[string]string{"key": "gap"})
	if keys := read(); len(keys) != 0 {
		t.Fatalf("last reset retained overrides: %v", keys)
	}
}
