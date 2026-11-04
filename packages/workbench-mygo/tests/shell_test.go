package workbench_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// storedHost answers the host calls of the shell from memory, as the workspace store of the language host library does.
type storedHost struct {
	projects []map[string]any
	calls    []string
	shown    []any
	failing  map[string]error
}

func (h *storedHost) table() map[string]workbench.HostCall {
	answer := func(name string, read func(argument json.RawMessage) (any, error)) workbench.HostCall {
		return func(_ context.Context, argument json.RawMessage) (any, error) {
			h.calls = append(h.calls, name)
			if err := h.failing[name]; err != nil {
				return nil, err
			}
			return read(argument)
		}
	}
	none := func(json.RawMessage) (any, error) { return nil, nil }
	return map[string]workbench.HostCall{
		"workspace": answer("workspace", h.workspace),
		"projectFolder": answer("projectFolder", func(argument json.RawMessage) (any, error) {
			var root string
			if err := json.Unmarshal(argument, &root); err != nil {
				return nil, err
			}
			return map[string]string{"root": root, "identity": "identity of " + root}, nil
		}),
		"projectCreate": answer("projectCreate", func(argument json.RawMessage) (any, error) {
			var request struct{ Parent, Name string }
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			root := request.Parent + "/" + request.Name
			return map[string]string{"root": root, "identity": "identity of " + root}, nil
		}),
		"projectOpen": answer("projectOpen", func(json.RawMessage) (any, error) {
			return map[string]bool{"local": true, "staged": true}, nil
		}),
		"projectShown": answer("projectShown", func(argument json.RawMessage) (any, error) {
			var shown any
			if err := json.Unmarshal(argument, &shown); err != nil {
				return nil, err
			}
			h.shown = append(h.shown, shown)
			return nil, nil
		}),
		"projectRelease":   answer("projectRelease", none),
		"projectRemoveAsk": answer("projectRemoveAsk", func(json.RawMessage) (any, error) { return true, nil }),
		"folderChoose":     answer("folderChoose", func(json.RawMessage) (any, error) { return "/chosen", nil }),
		"windowReady":      answer("windowReady", none),
		"windowNew":        answer("windowNew", none),
	}
}

func (h *storedHost) project(id string) map[string]any {
	for _, project := range h.projects {
		if project["id"] == id {
			return project
		}
	}
	return nil
}

func (h *storedHost) workspace(argument json.RawMessage) (any, error) {
	var request struct {
		Kind    string
		ID      string
		Project map[string]any
		Patch   map[string]any
	}
	if err := json.Unmarshal(argument, &request); err != nil {
		return nil, err
	}
	switch request.Kind {
	case "snapshot":
		return map[string]any{"projects": h.projects, "open": []string{}}, nil
	case "add":
		h.projects = append(h.projects, request.Project)
		return request.Project, nil
	case "patch":
		project := h.project(request.ID)
		if project == nil {
			return nil, fmt.Errorf("unknown project %s", request.ID)
		}
		for key, value := range request.Patch {
			project[key] = value
		}
		return project, nil
	case "remove":
		for i, project := range h.projects {
			if project["id"] == request.ID {
				h.projects = append(h.projects[:i], h.projects[i+1:]...)
				break
			}
		}
		return nil, nil
	}
	return nil, fmt.Errorf("unknown workspace call %s", request.Kind)
}

// shellFixture is a shell over storedHost, whose later steps run when the test asks.
type shellFixture struct {
	t       *testing.T
	host    *storedHost
	shell   *workbench.Shell
	tester  *ui.Tester
	pending steps
	lines   []string
}

