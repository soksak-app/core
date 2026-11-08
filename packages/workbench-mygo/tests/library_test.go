package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// libraryRead is the part of the status core.library that the page of the projects draws.
type libraryRead struct {
	Page          string            `json:"page"`
	Shown         []string          `json:"shown"`
	Count         string            `json:"count"`
	Query         string            `json:"query"`
	Sort          string            `json:"sort"`
	Empty         bool              `json:"empty"`
	NoResults     bool              `json:"noResults"`
	ReturnVisible bool              `json:"returnVisible"`
	FolderErrors  map[string]string `json:"folderErrors"`
	PreviewErrors map[string]string `json:"previewErrors"`
	Previews      map[string][]struct {
		Card string  `json:"card"`
		X    float64 `json:"x"`
		Y    float64 `json:"y"`
		W    float64 `json:"w"`
		H    float64 `json:"h"`
	} `json:"previews"`
}

// libraryOfTwoProjects returns a shell on the library page with the projects alpha and beta, of which beta is open.
func libraryOfTwoProjects(t *testing.T) (f *shellFixture, alpha, beta string) {
	t.Helper()
	f, alpha, beta = twoProjects(t)
	f.run("core.projects.browse", nil)
	f.settle()
	return f, alpha, beta
}

func TestTheLibraryHeadHasTheSearchAndTheSort(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	for _, name := range []string{"core.library.search", "core.library.sort", "core.library.add", "core.library.return"} {
		if !f.has(name, "") {
			t.Fatalf("the library has no %s", name)
		}
	}
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.settle()
	if f.has("core.library.search", "") || f.has("core.library.sort", "") || !f.has("core.library.plugins.search", "") {
		t.Fatal("the plugin page shows the controls of the projects")
	}
	f.run("core.library.page", map[string]string{"page": "projects"})
	f.settle()
	f.run("core.library.search", map[string]string{"query": "BETA"})
	f.settle()
	got := status[libraryRead](t, f, "core.library")
	if len(got.Shown) != 1 || got.Shown[0] != beta || f.has("core.library.open", alpha) {
		t.Fatalf("the search shows %v", got.Shown)
	}
	f.run("core.library.search", map[string]string{"query": "nothing"})
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); !got.NoResults || !f.has("core.library.no-results", "") || !f.tester.HasText("일치하는 프로젝트가 없습니다.") {
		t.Fatalf("the library shows %q", f.tester.Texts())
	}
	if !f.has("core.library.add", "") {
		t.Fatal("no result hides the card that adds a project")
	}
}

func TestTheSearchTakesTheFocusOfItsPage(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	type focused struct {
		Name string `json:"name"`
	}
	f.run("core.library.search.focus", nil)
	f.settle()
	if got := status[*focused](t, f, "core.focus"); got == nil || got.Name != "core.library.search" {
		t.Fatalf("the focus is %+v", got)
	}
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.settle()
	f.run("core.library.search.focus", nil)
	f.settle()
	if got := status[*focused](t, f, "core.focus"); got == nil || got.Name != "core.library.plugins.search" {
		t.Fatalf("the focus is %+v", got)
	}
	f.run("core.library.return", nil)
	f.settle()
	if _, err := f.answer("core.library.search.focus", nil); err == nil || err.Error() != "the library is not shown" {
		t.Fatalf("the command answered %v", err)
	}
}

// savedAndOpened returns a shell with a saved project that the window never opened, then a project that it opened.
func savedAndOpened(t *testing.T, host *storedHost) (f *shellFixture, saved, opened string) {
	t.Helper()
	host.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "other"))}
	saved = host.projects[0]["id"].(string)
	f = newShell(t, host)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/beta"})
	f.run("core.library.form.submit", nil)
	f.settle()
	f.run("core.projects.browse", nil)
	f.settle()
	return f, saved, f.host.projects[1]["id"].(string)
}

