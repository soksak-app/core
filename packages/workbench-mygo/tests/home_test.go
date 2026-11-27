package workbench_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// homeRead is the part of the status core.home that the home tests read.
type homeRead struct {
	Query         string            `json:"query"`
	Selected      *string           `json:"selected"`
	Rows          []string          `json:"rows"`
	PreviewErrors map[string]string `json:"previewErrors"`
	FolderErrors  map[string]string `json:"folderErrors"`
}

// runHome runs a command of the home and returns the error that it answered.
func runHome(t *testing.T, f *shellFixture, name string, params any) error {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var failure error
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) { failure = err })
	f.settle()
	return failure
}

// The rows list the pinned projects first, then the others, each group by its last-opened time (docs/spec/projects.md#project-home).
func TestTheHomeListsThePinnedProjectsFirst(t *testing.T) {
	f, _, beta := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.settle()
	if got := status[homeRead](t, f, "core.home").Rows; len(got) != 2 {
		t.Fatalf("the rows are %q, want the two projects", got)
	}
	f.run("core.home.pin", map[string]string{"project": beta})
	if rows := status[homeRead](t, f, "core.home").Rows; rows[0] != beta {
		t.Fatalf("the pinned %s is not the first row: %q", beta, rows)
	}
}

// The search matches a project by its name and by its path, and an empty query shows every row again.
func TestTheHomeSearchMatchesTheNameAndThePath(t *testing.T) {
	f, alpha, beta := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.run("core.home.search", map[string]string{"query": "beta"})
	if rows := status[homeRead](t, f, "core.home").Rows; !slices.Equal(rows, []string{beta}) {
		t.Fatalf("the name search shows %q, want %s", rows, beta)
	}
	f.run("core.home.search", map[string]string{"query": "/work/alpha"})
	if rows := status[homeRead](t, f, "core.home").Rows; !slices.Equal(rows, []string{alpha}) {
		t.Fatalf("the path search shows %q, want %s", rows, alpha)
	}
	f.run("core.home.search", map[string]string{"query": ""})
	if rows := status[homeRead](t, f, "core.home").Rows; len(rows) != 2 {
		t.Fatalf("an empty query shows %q", rows)
	}
}

// ↑ and ↓ move the selection by one row and wrap at the ends of the list.
func TestTheHomeSelectionWrapsAtTheEndsOfTheList(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	read := status[homeRead](t, f, "core.home")
	if len(read.Rows) != 2 || read.Selected == nil || *read.Selected != read.Rows[0] {
		t.Fatalf("the first row %q is not selected: %v", read.Rows, read.Selected)
	}
	first, last := read.Rows[0], read.Rows[1]
	f.run("core.home.select", map[string]int{"step": 1})
	if got := *status[homeRead](t, f, "core.home").Selected; got != last {
		t.Fatalf("one step down selects %s, want %s", got, last)
	}
	f.run("core.home.select", map[string]int{"step": 1})
	if got := *status[homeRead](t, f, "core.home").Selected; got != first {
		t.Fatalf("the step past the last row selects %s, want the first %s", got, first)
	}
	f.run("core.home.select", map[string]int{"step": -1})
	if got := *status[homeRead](t, f, "core.home").Selected; got != last {
		t.Fatalf("the step above the first row selects %s, want the last %s", got, last)
	}
}

// Any step other than −1 or 1 is refused at the boundary of the command.
func TestTheHomeSelectRefusesAnotherStep(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	if err := runHome(t, f, "core.home.select", map[string]int{"step": 2}); err == nil {
		t.Fatal("the step 2 was accepted")
	}
	if got := status[homeRead](t, f, "core.home").Selected; got == nil {
		t.Fatal("the refused step cleared the selection")
	}
}

