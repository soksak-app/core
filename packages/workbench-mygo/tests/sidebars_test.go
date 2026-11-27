// The sidebars of a window: the set that each sidebar shows, its choices and the commands of its sections
// (docs/spec/plugins.md#sections).
package workbench_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

const sidebarsEnvironment = `{"sidebars":{"sets":[
	{"id":"set-install","title":"탐색기","sections":["fieldprobe.tree","gone.section","fieldprobe.bookmarks"],"layout":"list"},
	{"id":"set-boxprobe","title":"브라우저","sections":["boxprobe.tabs","boxprobe.history"],"layout":"tabs"}],
	"links":[{"place":"left","plugin":null,"set":"set-install"},{"place":"window-right","plugin":"boxprobe","set":"set-boxprobe"}]}}`

const sidebarsInstalled = `{"plugins":[
	{"id":"boxprobe","package":"b","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"boxprobe","name":"브라우저","description":"boxprobe","mark":"www","icon":"<path d=\"M1 1h14\"/>","surface":{"composition":{"kind":"view","page":"ui/index.html"}},"sections":[
		{"id":"boxprobe.tabs","name":"탭","composition":{"kind":"view","page":"ui/section.html"},"height":160},
		{"id":"boxprobe.history","name":"기록","composition":{"kind":"view","page":"ui/section.html"},"height":"fill"},
		{"id":"boxprobe.dom","name":"DOM","composition":{"kind":"view","page":"ui/section.html"},"height":"fill"},
		{"id":"boxprobe.network","name":"네트워크","composition":{"kind":"view","page":"ui/section.html"},"height":"fill"}]}},
	{"id":"fieldprobe","package":"f","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"fieldprobe","name":"파일","description":"fieldprobe","sections":[
		{"id":"fieldprobe.tree","name":"파일 트리","composition":{"kind":"view","page":"ui/tree.html"},"height":"fill"},
		{"id":"fieldprobe.bookmarks","name":"북마크","composition":{"kind":"view","page":"ui/bookmarks.html"},"height":160}]}}]}`

type sidebarsFixture struct {
	sidebars *workbench.Sidebars
	registry *workbench.Registry
	notices  *workbench.ShownErrors
	changes  int
	seats    []workbench.SidebarSeat
}

func newSidebars(t *testing.T, environment, installed string) *sidebarsFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	fixture := &sidebarsFixture{registry: workbench.NewRegistry(declared), notices: workbench.NewShownErrors(func(string) {})}
	binder := workbench.NewBinder(fixture.registry, func(command string, err error) { t.Errorf("%s: %v", command, err) })
	fixture.sidebars, err = workbench.NewSidebars(workbench.SidebarsOptions{Look: func() (float32, float32) { return 1, 10 }, Declared: declared, Registry: fixture.registry, Binder: binder,
		Environment: []byte(environment), Installed: []byte(installed), Notices: fixture.notices, Changed: func() { fixture.changes++ },
		Seat: func(_ *ui.Context, seat workbench.SidebarSeat) { fixture.seats = append(fixture.seats, seat) }})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (f *sidebarsFixture) frame(t *testing.T, place string, focused workbench.FocusedSurface) workbench.SidebarFrame {
	t.Helper()
	f.sidebars.Begin()
	frame, err := f.sidebars.Frame(place, "spc-1", focused)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func (f *sidebarsFixture) run(name, params string) error {
	_, err := f.registry.Run(name, json.RawMessage(params))
	return err
}

func sectionIDs(frame workbench.SidebarFrame) []string {
	ids := []string{}
	for _, section := range frame.Sections {
		ids = append(ids, section.ID)
	}
	return ids
}

func TestAWindowSidebarShowsTheLoadedSectionsOfItsSet(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	frame := f.frame(t, "left", workbench.FocusedSurface{})
	if frame.Sidebar != "left" || frame.Side != "left" || frame.Layout != "list" || frame.Orientation != "vertical" {
		t.Fatalf("the frame is %+v", frame)
	}
	if got := sectionIDs(frame); !reflect.DeepEqual(got, []string{"fieldprobe.tree", "fieldprobe.bookmarks"}) {
		t.Fatalf("the sections are %q", got)
	}
	if !frame.Sections[0].Fill || frame.Sections[1].Height != 160 || frame.Sections[1].Plugin != "fieldprobe" || frame.Sections[0].Name != "파일 트리" {
		t.Fatalf("the sections are %+v", frame.Sections)
	}
	if frame.Status != "왼쪽 창 사이드바" {
		t.Fatalf("the status line says %q", frame.Status)
	}
	if page := string(frame.Sections[0].Composition); !strings.Contains(page, "ui/tree.html") {
		t.Fatalf("the composition of the section is %s", page)
	}
}

func TestTheFocusedPluginChoosesItsWindowSidebar(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	if frame := f.frame(t, "right", workbench.FocusedSurface{}); len(frame.Sections) != 0 || frame.Status != "오른쪽 창 사이드바" {
		t.Fatalf("without a focus the right sidebar shows %+v", frame)
	}
	frame := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "boxprobe"})
	if frame.Layout != "tabs" || frame.Tab != "boxprobe.tabs" || frame.Status != "오른쪽 창 사이드바 · boxprobe" {
		t.Fatalf("with the focus on the boxprobe the frame is %+v", frame)
	}
	missing := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "gone"})
	if len(missing.Sections) != 0 || missing.Status != "오른쪽 창 사이드바" {
		t.Fatalf("a plugin that is not loaded chooses no content: %+v", missing)
	}
}