func TestTheSortOrdersTheProjects(t *testing.T) {
	f, saved, opened := savedAndOpened(t, &storedHost{})
	f.run("core.library.sort", map[string]string{"order": "open"})
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); got.Sort != "open" || !slices.Equal(got.Shown, []string{opened, saved}) {
		t.Fatalf("the open project is not first in %v of %s and %s", got.Shown, saved, opened)
	}
	if _, err := f.answer("core.library.sort", map[string]string{"order": "size"}); err == nil || err.Error() != "unknown sort size" {
		t.Fatalf("the command answered %v", err)
	}
}

// Every project that the window opened is open, and not only the shown one, so the sort keeps their saved order.
func TestEveryProjectOfTheWindowIsOpen(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	f.run("core.library.sort", map[string]string{"order": "open"})
	f.settle()
	got := status[libraryRead](t, f, "core.library")
	if !slices.Equal(got.Shown, []string{alpha, beta}) || got.Count != "프로젝트 2 · 열림 2" {
		t.Fatalf("the library shows %v and %q", got.Shown, got.Count)
	}
	for _, project := range status[[]map[string]any](t, f, "core.projects") {
		if project["open"] != true {
			t.Fatalf("the project %v is not open", project["id"])
		}
	}
}

// A project that another window owns is open here too, as the snapshot of the store tells.
func TestAProjectOfAnotherWindowIsOpen(t *testing.T) {
	host := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"))}}
	host.open = []string{host.projects[0]["id"].(string)}
	f := newShell(t, host)
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); got.Count != "프로젝트 1 · 열림 1" {
		t.Fatalf("the count is %q", got.Count)
	}
}

// A change of the store tells that another window has released its project.
func TestTheOpenProjectsFollowTheStore(t *testing.T) {
	host := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"))}}
	host.open = []string{host.projects[0]["id"].(string)}
	f := newShell(t, host)
	f.settle()
	host.open = nil
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); got.Count != "프로젝트 1 · 열림 0" {
		t.Fatalf("the count is %q", got.Count)
	}
}

// Closing the shown project shows another project of the window and never opens one that the window did not open.
func TestClosingTheShownProjectLeavesTheSavedOnes(t *testing.T) {
	f, saved, opened := savedAndOpened(t, &storedHost{})
	f.run("core.library.open", map[string]string{"id": opened})
	f.settle()
	f.run("core.project.close", map[string]string{"id": opened})
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); got.ReturnVisible {
		t.Fatalf("the window took the project %s that it did not open: %+v", saved, got)
	}
}