// Enter opens the selected row; with no row shown it answers an error instead of opening another project.
func TestTheHomeOpenWithoutARowAnswersAnError(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.run("core.home.search", map[string]string{"query": "no such project"})
	if err := runHome(t, f, "core.home.open", map[string]string{}); err == nil || err.Error() != "no project row is selected" {
		t.Fatalf("the open without a row answered %v", err)
	}
}

// The × button puts the row into the confirm state, which keeps the project until the removal is answered yes; no leaves the state.
func TestTheHomeRemovalAsksBeforeItRemovesTheRow(t *testing.T) {
	f, alpha, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	selectRow(t, f, alpha)
	if !f.has("core.home.remove-ask", alpha) {
		t.Fatal("the × button of " + alpha + " is not drawn before the removal is asked")
	}
	f.run("core.home.confirm", map[string]string{"project": alpha, "answer": "ask"})
	if !f.has("core.home.confirm", alpha) || f.has("core.home.remove-ask", alpha) {
		t.Fatal("the confirm state does not replace the row of " + alpha)
	}
	if rows := status[homeRead](t, f, "core.home").Rows; !slices.Contains(rows, alpha) {
		t.Fatalf("the confirm state removed %s from the rows %q", alpha, rows)
	}
	f.run("core.home.confirm", map[string]string{"project": alpha, "answer": "no"})
	if f.has("core.home.confirm", alpha) || !f.has("core.home.open", alpha) {
		t.Fatal("the answer no does not restore the row of " + alpha)
	}
}

// The answer yes removes the record of the project and leaves the other projects.
func TestTheHomeYesRemovesTheRecordOfTheProject(t *testing.T) {
	f, alpha, beta := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.run("core.home.confirm", map[string]string{"project": alpha, "answer": "ask"})
	f.run("core.home.confirm", map[string]string{"project": alpha, "answer": "yes"})
	if rows := status[homeRead](t, f, "core.home").Rows; !slices.Equal(rows, []string{beta}) {
		t.Fatalf("after the removal the rows are %q, want %s", rows, beta)
	}
}

// The form buttons open the form in their mode: the new folder field only for create.
func TestTheHomeFormButtonsOpenTheirMode(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.run("core.home.form.open", map[string]string{"mode": "create"})
	if !f.has("core.home.form.name", "") {
		t.Fatal("the create form has no name field")
	}
	f.run("core.home.form.open", map[string]string{"mode": "open"})
	if f.has("core.home.form.name", "") || !f.has("core.home.form.parent", "") {
		t.Fatal("the open form shows the name field or has no folder field")
	}
}

// A query that starts with / and matches no project shows the path row; any other unmatched query shows the no-results line.
func TestTheHomeUnmatchedQueryShowsThePathRowOrTheNoResultsLine(t *testing.T) {
	f, _, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	f.run("core.home.search", map[string]string{"query": "/work/new"})
	if !f.has("core.home.path", "") || f.has("core.home.no-results", "") {
		t.Fatal("the path query does not show the path row")
	}
	f.run("core.home.search", map[string]string{"query": "nothing"})
	if f.has("core.home.path", "") || !f.has("core.home.no-results", "") {
		t.Fatal("the plain unmatched query does not show the no-results line")
	}
}

// The status reports the folder error of a project whose folder cannot be read, under its id.
func TestTheHomeStatusHasTheRowsAndTheirErrors(t *testing.T) {
	f, alpha, beta := twoProjects(t)
	f.run("core.projects.browse", nil)
	read := status[homeRead](t, f, "core.home")
	if !slices.Equal(read.Rows, []string{alpha, beta}) && !slices.Equal(read.Rows, []string{beta, alpha}) {
		t.Fatalf("the rows are %q", read.Rows)
	}
	if read.Selected == nil || *read.Selected != read.Rows[0] {
		t.Fatalf("the selected row is %v, want the first row", read.Selected)
	}
	if read.FolderErrors == nil || read.PreviewErrors == nil {
		t.Fatal("the status has no error maps")
	}
}