// environment reads the environment declaration of the application, which the shell receives from the assets of the application.
func environment(t *testing.T) []byte {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "mygo", "environment.json"))
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func newShell(t *testing.T, stored *storedHost) *shellFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &shellFixture{t: t, host: stored, pending: make(steps, 256)}
	shell, err := workbench.NewShell(workbench.ShellOptions{
		Declared:    declared,
		Calls:       workbench.NewCalls(stored.table(), f.pending.post),
		Environment: environment(t),
		Invalidate:  func() {},
		Post:        f.pending.post,
		Report:      func(line string) { f.lines = append(f.lines, line) },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.shell = shell
	f.tester = ui.NewTester(shell.View, 1200, 800)
	shell.Start()
	f.settle()
	return f
}

// settle runs every later step and draws the frame that shows their result.
func (f *shellFixture) settle() {
	f.t.Helper()
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
	if len(f.lines) > 0 {
		f.t.Fatalf("the shell reported %q", f.lines)
	}
}

// exposedNode returns the element with the element name, and with the item when item is not "".
func exposedNode(nodes []ui.ElementNode, name, item string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == name && (item == "" || exposed.Item == item) {
			return node, true
		}
		if found, ok := exposedNode(node.Children, name, item); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

func (f *shellFixture) has(name, item string) bool {
	_, ok := exposedNode(f.tester.ElementTree(), name, item)
	return ok
}

// click presses the element with the element name and shows the result.
func (f *shellFixture) click(name, item string) {
	f.t.Helper()
	node, ok := exposedNode(f.tester.ElementTree(), name, item)
	if !ok {
		f.t.Fatalf("no element %s %q; the texts are %q", name, item, f.tester.Texts())
	}
	f.tester.ClickAt(node.Bounds.X+node.Bounds.W/2, node.Bounds.Y+node.Bounds.H/2)
	f.settle()
}

// run runs a command as the endpoint runs it and shows the result.
func (f *shellFixture) run(name string, params any) {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.shell.Registry().Run(name, raw); err != nil {
		f.t.Fatal(err)
	}
	f.settle()
}

// audit fails the test when the frame has an interactive element without a command or an element name.
func (f *shellFixture) audit() {
	f.t.Helper()
	if unbound := workbench.Audit(f.tester.ElementTree()); len(unbound) > 0 {
		f.t.Fatalf("elements without a command or an element name: %+v", unbound)
	}
}

// openedShell opens a project through the form of the library.
func openedShell(t *testing.T) *shellFixture {
	t.Helper()
	f := newShell(t, &storedHost{})
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	return f
}

// cardsOf returns the stored cards of the active space of the only project.
func (f *shellFixture) cardsOf() []map[string]any {
	f.t.Helper()
	project := f.host.projects[0]
	encoded, err := json.Marshal(project)
	if err != nil {
		f.t.Fatal(err)
	}
	var record struct {
		ActiveSpaceID string `json:"activeSpaceId"`
		Spaces        []struct {
			ID     string
			Layout struct {
				State struct{ Cards []map[string]any }
			}
		}
	}
	if err := json.Unmarshal(encoded, &record); err != nil {
		f.t.Fatal(err)
	}
	for _, space := range record.Spaces {
		if space.ID == record.ActiveSpaceID {
			return space.Layout.State.Cards
		}
	}
	f.t.Fatalf("no active space in %s", encoded)
	return nil
}

// tabbedCards returns the ids of the stored cards that hold tabs.
func (f *shellFixture) tabbedCards() []string {
	var ids []string
	for _, card := range f.cardsOf() {
		data, _ := card["data"].(map[string]any) // silent: a window sidebar has no data.
		if data != nil && data["tabs"] != nil {
			ids = append(ids, card["id"].(string))
		}
	}
	return ids
}

func TestLibraryShowsTheStartOfAnEmptyWorkspace(t *testing.T) {
	f := newShell(t, &storedHost{})
	if !f.tester.HasText("프로젝트를 시작하세요") || !f.tester.HasText("새 프로젝트를 만들거나 기존 폴더를 여세요.") {
		t.Fatalf("the library shows %q", f.tester.Texts())
	}
	if !f.has("core.chrome.settings", "") || f.has("core.chrome.projects", "") {
		t.Fatal("the chrome of the library has the settings button and not the project buttons")
	}
	f.audit()
}

func TestWindowIsReadyAfterTheSnapshot(t *testing.T) {
	f := newShell(t, &storedHost{})
	if strings.Join(f.host.calls, " ") != "workspace windowReady" {
		t.Fatalf("the start called %v", f.host.calls)
	}
}

func TestLibraryFormOpensAProject(t *testing.T) {
	f := openedShell(t)
	if len(f.host.projects) != 1 || f.host.projects[0]["root"] != "/work/alpha" || f.host.projects[0]["title"] != "alpha" {
		t.Fatalf("the store holds %v", f.host.projects)
	}
	if !f.has("core.project-tab", "") || !f.has("core.space-tab", "") || !f.has("core.card", "") {
		t.Fatalf("the project screen shows %q", f.tester.Texts())
	}
	if len(f.host.shown) != 1 {
		t.Fatalf("the shown projects are %v", f.host.shown)
	}
	f.audit()
}

func TestLibraryFormCreatesAFolder(t *testing.T) {
	f := newShell(t, &storedHost{})
	f.run("core.library.form.open", map[string]string{"mode": "create"})
	f.run("core.library.form.set", map[string]string{"field": "name", "value": "beta"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work"})
	f.audit()
	f.run("core.library.form.submit", nil)
	if len(f.host.projects) != 1 || f.host.projects[0]["root"] != "/work/beta" {
		t.Fatalf("the store holds %v", f.host.projects)
	}
}

func TestLibraryListsAndRemovesProjects(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	f.run("core.projects.browse", nil)
	if !f.has("core.library.return", "") || !f.tester.HasText("alpha") {
		t.Fatalf("the library shows %q", f.tester.Texts())
	}
	f.audit()
	f.click("core.library.open", id)
	if !f.has("core.card", "") {
		t.Fatal("the opened project shows no card")
	}
	f.run("core.library.remove", map[string]string{"id": id})
	if len(f.host.projects) != 0 || !f.tester.HasText("프로젝트를 시작하세요") {
		t.Fatalf("the store holds %v and the screen shows %q", f.host.projects, f.tester.Texts())
	}
}

func TestSplitMakesACardAndStoresIt(t *testing.T) {
	f := openedShell(t)
	before := f.tabbedCards()
	f.click("core.card.split-x", before[0])
	after := f.tabbedCards()
	if len(after) != len(before)+1 {
		t.Fatalf("the split stored %v after %v", after, before)
	}
	for _, id := range after {
		if !f.has("core.card", id) {
			t.Fatalf("card %s is not drawn", id)
		}
	}
	f.audit()
	f.click("core.card.close", after[len(after)-1])
	if len(f.tabbedCards()) != len(before) {
		t.Fatalf("the close stored %v", f.tabbedCards())
	}
}

func TestTabsOfACard(t *testing.T) {
	f := openedShell(t)
	card := f.tabbedCards()[0]
	f.click("core.card.add", card)
	cards := f.cardsOf()
	var tabs []any
	for _, stored := range cards {
		if stored["id"] == card {
			tabs = stored["data"].(map[string]any)["tabs"].([]any)
		}
	}
	if len(tabs) != 2 {
		t.Fatalf("the card holds %v", tabs)
	}
	first := tabs[0].(map[string]any)["id"].(string)
	f.click("core.card.tab", first)
	f.click("core.card.tab-close", first)
	for _, stored := range f.cardsOf() {
		if stored["id"] == card && len(stored["data"].(map[string]any)["tabs"].([]any)) != 1 {
			t.Fatalf("the card holds %v", stored["data"])
		}
	}
	f.audit()
}

func TestSpacesOfAProject(t *testing.T) {
	f := openedShell(t)
	f.click("core.space-tab.add", "")
	project := f.host.projects[0]
	if len(project["spaces"].([]any)) != 2 {
		t.Fatalf("the project holds %v", project["spaces"])
	}
	first := project["spaces"].([]any)[0].(map[string]any)["id"].(string)
	f.click("core.space-tab", first)
	if f.host.projects[0]["activeSpaceId"] != first {
		t.Fatalf("the active space is %v", f.host.projects[0]["activeSpaceId"])
	}
	f.click("core.space-tab.close", first)
	if len(f.host.projects[0]["spaces"].([]any)) != 1 {
		t.Fatalf("the project holds %v", f.host.projects[0]["spaces"])
	}
	f.audit()
}

func TestStoredProjectOpensItsLayout(t *testing.T) {
	first := openedShell(t)
	card := first.tabbedCards()[0]
	first.click("core.card.split-x", card)
	cards := first.tabbedCards()
	second := newShell(t, first.host)
	second.click("core.library.open", first.host.projects[0]["id"].(string))
	for _, id := range cards {
		if !second.has("core.card", id) {
			t.Fatalf("card %s is not drawn; the texts are %q", id, second.tester.Texts())
		}
	}
}

func TestHostFailureShowsInTheLibrary(t *testing.T) {
	f := newShell(t, &storedHost{failing: map[string]error{"projectFolder": fmt.Errorf("project directory is gone")}})
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	if _, err := f.shell.Registry().Run("core.library.form.submit", nil); err != nil {
		t.Fatal(err)
	}
	f.pending.drain(t)
	f.tester.Frame()
	if !f.tester.HasText("project directory is gone") {
		t.Fatalf("the library shows %q", f.tester.Texts())
	}
}

// drain runs the later steps until no call of the host is answering. The handlers of storedHost answer at once.
func (s steps) drain(t *testing.T) {
	t.Helper()
	for {
		select {
		case task := <-s:
			task()
		case <-time.After(10 * time.Millisecond):
			return
		}
	}
}