// The name order reads as a person does, whatever the case of a letter.
func TestTheNameOrderIgnoresTheCase(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	if _, err := f.answerLater("core.project.rename", map[string]string{"id": alpha, "title": "beta"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.answerLater("core.project.rename", map[string]string{"id": beta, "title": "Alpha"}); err != nil {
		t.Fatal(err)
	}
	f.settle()
	f.run("core.library.sort", map[string]string{"order": "name"})
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); !slices.Equal(got.Shown, []string{beta, alpha}) {
		t.Fatalf("the order is %v of Alpha %s and beta %s", got.Shown, beta, alpha)
	}
}

func TestAProjectCardShowsItsLayoutAndItsState(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	got := status[libraryRead](t, f, "core.library")
	panes := got.Previews[alpha]
	if len(panes) == 0 {
		t.Fatalf("the preview of %s has no pane: %+v", alpha, got.Previews)
	}
	card := f.box("core.library.open", alpha)
	for _, pane := range panes {
		if pane.W <= 0 || pane.H <= 0 || pane.X < float64(card.X) || pane.X+pane.W > float64(card.X+card.W) || pane.Y < float64(card.Y) {
			t.Fatalf("the pane %+v is outside the card %v", pane, card)
		}
	}
	for _, text := range []string{"스페이스 1", "열림", "프로젝트 2 · 열림 2", "alpha", "/work/alpha"} {
		if !f.tester.HasText(text) {
			t.Fatalf("the library shows %q, without %q", f.tester.Texts(), text)
		}
	}
	if !f.has("core.library.pin", beta) || !f.has("core.library.remove", beta) {
		t.Fatal("a card has no pin or remove")
	}
	pin, remove := f.box("core.library.pin", beta), f.box("core.library.remove", beta)
	if remove.X >= pin.X || remove.Y != pin.Y {
		t.Fatalf("the actions stand at %v and %v", remove, pin)
	}
}

// The cards fill the width in columns of at least the declared width.
func TestTheCardsOfTheLibraryStandInColumns(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	a, b := f.box("core.library.open", alpha), f.box("core.library.open", beta)
	if a.Y != b.Y || b.X <= a.X+a.W || a.W < 245 {
		t.Fatalf("the cards stand at %v and %v", a, b)
	}
	f.tester.SetSize(400, 800)
	f.settle()
	a, b = f.box("core.library.open", alpha), f.box("core.library.open", beta)
	if a.X != b.X || b.Y <= a.Y {
		t.Fatalf("in a narrow window the cards stand at %v and %v", a, b)
	}
}

func TestTheEmptyLibraryNamesTheStart(t *testing.T) {
	f := newShell(t, &storedHost{})
	if got := status[libraryRead](t, f, "core.library"); !got.Empty || !f.has("core.library.empty", "") {
		t.Fatalf("the status is %+v", got)
	}
}

// A project whose folder cannot be read shows the reason, cannot be opened, and can be removed.
func TestTheEmptyLibraryTakesTheHeightOfThePage(t *testing.T) {
	f := newShell(t, &storedHost{})
	// .library-empty: two paddings of 16, h2 at .83em above, the larger of the margins between h2 and p, and 1em under p.
	if box := f.box("core.library.empty", ""); box.H < 102 || box.H > 104 {
		t.Fatalf("the empty library is %+v", box)
	}
}

func TestAProjectWithoutItsFolderShowsTheReason(t *testing.T) {
	g := openedShell(t)
	id := g.host.projects[0]["id"].(string)
	g.host.failing = map[string]error{"projectFolder": fmt.Errorf("project directory does not exist: /work/alpha")}
	if _, err := g.shell.Registry().Run("core.projects.browse", nil); err != nil {
		t.Fatal(err)
	}
	g.tester.Frame()
	g.pending.drain(t)
	g.tester.Frame()
	got := status[libraryRead](t, g, "core.library")
	if got.FolderErrors[id] == "" || !g.tester.HasText("폴더가 없습니다.") {
		t.Fatalf("the status is %+v and the library shows %q", got, g.tester.Texts())
	}
	card := g.box("core.library.open", id)
	g.tester.ClickAt(card.X+card.W/2, card.Y+card.H/2)
	g.pending.drain(t)
	g.tester.Frame()
	if got := status[libraryRead](t, g, "core.library"); len(got.Shown) != 1 || !g.has("core.library.remove", id) {
		t.Fatal("the card of a missing folder opened")
	}
}

func TestTheSortReadsFromTheLeftWithItsArrowInTheMiddle(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	trigger := f.box("core.library.sort", "")
	label, ok := f.tester.Find("저장 순서")
	if !ok {
		t.Fatal("the sort shows no order")
	}
	if inset := label.X - trigger.X; inset > 10 {
		t.Fatalf("the order stands %v from the edge of its select at %+v", inset, trigger)
	}
	arrow, ok := f.tester.Find("▾")
	if !ok {
		t.Fatal("the sort shows no arrow")
	}
	if off := arrow.Y + arrow.H/2 - (trigger.Y + trigger.H/2); off < -1 || off > 1 {
		t.Fatalf("the arrow at %+v stands %v off the middle of %+v", arrow, off, trigger)
	}
}

func TestTheFormButtonsTakeTheWidthOfTheirLabel(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.tester.Frame()
	choose, field := f.box("core.library.form.choose", ""), f.box("core.library.form.parent", "")
	if choose.W >= field.W/2 {
		t.Fatalf("the choose button is %+v under the field %+v", choose, field)
	}
}

func TestTheLibraryKeepsItsSizeWhenTheFrameTextGrows(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	before, _ := f.tester.Find("저장 순서")
	f.run("core.text.larger", nil)
	f.tester.Frame()
	after, ok := f.tester.Find("저장 순서")
	if !ok || after.H != before.H {
		t.Fatalf("the text was %+v and is %+v", before, after)
	}
}

func TestTheLibraryHidesTheSidebarSwitches(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	if f.has("core.chrome.left", "") || f.has("core.chrome.right", "") {
		t.Fatal("the library shows the switches of the sidebars")
	}
	if !f.has("core.chrome.mode", "") || !f.has("core.chrome.settings", "") {
		t.Fatal("the library lost the other switches")
	}
	f.run("core.library.return", nil)
	f.tester.Frame()
	if !f.has("core.chrome.left", "") || !f.has("core.chrome.right", "") {
		t.Fatal("the work screen has no switches of the sidebars")
	}
}

func TestACardShowsTheDayItsProjectOpened(t *testing.T) {
	f := openedShell(t)
	f.run("core.projects.browse", nil)
	f.tester.Frame()
	now := time.Now()
	if day := fmt.Sprintf("%d월 %d일", now.Month(), now.Day()); !f.tester.HasText(day) {
		t.Fatalf("the library shows %q, without %q", f.tester.Texts(), day)
	}
}

func TestTheLinesOfTheLibraryHaveTheHeightOfThePage(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	// .text-field: a line of text-control at the line height of the page, two paddings of 5 and two borders.
	if field := f.box("core.library.search", ""); field.H < 28 || field.H > 29.5 {
		t.Fatalf("the search is %+v", field)
	}
}

func TestTheFormStandsAsThePageStandsIt(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.tester.Frame()
	first, second := f.box("core.library.form.mode-new", ""), f.box("core.library.form.mode-existing", "")
	if first.X+first.W != second.X {
		t.Fatalf("the two modes stand at %+v and %+v", first, second)
	}
	// The title of the field follows the modes without a gap: a line of the page and the gap of a label.
	field := f.box("core.library.form.parent", "")
	if gap := field.Y - (first.Y + first.H); gap < 24 || gap > 27 {
		t.Fatalf("the field stands %v under the modes", gap)
	}
	choose, cancel := f.box("core.library.form.choose", ""), f.box("core.library.form.cancel", "")
	if gap := choose.Y - (field.Y + field.H); gap != 8 {
		t.Fatalf("the choose button stands %v under the field", gap)
	}
	if gap := cancel.Y - (choose.Y + choose.H); gap != 12 {
		t.Fatalf("the form buttons stand %v under the choose button", gap)
	}
}

func TestEveryProjectHasATabInTheBar(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	f.run("core.library.return", nil)
	f.settle()
	first, second := f.box("core.project-tab", alpha), f.box("core.project-tab", beta)
	if first.Y != second.Y || first.X >= second.X {
		t.Fatalf("the tabs stand at %+v and %+v", first, second)
	}
	f.tester.ClickAt(first.X+first.W/2, first.Y+first.H/2)
	f.settle()
	if got := status[map[string]any](t, f, "core.project"); got["id"] != alpha {
		t.Fatalf("the active project is %v", got)
	}
}

func TestTheProjectTabsStandInAColumnAtTheLeft(t *testing.T) {
	f, alpha, beta := libraryOfTwoProjects(t)
	f.run("core.library.return", nil)
	f.settle()
	before := status[gridRead](t, f, "core.grid")
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}})
	f.settle()
	column := f.box("core.projects.column", "")
	if column.X != 0 || column.W < 64 || column.W > 65 {
		t.Fatalf("the column is %+v", column)
	}
	first, second := f.box("core.project-tab", alpha), f.box("core.project-tab", beta)
	if first.X != second.X || first.Y >= second.Y || first.X < column.X || first.X+first.W > column.X+column.W {
		t.Fatalf("the tabs stand at %+v and %+v in %+v", first, second, column)
	}
	if first.H != 36 {
		t.Fatalf("the tab is %+v", first)
	}
	add := f.box("core.project-tab.add", "")
	if add.H != 24 || add.Y <= second.Y {
		t.Fatalf("the add button is %+v under %+v", add, second)
	}
	after := status[gridRead](t, f, "core.grid")
	if after.Plane.X-before.Plane.X < 64 || after.Width >= before.Width {
		t.Fatalf("the plane was %+v and is %+v", before, after)
	}
	f.run("core.projects.browse", nil)
	f.settle()
	if f.has("core.projects.column", "") {
		t.Fatal("the library shows the column")
	}
}