func TestPluginDefaultsApplyWithoutEnvironmentSidebars(t *testing.T) {
	installed := `{"plugins":[{"id":"fieldprobe","package":"f","version":"1.0.0","folder": "/installed/plugin", "manifest":{
		"sections":[{"id":"fieldprobe.tree","name":"파일 트리","composition":{"kind":"view","page":"ui/tree.html"},"height":"fill"}],
		"sidebars":{"sets":[{"id":"main","title":"파일","sections":["fieldprobe.tree"],"layout":"list"}],"window":{"right":"main"}}}}]}`
	f := newSidebars(t, `{}`, installed)
	frame := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "fieldprobe"})
	if got := sectionIDs(frame); !reflect.DeepEqual(got, []string{"fieldprobe.tree"}) {
		t.Fatalf("the sections are %q", got)
	}
}

func TestAnInstalledDocumentWithAnErrorIsRefused(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	registry := workbench.NewRegistry(declared)
	_, err = workbench.NewSidebars(workbench.SidebarsOptions{Look: func() (float32, float32) { return 1, 10 }, Declared: declared, Registry: registry, Binder: workbench.NewBinder(registry, nil),
		Environment: []byte(sidebarsEnvironment), Installed: []byte(`{"error":"plugins cannot be read"}`)})
	if err == nil || !strings.Contains(err.Error(), "plugins cannot be read") {
		t.Fatalf("the error is %v", err)
	}
}

func TestALinkToASetThatIsGoneIsRefused(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	registry := workbench.NewRegistry(declared)
	environment := `{"sidebars":{"sets":[],"links":[{"place":"left","plugin":null,"set":"set-gone"}]}}`
	_, err = workbench.NewSidebars(workbench.SidebarsOptions{Look: func() (float32, float32) { return 1, 10 }, Declared: declared, Registry: registry, Binder: workbench.NewBinder(registry, nil),
		Environment: []byte(environment), Installed: []byte(`{"plugins":[]}`)})
	if err == nil || !strings.Contains(err.Error(), "environment.json: a left link requires a known set") {
		t.Fatalf("the error is %v", err)
	}
}