// A pin writes its member into the stored record of the project, so core.projects reports the pin once the store holds it
// (docs/spec/projects.md#project-home, F715-2).
func TestAPinIsReportedByCoreProjectsOnceTheStoreHoldsIt(t *testing.T) {
	f, alpha, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	selectRow(t, f, alpha)
	// The pin button of the row names the action that the row takes, which changes with the pin.
	if label := exposedLabel(t, f, "core.home.pin", alpha); label != "위에 고정" {
		t.Fatalf("the pin button of %s is labelled %q before the pin", alpha, label)
	}
	f.run("core.home.pin", map[string]string{"project": alpha})
	f.settle()
	if label := exposedLabel(t, f, "core.home.pin", alpha); label != "고정 풀기" {
		t.Fatalf("the pin button of %s is labelled %q after the pin", alpha, label)
	}
	if pinned, _ := f.host.project(alpha)["pinned"].(bool); !pinned {
		t.Fatal("the store does not hold the pin")
	}
	for _, entry := range status[[]map[string]any](t, f, "core.projects") {
		if entry["id"] == alpha && entry["pinned"] != true {
			t.Fatalf("core.projects reports the project %v without its pin", entry)
		}
	}
}

// A failed open from the home shows its failure as a toast that the person dismisses through the error display path
// (docs/spec/projects.md#project-home, F1033-2).
func TestAFailedOpenFromTheHomeShowsADismissibleToast(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	project["settingsError"] = "the settings file is refused"
	f := newShell(t, &storedHost{projects: []map[string]any{project}})
	f.run("core.projects.browse", nil)
	const failure = "the settings file is refused"
	// The failure is recorded in the application log by design, so the steps run without settle, which refuses any record.
	f.shell.Registry().RunLater("core.home.open", []byte(`{"project":"`+project["id"].(string)+`"}`), func(_ any, err error) {
		if err != nil {
			t.Errorf("the open answered %v, want the failure shown as a toast", err)
		}
	})
	f.pending.drain(t)
	f.tester.Frame()
	if !f.tester.HasText(failure) {
		t.Fatalf("the home shows %q, not the failure", f.tester.Texts())
	}
	if errors := f.host.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), failure) {
		t.Fatalf("the shell recorded %v, want the failure once", errors)
	}
	press(t, f.tester, "core.notices.close", f.noticeFor(failure))
	f.pending.drain(t)
	f.tester.Frame()
	if f.tester.HasText(failure) {
		t.Fatal("the dismissed toast is still shown")
	}
}

// The removal of a home row answers through core.home.remove only after the host has removed the project
// (docs/spec/projects.md#project-home, F737).
func TestTheHomeRemovalAnswersAfterTheHostRemovesTheProject(t *testing.T) {
	f, alpha, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	answered := false
	var answer error
	f.shell.Registry().RunLater("core.home.remove", []byte(`{"project":"`+alpha+`"}`), func(_ any, err error) {
		answered, answer = true, err
	})
	if answered {
		t.Fatal("the removal answered before the host answered the removal request")
	}
	f.settle()
	if !answered || answer != nil {
		t.Fatalf("the removal answered %v (%v), want nil after the host", answered, answer)
	}
	if rows := status[homeRead](t, f, "core.home").Rows; slices.Contains(rows, alpha) {
		t.Fatalf("the rows %q still hold the removed project", rows)
	}
}

// A project that another window owns is open here too, as the home shows its badge 열림 (docs/spec/projects.md#project-home).
func TestAProjectOfAnotherWindowIsOpen(t *testing.T) {
	host := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"))}}
	host.open = []string{host.projects[0]["id"].(string)}
	f := newShell(t, host)
	f.settle()
	if !f.tester.HasText("열림") {
		t.Fatalf("the home shows %q, without the badge of the open project", f.tester.Texts())
	}
}