func TestTheBarIsAnElement(t *testing.T) {
	f := openedShell(t)
	if bar := f.box("core.chrome.bar", ""); bar.X != 0 || bar.Y != 0 || bar.H != 40 {
		t.Fatalf("the bar is %+v", bar)
	}
}

// The sort of the library is a select box of the page: the focus color on its border and no outline.
func TestAFocusedSortHasTheBorderOfThePage(t *testing.T) {
	f, _, _ := libraryOfTwoProjects(t)
	node, ok := exposedNode(f.tester.ElementTree(), "core.library.sort", "")
	if !ok {
		t.Fatal("the library has no sort")
	}
	y := node.Bounds.Y + node.Bounds.H/2
	edge, inside := f.pixelOf(node.Bounds.X+.5, y), f.pixelOf(node.Bounds.X+1.5, y)
	f.tester.Key(0, ui.KeyTab)
	f.settle()
	f.run("core.focus.set", map[string]any{"name": "core.library.sort", "index": 0})
	f.settle()
	if got := f.pixelOf(node.Bounds.X+.5, y); got == edge {
		t.Fatalf("the border of the focused sort stays %v", got)
	}
	if got := f.pixelOf(node.Bounds.X+1.5, y); got != inside {
		t.Fatalf("inside the border of the focused sort lies %v, not %v", got, inside)
	}
}