func TestFoldingASectionFoldsItAndStoresTheChoice(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	f.frame(t, "left", workbench.FocusedSurface{})
	if err := f.run("core.sidebar.section.fold", `{"sidebar":"left","section":"fieldprobe.tree"}`); err != nil {
		t.Fatal(err)
	}
	if frame := f.frame(t, "left", workbench.FocusedSurface{}); !frame.Sections[0].Folded || frame.Sections[1].Folded {
		t.Fatalf("the sections are %+v", frame.Sections)
	}
	if f.changes != 1 {
		t.Fatalf("%d changes", f.changes)
	}
	stored, err := json.Marshal(f.sidebars.Stored())
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"left":{"tab":null,"folded":["fieldprobe.tree"]}}`; string(stored) != want {
		t.Fatalf("stored %s, want %s", stored, want)
	}
	if err := f.run("core.sidebar.section.fold", `{"sidebar":"left","section":"fieldprobe.tree"}`); err != nil {
		t.Fatal(err)
	}
	if frame := f.frame(t, "left", workbench.FocusedSurface{}); frame.Sections[0].Folded {
		t.Fatal("a second fold does not open the section")
	}
}

func TestSizingAndSelectingASection(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	f.sidebars.Begin()
	for _, place := range []string{"left", "right"} {
		if _, err := f.sidebars.Frame(place, "spc-1", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "boxprobe"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.run("core.sidebar.section.size", `{"sidebar":"left","heights":{"fieldprobe.bookmarks":200}}`); err != nil {
		t.Fatal(err)
	}
	if err := f.run("core.sidebar.section.select", `{"sidebar":"right","section":"boxprobe.history"}`); err != nil {
		t.Fatal(err)
	}
	f.sidebars.Begin()
	left, err := f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
	if err != nil {
		t.Fatal(err)
	}
	if size := left.Sections[1].Size; size == nil || *size != 200 {
		t.Fatalf("the size of the section is %v", size)
	}
	if right := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "boxprobe"}); right.Tab != "boxprobe.history" {
		t.Fatalf("the selected tab is %q", right.Tab)
	}
}

func TestTheSectionCommandsRefuseWhatTheSidebarDoesNotHold(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	f.frame(t, "left", workbench.FocusedSurface{})
	cases := []struct{ name, params, want string }{
		{"core.sidebar.section.fold", `{"sidebar":"right","section":"fieldprobe.tree"}`, "no sidebar right is drawn"},
		{"core.sidebar.section.fold", `{"sidebar":"left","section":"gone.section"}`, "sidebar left has no section gone.section"},
		{"core.sidebar.section.select", `{"sidebar":"left","section":"fieldprobe.tree"}`, "sidebar left does not use the tabs layout"},
		{"core.sidebar.section.size", `{"sidebar":"left","heights":{}}`, "section heights must name at least one section, got {}"},
		{"core.sidebar.section.size", `{"sidebar":"left","heights":{"fieldprobe.tree":31}}`, "section height must be an integer from 32 to 4096, got 31"},
	}
	for _, test := range cases {
		if err := f.run(test.name, test.params); err == nil || err.Error() != test.want {
			t.Fatalf("%s %s: %v, want %s", test.name, test.params, err, test.want)
		}
	}
	f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "boxprobe"})
	for name, params := range map[string]string{
		"core.sidebar.section.fold": `{"sidebar":"right","section":"boxprobe.tabs"}`,
		"core.sidebar.section.size": `{"sidebar":"right","heights":{"boxprobe.tabs":100}}`,
	} {
		err := f.run(name, params)
		if err == nil || err.Error() != "sidebar right does not use the list layout" {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestStoredChoicesComeBackWithASpace(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	stored := `{"left":{"tab":null,"folded":["fieldprobe.bookmarks"],"sizes":{"fieldprobe.tree":120}},"right":{"tab":"boxprobe.history","folded":[]}}`
	if err := f.sidebars.Restore(json.RawMessage(stored)); err != nil {
		t.Fatal(err)
	}
	left := f.frame(t, "left", workbench.FocusedSurface{})
	if !left.Sections[1].Folded || left.Sections[0].Size == nil || *left.Sections[0].Size != 120 {
		t.Fatalf("the sections are %+v", left.Sections)
	}
	if right := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "boxprobe"}); right.Tab != "boxprobe.history" {
		t.Fatalf("the selected tab is %q", right.Tab)
	}
	if err := f.sidebars.Restore(nil); err != nil {
		t.Fatal(err)
	}
	if left := f.frame(t, "left", workbench.FocusedSurface{}); left.Sections[1].Folded {
		t.Fatal("a space without stored choices keeps the choices of the space before it")
	}
	err := f.sidebars.Restore(json.RawMessage(`{"left":{"tab":null,"folded":[],"sizes":{"fieldprobe.tree":12}}}`))
	if err == nil || !strings.Contains(err.Error(), "sidebar left stores an invalid size of fieldprobe.tree: 12") {
		t.Fatalf("the error is %v", err)
	}
}

func TestDrawingASidebarGivesEverySeatItsPlaceInTheWindow(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	var frame workbench.SidebarFrame
	var failed error
	tt := ui.NewTester(func(c *ui.Context) {
		f.seats = f.seats[:0]
		f.sidebars.Begin()
		frame, failed = f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if failed == nil {
			f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
		}
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	element(t, tt, "core.sidebar", "left")
	if len(f.seats) != 2 {
		t.Fatalf("the seats are %+v", f.seats)
	}
	tree := f.seats[0]
	if tree.SurfaceID != "spc-1/left/fieldprobe.tree" || !tree.Visible || tree.Box.X != 10 || tree.Box.W != 190 {
		t.Fatalf("the seat of the tree is %+v", tree)
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	head, _ := declared.Metric("head-h")
	foot, _ := declared.Metric("foot-h")
	// The head row of the window sidebar stands above the set, and the warning of gone.section, whose plugin is not loaded, stands in the
	// status line at the bottom, so the first section starts below the head row alone.
	if tree.Box.Y != 20+foot+head {
		t.Fatalf("the seat of the tree starts at %v", tree.Box.Y)
	}
}

func TestStatusReportsTheDrawnSidebars(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	var failed error
	ui.NewTester(func(c *ui.Context) {
		f.sidebars.Begin()
		var frame workbench.SidebarFrame
		frame, failed = f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if failed == nil {
			f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
		}
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	value, err := f.registry.Read("core.sidebars")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var sidebars []struct {
		Sidebar, Set, Layout, Orientation, Placement string
		Card                                         *string
		Rect                                         struct{ X, Y, W, H float64 }
		Sections                                     []struct {
			ID, SurfaceID string
			Folded        bool
		}
	}
	if err := json.Unmarshal(encoded, &sidebars); err != nil {
		t.Fatal(err)
	}
	if len(sidebars) != 1 {
		t.Fatalf("the status is %s", encoded)
	}
	left := sidebars[0]
	if left.Sidebar != "left" || left.Set != "set-install" || left.Placement != "window" || left.Card != nil || left.Rect.W != 190 || left.Rect.X != 10 {
		t.Fatalf("the status is %s", encoded)
	}
	if len(left.Sections) != 2 || left.Sections[0].SurfaceID != "spc-1/left/fieldprobe.tree" {
		t.Fatalf("the status is %s", encoded)
	}
}

// TestTheTopAndBottomWindowSidebarsLieHorizontally checks the frame of the top and bottom window sidebars
// (docs/spec/external-sidebars.md).
func TestTheTopAndBottomWindowSidebarsLieHorizontally(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	f.sidebars.Begin()
	for place, status := range map[string]string{"top": "위 창 사이드바", "bottom": "아래 창 사이드바", "left": "왼쪽 창 사이드바"} {
		frame, err := f.sidebars.Frame(place, "spc-1", workbench.FocusedSurface{})
		if err != nil {
			t.Fatal(err)
		}
		orientation := "horizontal"
		if place == "left" {
			orientation = "vertical"
		}
		if frame.Orientation != orientation || frame.Status != status || frame.Side != place {
			t.Fatalf("the frame of %s is %s %q %s", place, frame.Orientation, frame.Status, frame.Side)
		}
	}
}

// goneInstalled installs the plugin gone, whose section gone.section the set of the environment names.
const goneInstalled = `{"plugins":[
	{"id":"gone","package":"g","version":"1.0.0","folder": "/installed/plugin", "manifest":{"id":"gone","name":"고","description":"gone","sections":[
		{"id":"gone.section","name":"고 섹션","composition":{"kind":"view","page":"ui/s.html"},"height":160}]}}]}`

// A section whose plugin is not loaded is kept in the frame as a missing section, and the sidebar draws only the sections that it can draw
// (docs/spec/plugins.md#missing-plugins).
func TestAWindowSidebarNamesTheSectionsThatItCannotDraw(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	frame := f.frame(t, "left", workbench.FocusedSurface{})
	if want := []workbench.MissingSection{{ID: "gone.section", Plugin: "gone"}}; !reflect.DeepEqual(frame.Missing, want) {
		t.Fatalf("the missing sections are %+v, want %+v", frame.Missing, want)
	}
	if got := sectionIDs(frame); !reflect.DeepEqual(got, []string{"fieldprobe.tree", "fieldprobe.bookmarks"}) {
		t.Fatalf("the drawn sections are %q", got)
	}
}

// The line of a plugin that is not loaded names it and gives the remedy of its state: the install button only when the catalog lists it,
// the enable button when it is disabled, and the installed-plugins button when the window refused it (docs/spec/plugins.md#missing-plugins).
func TestTheMissingLineNamesThePluginAndItsRemedy(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	frame := f.frame(t, "left", workbench.FocusedSurface{})
	cases := []struct {
		name, state, text, label, command string
	}{
		{"고", "available", "플러그인이 없어 섹션 1개를 못 보여 준다.", "고 설치", "core.plugins.install"},
		{"gone", "", "플러그인이 없어 섹션 1개를 못 보여 준다.", "", ""},
		{"고", "disabled", "플러그인이 꺼져 있어 섹션 1개를 못 보여 준다.", "켜기", "core.plugins.enable"},
		{"고", "refused", "플러그인을 불러오지 못해 섹션 1개를 못 보여 준다.", "설치됨 보기", "core.plugins.browse"},
		{"고", "requires", "플러그인을 불러오지 못해 섹션 1개를 못 보여 준다.", "설치됨 보기", "core.plugins.browse"},
	}
	for _, c := range cases {
		lines := workbench.MissingLines(frame, func(id string) workbench.PluginLine {
			return workbench.PluginLine{Name: c.name, State: c.state}
		})
		if len(lines) != 1 || lines[0].Plugin != "gone" || lines[0].Count != 1 || lines[0].Text != c.text {
			t.Fatalf("the state %q gives the line %+v, want the text %q", c.state, lines, c.text)
		}
		if c.label == "" {
			if lines[0].Action != nil {
				t.Fatalf("the state %q has the button %+v, want none", c.state, lines[0].Action)
			}
			continue
		}
		if lines[0].Action == nil || lines[0].Action.Label != c.label || lines[0].Action.Command != c.command {
			t.Fatalf("the state %q has the button %+v, want %s %s", c.state, lines[0].Action, c.label, c.command)
		}
		if c.command != "core.plugins.browse" && lines[0].Action.Params["plugin"] != "gone" {
			t.Fatalf("the button %s runs with %+v, want the plugin gone", c.command, lines[0].Action.Params)
		}
	}
}

// When the plugin loads, its section is drawn and the line of the plugin ends (docs/spec/plugins.md#missing-plugins).
func TestTheMissingLineEndsWhenThePluginLoads(t *testing.T) {
	var document struct {
		Plugins []json.RawMessage `json:"plugins"`
	}
	for _, text := range []string{sidebarsInstalled, goneInstalled} {
		var part struct {
			Plugins []json.RawMessage `json:"plugins"`
		}
		if err := json.Unmarshal([]byte(text), &part); err != nil {
			t.Fatal(err)
		}
		document.Plugins = append(document.Plugins, part.Plugins...)
	}
	installed, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	f := newSidebars(t, sidebarsEnvironment, string(installed))
	frame := f.frame(t, "left", workbench.FocusedSurface{})
	if len(frame.Missing) != 0 {
		t.Fatalf("the loaded plugins leave the missing sections %+v", frame.Missing)
	}
	if got := sectionIDs(frame); !reflect.DeepEqual(got, []string{"fieldprobe.tree", "gone.section", "fieldprobe.bookmarks"}) {
		t.Fatalf("the drawn sections are %q", got)
	}
	if lines := workbench.MissingLines(frame, nil); len(lines) != 0 {
		t.Fatalf("the loaded plugins leave the lines %+v", lines)
	}
}

// Drawing a sidebar whose set holds a section of a plugin that is not loaded draws the line of that plugin with the element
// core.sidebar.missing of the plugin, above the sections (docs/spec/plugins.md#missing-plugins).
func TestDrawingASidebarShowsTheLineOfAMissingPlugin(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	var failed error
	tt := ui.NewTester(func(c *ui.Context) {
		f.sidebars.Begin()
		frame, err := f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if err != nil {
			failed = err
			return
		}
		f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	if !tt.HasText("gone(gone) · 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatalf("the sidebar shows %q", tt.Texts())
	}
}

// A missing section of a tab layout has a dimmed tab with its id struck through; the tab selects nothing, and the loaded tab is selected
// (docs/spec/plugins.md#missing-plugins).
func TestAMissingSectionOfATabLayoutHasADimmedTab(t *testing.T) {
	environment := `{"sidebars":{"sets":[{"id":"set-tabs","title":"탭","sections":["gone.section","fieldprobe.tree"],"layout":"tabs"}],
		"links":[{"place":"left","plugin":null,"set":"set-tabs"}]}}`
	f := newSidebars(t, environment, sidebarsInstalled)
	var failed error
	var frame workbench.SidebarFrame
	tt := ui.NewTester(func(c *ui.Context) {
		f.sidebars.Begin()
		var err error
		frame, err = f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if err != nil {
			failed = err
			return
		}
		f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	if frame.Tab != "fieldprobe.tree" {
		t.Fatalf("the selected tab is %q, want the loaded section", frame.Tab)
	}
	// The tabs keep the order of the set: the missing section keeps its place before the loaded one.
	if want := []string{"gone.section", "fieldprobe.tree"}; !reflect.DeepEqual(frame.Order, want) {
		t.Fatalf("the tabs are in the order %q, want %q", frame.Order, want)
	}
	if !tt.HasText("gone.section") {
		t.Fatalf("the tabs show %q", tt.Texts())
	}
}