// A change of the store tells that another window has released its project, so the home drops its badge 열림.
func TestTheOpenProjectsFollowTheStore(t *testing.T) {
	host := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"))}}
	host.open = []string{host.projects[0]["id"].(string)}
	f := newShell(t, host)
	f.settle()
	host.open = nil
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if f.tester.HasText("열림") {
		t.Fatalf("the home still shows %q after the release", f.tester.Texts())
	}
}

// homeOfTwoProjects returns a shell on the project home with the projects alpha and beta, of which beta is open.
func homeOfTwoProjects(t *testing.T) (f *shellFixture, alpha, beta string) {
	t.Helper()
	f, alpha, beta = twoProjects(t)
	f.run("core.projects.browse", nil)
	f.settle()
	return f, alpha, beta
}

func TestTheFormButtonsTakeTheWidthOfTheirLabel(t *testing.T) {
	f, _, _ := homeOfTwoProjects(t)
	f.run("core.home.form.open", map[string]string{"mode": "open"})
	f.tester.Frame()
	choose, field := f.box("core.home.form.choose", ""), f.box("core.home.form.parent", "")
	if choose.W >= field.W/2 {
		t.Fatalf("the choose button is %+v under the field %+v", choose, field)
	}
}

func TestTheHomeKeepsItsSizeWhenTheFrameTextGrows(t *testing.T) {
	f, _, _ := homeOfTwoProjects(t)
	before, _ := f.tester.Find("새 프로젝트")
	f.run("core.text.larger", nil)
	f.tester.Frame()
	after, ok := f.tester.Find("새 프로젝트")
	if !ok || after.H != before.H {
		t.Fatalf("the text was %+v and is %+v", before, after)
	}
}

func TestACardShowsTheDayItsProjectOpened(t *testing.T) {
	f := openedShell(t)
	f.run("core.projects.browse", nil)
	f.tester.Frame()
	if !f.tester.HasText("오늘") {
		t.Fatalf("the home shows %q, without the day of a project opened now", f.tester.Texts())
	}
}

func TestTheLinesOfTheHomeHaveTheHeightOfThePage(t *testing.T) {
	f, _, _ := homeOfTwoProjects(t)
	// .text-field: a line of text-control at the line height of the page, two paddings of 5 and two borders.
	if field := f.box("core.home.search", ""); field.H < 28 || field.H > 29.5 {
		t.Fatalf("the search is %+v", field)
	}
}