// A window that shows a project answers the removal that another window asks for through the host, so the removal goes on
// (docs/spec/projects.md#settings).
func TestTheWindowOfAProjectAnswersItsRemoval(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	f.shell.Event("project-remove-request", []any{id})
	f.settle()
	equal(t, f.host.removalAnswers, []string{fmt.Sprintf(`{"allowed":true,"id":%q}`, id)})
}

// A library command that fails shows its failure in the error line of the library and records it at the place library, as
// perform of packages/workbench/library.js does, and the workbench banner stays empty.
func TestAFailedOpenOfTheLibraryShowsInTheLibrary(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	f.run("core.projects.browse", nil)
	missing := "project directory does not exist: /work/alpha"
	f.host.failing = map[string]error{"projectFolder": errors.New(missing)}
	var failure error
	f.shell.Registry().RunLater("core.library.open", json.RawMessage(fmt.Sprintf(`{"id":%q}`, id)), func(_ any, err error) { failure = err })
	records := f.shownRecords()
	if failure != nil {
		t.Fatalf("core.library.open answered %v", failure)
	}
	if !slices.Contains(records, shownRecord{"library", missing}) ||
		slices.ContainsFunc(records, func(record shownRecord) bool { return record.where == "workbench" }) {
		t.Fatalf("the shell recorded %+v", records)
	}
	library := status[struct {
		Error *string `json:"error"`
	}](t, f, "core.library")
	if library.Error == nil || *library.Error != missing {
		t.Fatalf("core.library reports the error %v", library.Error)
	}
	if banner := f.status("core.workbench.error"); banner != "null" {
		t.Fatalf("the workbench banner shows %s", banner)
	}
}

func TestTheProjectListSelectsTheProjectPage(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.plugins.browse", nil)
	f.settle()
	f.run("core.library.return", nil)
	f.settle()
	f.run("core.projects.browse", nil)
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); got.Page != "projects" || len(got.Shown) == 0 {
		t.Fatalf("core.projects.browse after the plugin page shows the page %q with the projects %v", got.Page, got.Shown)
	}
	f.run("core.library.page", map[string]string{"page": "plugins"})
	f.settle()
	f.run("core.projects.browse", nil)
	f.settle()
	if got := status[libraryRead](t, f, "core.library"); got.Page != "projects" {
		t.Fatalf("core.projects.browse in the library keeps the page %q", got.Page)
	}
}
