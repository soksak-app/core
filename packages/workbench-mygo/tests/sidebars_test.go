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
	{"id":"set-install","title":"탐색기","sections":["files.tree","gone.section","files.bookmarks"],"layout":"list"},
	{"id":"set-browser","title":"브라우저","sections":["browser.tabs","browser.history"],"layout":"tabs"}],
	"links":[{"place":"left","plugin":null,"set":"set-install"},{"place":"window-right","plugin":"browser","set":"set-browser"}]}}`

const sidebarsInstalled = `{"plugins":[
	{"id":"browser","package":"b","version":"1.0.0","manifest":{"id":"browser","name":"브라우저","description":"browser","sections":[
		{"id":"browser.tabs","name":"탭","composition":{"kind":"view","page":"ui/section.html"},"height":160},
		{"id":"browser.history","name":"기록","composition":{"kind":"view","page":"ui/section.html"},"height":"fill"}]}},
	{"id":"files","package":"f","version":"1.0.0","manifest":{"id":"files","name":"파일","description":"files","sections":[
		{"id":"files.tree","name":"파일 트리","composition":{"kind":"view","page":"ui/tree.html"},"height":"fill"},
		{"id":"files.bookmarks","name":"북마크","composition":{"kind":"view","page":"ui/bookmarks.html"},"height":160}]}}]}`

type sidebarsFixture struct {
	sidebars *workbench.Sidebars
	registry *workbench.Registry
	changes  int
	seats    []workbench.SidebarSeat
}

func newSidebars(t *testing.T, environment, installed string) *sidebarsFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	fixture := &sidebarsFixture{registry: workbench.NewRegistry(declared)}
	binder := workbench.NewBinder(fixture.registry, func(command string, err error) { t.Errorf("%s: %v", command, err) })
	fixture.sidebars, err = workbench.NewSidebars(workbench.SidebarsOptions{Declared: declared, Registry: fixture.registry, Binder: binder,
		Environment: []byte(environment), Installed: []byte(installed), Changed: func() { fixture.changes++ },
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
	if got := sectionIDs(frame); !reflect.DeepEqual(got, []string{"files.tree", "files.bookmarks"}) {
		t.Fatalf("the sections are %q", got)
	}
	if !frame.Sections[0].Fill || frame.Sections[1].Height != 160 || frame.Sections[1].Plugin != "files" || frame.Sections[0].Name != "파일 트리" {
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
	frame := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "browser"})
	if frame.Layout != "tabs" || frame.Tab != "browser.tabs" || frame.Status != "오른쪽 창 사이드바 · browser" {
		t.Fatalf("with the focus on the browser the frame is %+v", frame)
	}
	missing := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "gone"})
	if len(missing.Sections) != 0 || missing.Status != "오른쪽 창 사이드바" {
		t.Fatalf("a plugin that is not loaded chooses no content: %+v", missing)
	}
}

func TestPluginDefaultsApplyWithoutEnvironmentSidebars(t *testing.T) {
	installed := `{"plugins":[{"id":"files","package":"f","version":"1.0.0","manifest":{
		"sections":[{"id":"files.tree","name":"파일 트리","composition":{"kind":"view","page":"ui/tree.html"},"height":"fill"}],
		"sidebars":{"sets":[{"id":"main","title":"파일","sections":["files.tree"],"layout":"list"}],"window":{"right":"main"}}}}]}`
	f := newSidebars(t, `{}`, installed)
	frame := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "files"})
	if got := sectionIDs(frame); !reflect.DeepEqual(got, []string{"files.tree"}) {
		t.Fatalf("the sections are %q", got)
	}
}

func TestAnInstalledDocumentWithAnErrorIsRefused(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	registry := workbench.NewRegistry(declared)
	_, err = workbench.NewSidebars(workbench.SidebarsOptions{Declared: declared, Registry: registry, Binder: workbench.NewBinder(registry, nil),
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
	_, err = workbench.NewSidebars(workbench.SidebarsOptions{Declared: declared, Registry: registry, Binder: workbench.NewBinder(registry, nil),
		Environment: []byte(environment), Installed: []byte(`{"plugins":[]}`)})
	if err == nil || !strings.Contains(err.Error(), "link points at a set that is gone: set-gone") {
		t.Fatalf("the error is %v", err)
	}
}

func TestFoldingASectionFoldsItAndStoresTheChoice(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	f.frame(t, "left", workbench.FocusedSurface{})
	if err := f.run("core.sidebar.section.fold", `{"sidebar":"left","section":"files.tree"}`); err != nil {
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
	if want := `{"left":{"tab":null,"folded":["files.tree"]}}`; string(stored) != want {
		t.Fatalf("stored %s, want %s", stored, want)
	}
	if err := f.run("core.sidebar.section.fold", `{"sidebar":"left","section":"files.tree"}`); err != nil {
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
		if _, err := f.sidebars.Frame(place, "spc-1", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "browser"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.run("core.sidebar.section.size", `{"sidebar":"left","section":"files.bookmarks","height":200}`); err != nil {
		t.Fatal(err)
	}
	if err := f.run("core.sidebar.section.select", `{"sidebar":"right","section":"browser.history"}`); err != nil {
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
	if right := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "browser"}); right.Tab != "browser.history" {
		t.Fatalf("the selected tab is %q", right.Tab)
	}
}

func TestTheSectionCommandsRefuseWhatTheSidebarDoesNotHold(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	f.frame(t, "left", workbench.FocusedSurface{})
	cases := []struct{ name, params, want string }{
		{"core.sidebar.section.fold", `{"sidebar":"right","section":"files.tree"}`, "no sidebar right is drawn"},
		{"core.sidebar.section.fold", `{"sidebar":"left","section":"gone.section"}`, "sidebar left has no section gone.section"},
		{"core.sidebar.section.select", `{"sidebar":"left","section":"files.tree"}`, "sidebar left does not use the tabs layout"},
		{"core.sidebar.section.size", `{"sidebar":"left","section":"files.tree","height":31}`, "section height must be an integer from 32 to 4096, got 31"},
	}
	for _, test := range cases {
		if err := f.run(test.name, test.params); err == nil || err.Error() != test.want {
			t.Fatalf("%s %s: %v, want %s", test.name, test.params, err, test.want)
		}
	}
	f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "browser"})
	for _, name := range []string{"core.sidebar.section.fold", "core.sidebar.section.size"} {
		err := f.run(name, `{"sidebar":"right","section":"browser.tabs","height":100}`)
		if err == nil || err.Error() != "sidebar right does not use the list layout" {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestStoredChoicesComeBackWithASpace(t *testing.T) {
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	stored := `{"left":{"tab":null,"folded":["files.bookmarks"],"sizes":{"files.tree":120}},"right":{"tab":"browser.history","folded":[]}}`
	if err := f.sidebars.Restore(json.RawMessage(stored)); err != nil {
		t.Fatal(err)
	}
	left := f.frame(t, "left", workbench.FocusedSurface{})
	if !left.Sections[1].Folded || left.Sections[0].Size == nil || *left.Sections[0].Size != 120 {
		t.Fatalf("the sections are %+v", left.Sections)
	}
	if right := f.frame(t, "right", workbench.FocusedSurface{Card: "c1", Tab: "tab-1", Plugin: "browser"}); right.Tab != "browser.history" {
		t.Fatalf("the selected tab is %q", right.Tab)
	}
	if err := f.sidebars.Restore(nil); err != nil {
		t.Fatal(err)
	}
	if left := f.frame(t, "left", workbench.FocusedSurface{}); left.Sections[1].Folded {
		t.Fatal("a space without stored choices keeps the choices of the space before it")
	}
	err := f.sidebars.Restore(json.RawMessage(`{"left":{"tab":null,"folded":[],"sizes":{"files.tree":12}}}`))
	if err == nil || !strings.Contains(err.Error(), "sidebar left stores an invalid size of files.tree: 12") {
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
	if tree.SurfaceID != "spc-1/left/files.tree" || !tree.Visible || tree.Box.X != 10 || tree.Box.W != 190 {
		t.Fatalf("the seat of the tree is %+v", tree)
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	head, _ := declared.Metric("head-h")
	if tree.Box.Y != 20+head {
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
	if len(left.Sections) != 2 || left.Sections[0].SurfaceID != "spc-1/left/files.tree" {
		t.Fatalf("the status is %s", encoded)
	}
}