// A project that another window removed leaves the registry of this window when the store changes, and the window that showed it ends
// it and shows the project home (docs/spec/projects.md#settings).
func TestAProjectThatAnotherWindowRemovedLeavesTheWindow(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}}
	f := newTabShell(t, stored)
	f.open(t)
	stored.mu.Lock()
	stored.projects = nil
	stored.mu.Unlock()
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if projects := status[[]map[string]any](t, f.shellFixture, "core.projects"); len(projects) != 0 {
		t.Fatalf("the window still lists %v", projects)
	}
	if screen := status[map[string]any](t, f.shellFixture, "core.screen")["screen"]; screen != "home" {
		t.Fatalf("the window shows %v", screen)
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

func TestTheFolderCommandAnswersWithTheFolderOfTheHost(t *testing.T) {
	f := newShell(t, &storedHost{})
	answer, err := f.answerLater("core.folder.create", map[string]string{"parent": "/work", "name": "gamma"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"root":"/work/gamma","identity":"identity of /work/gamma"}`; string(encoded) != want {
		t.Fatalf("the answer is %s, want %s", encoded, want)
	}
	if len(f.host.projects) != 0 {
		t.Fatalf("the command made a project: %v", f.host.projects)
	}
}

func TestTheFolderCommandPassesOnTheRefusalOfTheHost(t *testing.T) {
	refused := errors.New("the folder exists")
	f := newShell(t, &storedHost{createRefused: refused})
	if _, err := f.answerLater("core.folder.create", map[string]string{"parent": "/work", "name": "gamma"}); err == nil || !strings.Contains(err.Error(), refused.Error()) {
		t.Fatalf("the command answered %v", err)
	}
}

func TestTheSearchFocusRefusesOutsideTheHome(t *testing.T) {
	f := openedShell(t)
	if _, err := f.answerLater("core.home.search.focus", nil); err == nil || err.Error() != "the project home is not shown" {
		t.Fatalf("the command answered %v", err)
	}
}

func TestTheShortcutFocusesTheSearch(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.tester.Key(ui.Cmd, ui.KeyO)
	f.settle()
	if !f.tester.Focused("프로젝트 찾기") {
		t.Fatal("the project search has no focus")
	}
}

func TestTheSearchFieldFiltersTheHome(t *testing.T) {
	f := openedShell(t)
	f.run("core.projects.browse", nil)
	f.click("core.home.search", "")
	f.tester.Type("없는 이름")
	f.settle()
	if !f.has("core.home.no-results", "") || !slices.Contains(f.tester.Texts(), "“없는 이름”와 맞는 프로젝트가 없다.") {
		t.Fatalf("no note of no results; the texts are %q", f.tester.Texts())
	}
	f.run("core.home.search", map[string]string{"query": "alpha"})
	if f.has("core.home.no-results", "") {
		t.Fatal("the note stays with a match")
	}
}

// A press on a row of the project home opens that row's project in place, not the selected row (docs/spec/projects.md#project-home).
func TestAPressOnAHomeRowOpensItsProject(t *testing.T) {
	f, alpha, beta := homeOfTwoProjects(t)
	home := status[homeRead](t, f, "core.home")
	target := beta
	if home.Selected != nil && *home.Selected == beta {
		target = alpha
	}
	press(t, f.tester, "core.home.open", target)
	f.settle()
	if got := status[map[string]any](t, f, "core.project")["id"]; got != target {
		t.Fatalf("the press on the row of %s opened %v", target, got)
	}
}

// The list of the project home scrolls when its rows do not fit, and the key hint line below it stays where it is
// (docs/spec/projects.md#project-home).
func TestTheHomeListScrollsAndItsKeyHintStays(t *testing.T) {
	var projects []map[string]any
	for i := 0; i < 40; i++ {
		project := storedProject(tab("tab-aaaaaa", "notes"))
		project["id"] = fmt.Sprintf("prj-%02d", i)
		project["title"] = fmt.Sprintf("project %02d", i)
		project["root"] = fmt.Sprintf("/work/project-%02d", i)
		project["identity"] = "identity of " + project["root"].(string)
		projects = append(projects, project)
	}
	f := newShell(t, &storedHost{projects: projects})
	f.run("core.projects.browse", nil)
	f.settle()
	last := "prj-39"
	before := f.box("core.home.open", last).Y
	hintNode, ok := f.tester.Find("↑↓ 이동, Enter 열기, ⌘, 설정")
	if !ok {
		t.Fatal("the key hint line is not drawn")
	}
	hint := hintNode.Y
	first := f.box("core.home.open", "prj-00")
	f.tester.Scroll(first.X+first.W/2, first.Y+first.H/2, 0, 400)
	f.settle()
	if after := f.box("core.home.open", last).Y; after >= before {
		t.Fatalf("the last row stayed at %v after the scroll, want it above %v", after, before)
	}
	hintNode, ok = f.tester.Find("↑↓ 이동, Enter 열기, ⌘, 설정")
	if !ok || hintNode.Y != hint {
		t.Fatalf("the key hint line moved from %v with the list", hint)
	}
}

// The selected row draws its background on the line that holds the open button and both action buttons: the line spans the
// action buttons, and the open button ends before them (docs/spec/projects.md#project-home).
func TestTheSelectedRowBackgroundCoversItsActionButtons(t *testing.T) {
	f, alpha, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	selectRow(t, f, alpha)
	tree := f.tester.ElementTree()
	open, ok := exposedNode(tree, "core.home.open", alpha)
	if !ok {
		t.Fatalf("no element core.home.open %q", alpha)
	}
	pin, ok := exposedNode(tree, "core.home.pin", alpha)
	if !ok {
		t.Fatalf("no element core.home.pin %q", alpha)
	}
	remove, ok := exposedNode(tree, "core.home.remove-ask", alpha)
	if !ok {
		t.Fatalf("no element core.home.remove-ask %q", alpha)
	}
	line, ok := parentOf(tree, pin.ID)
	if !ok {
		t.Fatalf("the pin button of %s has no parent", alpha)
	}
	if parent, _ := parentOf(tree, remove.ID); parent.ID != line.ID {
		t.Fatalf("the pin and remove buttons of %s are in different lines", alpha)
	}
	if !contains(line.Bounds, pin.Bounds) || !contains(line.Bounds, remove.Bounds) {
		t.Fatalf("the line %v of %s does not cover its action buttons %v and %v", line.Bounds, alpha, pin.Bounds, remove.Bounds)
	}
	if contains(open.Bounds, remove.Bounds) || open.Bounds.X+open.Bounds.W > pin.Bounds.X {
		t.Fatalf("the open button %v of %s overlaps its action buttons", open.Bounds, alpha)
	}
}

// parentOf returns the element whose children include the element with the ID.
func parentOf(nodes []ui.ElementNode, id uint64) (ui.ElementNode, bool) {
	for _, n := range nodes {
		for _, child := range n.Children {
			if child.ID == id {
				return n, true
			}
		}
		if p, ok := parentOf(n.Children, id); ok {
			return p, true
		}
	}
	return ui.ElementNode{}, false
}

// contains reports whether the rectangle outer holds the rectangle inner.
func contains(outer, inner ui.Rect) bool {
	return inner.X >= outer.X && inner.Y >= outer.Y && inner.X+inner.W <= outer.X+outer.W && inner.Y+inner.H <= outer.Y+outer.H
}

// exposedLabel returns the label of the element with the element name and item, as the element tree draws it.
func exposedLabel(t *testing.T, f *shellFixture, name, item string) string {
	t.Helper()
	node, ok := exposedNode(f.tester.ElementTree(), name, item)
	if !ok {
		t.Fatalf("no element %s %q", name, item)
	}
	return node.Label
}

// selectRow selects the row of the project with the selection step of core.home.select, since a row shows its pin and × buttons on
// hover or selection (docs/spec/projects.md#project-home). The first row is selected at first.
func selectRow(t *testing.T, f *shellFixture, id string) {
	t.Helper()
	rows := status[homeRead](t, f, "core.home").Rows
	if len(rows) == 2 && rows[0] != id {
		if err := runHome(t, f, "core.home.select", map[string]any{"step": 1}); err != nil {
			t.Fatal(err)
		}
	}
}

// Cmd+Backspace puts the selected row into the removal confirm state, as its × button does, and does nothing while the search field
// has focus (docs/spec/projects.md#project-home).
func TestTheShortcutAsksTheRemovalOfTheSelectedRow(t *testing.T) {
	f, alpha, _ := twoProjects(t)
	f.run("core.projects.browse", nil)
	selectRow(t, f, alpha)
	f.tester.Key(ui.Cmd, ui.KeyBackspace)
	f.settle()
	if !f.has("core.home.confirm", alpha) || f.has("core.home.remove-ask", alpha) {
		t.Fatalf("cmd+Backspace does not put the selected row %s into the confirm state", alpha)
	}
	f.run("core.home.confirm", map[string]string{"project": alpha, "answer": "no"})
	f.run("core.home.search.focus", nil)
	f.tester.Key(ui.Cmd, ui.KeyBackspace)
	f.settle()
	if f.has("core.home.confirm", alpha) {
		t.Fatal("cmd+Backspace in the search field asks the removal of a row")
	}
}
