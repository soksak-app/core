// The tab parts of the application over the surfaces of a window: what the memory saver unloads leaves the placement, and a tab that is
// shown again returns through it.
package workbench_test

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// unloadDocument is the document of the installed plugins with a view that the memory saver can unload.
const unloadDocument = `{"plugins": [{"id": "notes", "package": "@scope/plugin-notes", "version": "1.0.0", "manifest": {"id": "notes", "name": "노트", "description": "notes",
	"mark": "n", "icon": "<path d=\"M1 1h14\"/>", "surface": {"unload": {"format": 1, "maxBytes": 1024}, "composition": {"kind": "view", "page": "ui/index.html"}}}}]}`

// tabApp is an application workbench whose window draws in a tester.
type tabApp struct {
	t       *testing.T
	app     *workbench.App
	window  *appWindow
	queue   steps
	tester  *ui.Tester
	stored  *surfaceHost
	replies chan map[string]any
	lines   []string
	id      atomic.Int64
}

// tabClock is the time of an application that a test moves.
type tabClock struct{ *clock }

func (c tabClock) Now() int64 { return c.now }

func (c tabClock) After(milliseconds int64, run func()) func() { return c.after(milliseconds, run) }

func newTabApp(t *testing.T, stored *surfaceHost, document string) *tabApp {
	t.Helper()
	return newTabAppAt(t, stored, document, nil)
}

// newTabAppAt is newTabApp with the time of the application.
func newTabAppAt(t *testing.T, stored *surfaceHost, document string, time workbench.TabClock) *tabApp {
	t.Helper()
	f := &tabApp{t: t, window: &appWindow{}, queue: make(steps, 1024), stored: stored, replies: make(chan map[string]any, 64)}
	table := func(host.Frontend) map[string]workbench.HostCall {
		calls := stored.surfaceTable()
		calls["exposureReply"] = func(_ context.Context, argument json.RawMessage) (any, error) {
			var reply map[string]any
			if err := json.Unmarshal(argument, &reply); err != nil {
				return nil, err
			}
			f.replies <- reply
			return nil, nil
		}
		return calls
	}
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: f.queue.post, Table: table, Clock: time,
		Detaching: func(host.Frontend) []string { return nil },
		Installed: func() []byte { return []byte(document) },
		Element:   func(host.Frontend, string) (uintptr, uintptr, bool) { return 0, 0, false },
		Report:    func(line string) { f.lines = append(f.lines, line) }})
	if err != nil {
		t.Fatal(err)
	}
	f.app = app
	f.tester = ui.NewTester(app.Build(f.window), 1200, 800)
	app.Shown(f.window)
	f.settle()
	return f
}

func (f *tabApp) settle() {
	f.t.Helper()
	for range 4 {
		f.queue.drain(f.t)
		f.tester.Frame()
	}
	f.queue.drain(f.t)
	if len(f.lines) > 0 {
		f.t.Fatalf("the workbench reported %q", f.lines)
	}
}

// ask sends an exposure request and returns its reply after the frames that it needs.
func (f *tabApp) ask(method string, params any) map[string]any {
	f.t.Helper()
	id := f.id.Add(1)
	f.app.Emit(f.window, "exposure-request", map[string]any{"id": id, "method": method, "params": params})
	f.settle()
	select {
	case reply := <-f.replies:
		if reply["error"] != nil {
			f.t.Fatalf("%s %v: %v", method, params, reply["error"])
		}
		return reply
	default:
		f.t.Fatalf("%s %v has no reply", method, params)
		return nil
	}
}

func (f *tabApp) command(name string, params any) {
	f.t.Helper()
	f.ask("command.run", map[string]any{"name": name, "params": params})
}

// stateOf reads the memory state of tab from core.tab.memory.
func (f *tabApp) stateOf(tab string) string {
	f.t.Helper()
	reply := f.ask("status.get", map[string]any{"name": "core.tab.memory"})
	for _, item := range reply["result"].(map[string]any)["tabs"].([]any) {
		entry := item.(map[string]any)
		if entry["tab"] == tab {
			return entry["state"].(string)
		}
	}
	f.t.Fatalf("core.tab.memory has no tab %s: %v", tab, reply)
	return ""
}

// An unloaded tab keeps the title that its view reported, as the label that the tab store caches.
func TestAnUnloadedTabKeepsItsLabel(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	f := newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": 5, "command": "tab.title", "params": "notes.md"})
	f.settle()
	f.command("core.tab.select", map[string]string{"tab": "tab-bbbbbb"})
	if !f.tester.HasText("notes.md") {
		t.Fatalf("the tabs show %q before the unload", f.tester.Texts())
	}
	f.command("core.tab.unload", map[string]string{"tab": "tab-aaaaaa"})
	if !f.tester.HasText("notes.md") {
		t.Fatalf("the unloaded tab lost its label: %q", f.tester.Texts())
	}
}

func TestAnUnloadedTabLeavesThePlacementAndReturnsWhenItIsShown(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	f := newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	if stored.lastSurfaces(t)["tab-aaaaaa"] == nil {
		t.Fatalf("the shown tab is not placed: %v", stored.lastSurfaces(t))
	}
	f.command("core.tab.select", map[string]string{"tab": "tab-bbbbbb"})
	if surface := stored.lastSurfaces(t)["tab-aaaaaa"]; surface == nil || surface["visible"] != false {
		t.Fatalf("the hidden tab is %v", surface)
	}
	f.command("core.tab.unload", map[string]string{"tab": "tab-aaaaaa"})
	if surfaces := stored.lastSurfaces(t); surfaces["tab-aaaaaa"] != nil || surfaces["tab-bbbbbb"] == nil {
		t.Fatalf("the placement after the unload is %v", surfaces)
	}
	if state := f.stateOf("tab-aaaaaa"); state != "unloaded" {
		t.Fatalf("the unloaded tab is %s", state)
	}
	f.command("core.tab.select", map[string]string{"tab": "tab-aaaaaa"})
	if surface := stored.lastSurfaces(t)["tab-aaaaaa"]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown tab is %v", surface)
	}
	if state := f.stateOf("tab-aaaaaa"); state != "loaded" {
		t.Fatalf("the shown tab is %s", state)
	}
}

// A tab that unloads stores the history of its region, and the view of the tab that comes back attaches the region with that history.
func TestAnUnloadedTabGetsTheHistoryOfItsRegionBack(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	base := stored.table()["workspace"]
	var session json.RawMessage
	var attaches []map[string]any
	stored.calls = map[string]workbench.HostCall{
		"workspace": func(ctx context.Context, argument json.RawMessage) (any, error) {
			var request struct {
				Kind    string
				Tab     string
				Regions json.RawMessage
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			switch {
			case request.Kind == "tabSession" && request.Tab == "tab-aaaaaa" && session != nil:
				return session, nil
			case request.Kind == "tabSessionPut" && request.Tab == "tab-aaaaaa":
				session = json.RawMessage(`{"regions":` + string(request.Regions) + `}`)
				return 1, nil
			}
			return base(ctx, argument)
		},
		"documentAttach": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request map[string]any
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			attaches = append(attaches, request)
			return nil, nil
		},
		"documentInteractionState": func(context.Context, json.RawMessage) (any, error) { return "c3RhdGU=", nil },
		"documentQuery":            func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil },
	}
	f := newTabApp(t, stored, unloadDocument)
	attach := func(id int) any {
		t.Helper()
		f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": id, "command": "document.attach",
			"params": map[string]any{"name": "page"}})
		f.settle()
		reply := stored.replies[len(stored.replies)-1]
		if reply["error"] != nil {
			t.Fatalf("the reply is %v", reply)
		}
		return reply["result"].(map[string]any)["history"]
	}
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	if history := attach(1); history != false {
		t.Fatalf("the first attach restored the history %v", history)
	}
	f.command("core.tab.select", map[string]string{"tab": "tab-bbbbbb"})
	f.command("core.tab.unload", map[string]string{"tab": "tab-aaaaaa"})
	if state := f.stateOf("tab-aaaaaa"); state != "unloaded" {
		t.Fatalf("the unloaded tab is %s", state)
	}
	f.command("core.tab.select", map[string]string{"tab": "tab-aaaaaa"})
	if history := attach(2); history != true {
		t.Fatalf("the attach after the unload restored the history %v", history)
	}
	if last := attaches[len(attaches)-1]; last["interactionState"] != "c3RhdGU=" {
		t.Fatalf("the last attach is %v", last)
	}
	if history := attach(3); history != false {
		t.Fatalf("a history restored twice: %v", history)
	}
}

// A document region attach that waits for the stored session of its tab belongs to the view that called it: when the tab closes before
// the read answers, the attach makes no host call and gets no reply, because a call of an ended view gets no answer.
func TestAnAttachThatWaitsForTheSessionOfAClosedTabEndsWithItsView(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	base := stored.table()["workspace"]
	read := newGate()
	var attaches atomic.Int32
	stored.calls = map[string]workbench.HostCall{
		"workspace": func(ctx context.Context, argument json.RawMessage) (any, error) {
			var request struct{ Kind, Tab string }
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			if request.Kind == "tabSession" && request.Tab == "tab-aaaaaa" {
				read.wait()
				return nil, nil
			}
			return base(ctx, argument)
		},
		"documentAttach": func(context.Context, json.RawMessage) (any, error) {
			attaches.Add(1)
			return nil, nil
		},
	}
	f := newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": 1, "command": "document.attach",
		"params": map[string]any{"name": "page"}})
	f.settle()
	replies := len(stored.replies)
	f.command("core.tab.close", map[string]string{"tab": "tab-aaaaaa"})
	read.open()
	f.settle()
	if n := attaches.Load(); n != 0 {
		t.Fatalf("the attach of the closed tab made %d host calls", n)
	}
	for _, reply := range stored.replies[replies:] {
		if reply["surface"] == "tab-aaaaaa" {
			t.Fatalf("the attach of the closed tab has the reply %v", reply)
		}
	}
}

// A document region attach that the host answers after the project of its tab closed belongs to the view that ended: the window keeps
// no region of that tab, so a later save asks no closed surface for its state, which the host would refuse.
func TestAnAttachThatTheHostAnswersAfterItsProjectClosedKeepsNoRegion(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	attaching, attached := make(chan struct{}), newGate()
	var states []string
	var mu sync.Mutex
	stored.calls = map[string]workbench.HostCall{
		"documentAttach": func(context.Context, json.RawMessage) (any, error) {
			close(attaching)
			attached.wait()
			return nil, nil
		},
		"documentInteractionState": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request struct{ Surface string }
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			mu.Lock()
			states = append(states, request.Surface)
			mu.Unlock()
			return nil, nil
		},
	}
	f := newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": 1, "command": "document.attach",
		"params": map[string]any{"name": "page"}})
	f.settle()
	<-attaching
	f.command("core.project.close", map[string]string{"id": "prj-a"})
	attached.open()
	f.settle()
	f.command("core.projects.flush", map[string]any{})
	mu.Lock()
	defer mu.Unlock()
	if slices.Contains(states, "tab-aaaaaa") {
		t.Fatalf("the save read the state of a tab of the closed project: %v", states)
	}
}

// sectionsDocument is the document of the installed plugins with a tab view, sections that declare unload and sections that do not.
const sectionsDocument = `{"plugins": [
	{"id": "notes", "package": "@scope/plugin-notes", "version": "1.0.0", "manifest": {"id": "notes", "name": "노트", "description": "notes",
		"mark": "n", "icon": "<path d=\"M1 1h14\"/>", "surface": {"unload": {"format": 1, "maxBytes": 1024}, "composition": {"kind": "view", "page": "ui/index.html"}}}},
	{"id": "boxprobe", "package": "b", "version": "1.0.0", "manifest": {"id": "boxprobe", "name": "브라우저", "description": "boxprobe", "sections": [
		{"id": "boxprobe.tabs", "name": "탭", "composition": {"kind": "view", "page": "ui/section.html"}, "height": 160, "unload": {"format": 2, "maxBytes": 16}},
		{"id": "boxprobe.history", "name": "기록", "composition": {"kind": "view", "page": "ui/section.html"}, "height": "fill"},
		{"id": "boxprobe.dom", "name": "DOM", "composition": {"kind": "view", "page": "ui/section.html"}, "height": "fill"},
		{"id": "boxprobe.network", "name": "네트워크", "composition": {"kind": "view", "page": "ui/section.html"}, "height": "fill"}]}},
	{"id": "fieldprobe", "package": "f", "version": "1.0.0", "manifest": {"id": "fieldprobe", "name": "파일", "description": "fieldprobe", "sections": [
		{"id": "fieldprobe.tree", "name": "파일 트리", "composition": {"kind": "view", "page": "ui/tree.html"}, "height": "fill"},
		{"id": "fieldprobe.bookmarks", "name": "북마크", "composition": {"kind": "view", "page": "ui/bookmarks.html"}, "height": 160}]}}]}`

// sectionsSet is the common settings whose left sidebar shows the sections as tabs, files.tree first.
func sectionsSet() map[string]any {
	return map[string]any{"sets": []any{map[string]any{"id": "set-all", "title": "전체", "layout": "tabs",
		"sections": []any{"fieldprobe.tree", "boxprobe.tabs", "fieldprobe.bookmarks"}}}, "links": []any{map[string]any{"place": "left", "plugin": nil, "set": "set-all"}}}
}

// sectionsApp opens the project of an application whose left sidebar shows the sections as tabs.
func sectionsApp(t *testing.T) (*tabApp, *surfaceHost) {
	t.Helper()
	stored := &surfaceHost{}
	stored.installed = sectionsDocument
	stored.common = sectionsSet()
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}
	f := newTabApp(t, stored, sectionsDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	return f, stored
}

// memoryOf reads the row of the surface id from core.tab.memory.
func (f *tabApp) memoryOf(id string) map[string]any {
	f.t.Helper()
	reply := f.ask("status.get", map[string]any{"name": "core.tab.memory"})
	for _, item := range reply["result"].(map[string]any)["tabs"].([]any) {
		if entry := item.(map[string]any); entry["tab"] == id {
			return entry
		}
	}
	f.t.Fatalf("core.tab.memory has no surface %s: %v", id, reply)
	return nil
}

// surfaceOf reads the row of the surface id from core.surfaces.
func (f *tabApp) surfaceOf(id string) map[string]any {
	f.t.Helper()
	reply := f.ask("status.get", map[string]any{"name": "core.surfaces"})
	for _, item := range reply["result"].([]any) {
		if entry := item.(map[string]any); entry["surface"] == id {
			return entry
		}
	}
	return nil
}

const (
	sectionTree      = "spc-aaaaaa/left/fieldprobe.tree"
	sectionTabs      = "spc-aaaaaa/left/boxprobe.tabs"
	sectionBookmarks = "spc-aaaaaa/left/fieldprobe.bookmarks"
)

// The memory saver observes the section surfaces with the tabs: a hidden section that declares unload starts unloaded and has no view,
// a hidden section without the declaration keeps its view, and showing the section restores it (docs/spec/plugins.md#memory-saver).
func TestAHiddenSectionThatDeclaresUnloadStartsUnloaded(t *testing.T) {
	f, stored := sectionsApp(t)
	surfaces := stored.lastSurfaces(t)
	if surface := surfaces[sectionTree]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown section is %v", surface)
	}
	if surface := surfaces[sectionBookmarks]; surface == nil || surface["visible"] != false {
		t.Fatalf("the hidden section without a declaration is %v", surface)
	}
	if surface := surfaces[sectionTabs]; surface != nil {
		t.Fatalf("the hidden section that declares unload has a view: %v", surface)
	}
	unloaded := f.memoryOf(sectionTabs)
	if unloaded["kind"] != "section" || unloaded["state"] != "unloaded" {
		t.Fatalf("the hidden section that declares unload is %v", unloaded)
	}
	if kept := f.memoryOf(sectionBookmarks); kept["kind"] != "section" || kept["state"] != "loaded" {
		t.Fatalf("the hidden section without a declaration is %v", kept)
	}
	listed := f.surfaceOf(sectionTabs)
	if listed == nil || listed["kind"] != "section" || listed["sidebar"] != "left" || listed["visible"] != false || listed["state"] != "unloaded" {
		t.Fatalf("core.surfaces lists the unloaded section as %v", listed)
	}
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown section is %v", surface)
	}
	if state := f.memoryOf(sectionTabs)["state"]; state != "loaded" {
		t.Fatalf("the restored section is %v", state)
	}
	if surface := stored.lastSurfaces(t)[sectionTree]; surface == nil || surface["visible"] != false {
		t.Fatalf("the section of the earlier tab is %v", surface)
	}
}

// Memory pressure unloads a hidden section that declares unload, and the next show restores it.
func TestPressureUnloadsAHiddenSection(t *testing.T) {
	f, stored := sectionsApp(t)
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "fieldprobe.tree"})
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface == nil || surface["visible"] != false {
		t.Fatalf("the section that was shown is %v", surface)
	}
	f.app.Emit(f.window, "memory-pressure", map[string]any{"level": "warn", "seq": 1})
	f.settle()
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface != nil {
		t.Fatalf("the section keeps a view after the unload: %v", surface)
	}
	if state := f.memoryOf(sectionTabs)["state"]; state != "unloaded" {
		t.Fatalf("the hidden section is %v", state)
	}
	if surface := stored.lastSurfaces(t)[sectionBookmarks]; surface == nil {
		t.Fatal("pressure unloaded a section without a declaration")
	}
	f.app.Emit(f.window, "memory-pressure", map[string]any{"level": "normal", "seq": 2})
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown section is %v", surface)
	}
	if state := f.memoryOf(sectionTabs)["state"]; state != "loaded" {
		t.Fatalf("the restored section is %v", state)
	}
}

// A section view writes its state under the declaration of its section, which is not the declaration of a tab of its plugin.
func TestASectionWritesItsStateUnderItsOwnDeclaration(t *testing.T) {
	f, stored := sectionsApp(t)
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	call := func(surface, plugin, command string, params any) map[string]any {
		t.Helper()
		f.app.Emit(f.window, "view-call", map[string]any{"surface": surface, "plugin": plugin, "generation": 1, "id": 9, "command": command, "params": params})
		f.settle()
		return stored.replies[len(stored.replies)-1]
	}
	if reply := call(sectionTabs, "boxprobe", "tab.state.write", "short"); reply["error"] != nil {
		t.Fatalf("the write is %v", reply)
	}
	if reply := call(sectionTabs, "boxprobe", "tab.state.read", nil); reply["error"] != nil || reply["result"] != "short" {
		t.Fatalf("the read is %v", reply)
	}
	if reply := call(sectionTabs, "boxprobe", "tab.state.write", "more than sixteen bytes"); reply["error"] == nil {
		t.Fatalf("a write over maxBytes is %v", reply)
	}
	if reply := call(sectionTree, "fieldprobe", "tab.state.write", "short"); reply["error"] == nil {
		t.Fatalf("a section without the declaration wrote its state: %v", reply)
	}
}

// hiddenTabsDocument is the document of the installed plugins with a view that declares unload, a view that does not and a view of a plugin
// with a background session.
const hiddenTabsDocument = `{"plugins": [
	{"id": "notes", "package": "@scope/plugin-notes", "version": "1.0.0", "manifest": {"id": "notes", "name": "노트", "description": "notes",
		"mark": "n", "icon": "<path d=\"M1 1h14\"/>", "surface": {"unload": {"format": 1, "maxBytes": 1024}, "composition": {"kind": "view", "page": "ui/index.html"}}}},
	{"id": "plain", "package": "@scope/plugin-plain", "version": "1.0.0", "manifest": {"id": "plain", "name": "평문", "description": "plain",
		"mark": "p", "icon": "<path d=\"M1 1h14\"/>", "surface": {"composition": {"kind": "view", "page": "ui/index.html"}}}}]}`

// hiddenTabsApp opens a project with a shown tab and two hidden tabs, with the setting memorySaver.
func hiddenTabsApp(t *testing.T, memorySaver bool) *surfaceHost {
	t.Helper()
	stored := &surfaceHost{}
	stored.installed = hiddenTabsDocument
	stored.common = map[string]any{"memorySaver": memorySaver}
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"), tab("tab-cccccc", "plain"))}
	f := newTabApp(t, stored, hiddenTabsDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	return stored
}

// While the memory saver is off, a hidden tab mounts at startup (docs/spec/plugins.md#memory-saver).
func TestHiddenTabsMountAtStartupWhileTheMemorySaverIsOff(t *testing.T) {
	surfaces := hiddenTabsApp(t, false).lastSurfaces(t)
	for _, id := range []string{"tab-bbbbbb", "tab-cccccc"} {
		if surface := surfaces[id]; surface == nil || surface["visible"] != false {
			t.Fatalf("the hidden tab %s is %v", id, surface)
		}
	}
}

// While the memory saver is on, a hidden tab that declares unload has no view, and a hidden tab that may never unload mounts.
func TestOnlyAnUndeclaredHiddenTabMountsWhileTheMemorySaverIsOn(t *testing.T) {
	surfaces := hiddenTabsApp(t, true).lastSurfaces(t)
	if surface := surfaces["tab-bbbbbb"]; surface != nil {
		t.Fatalf("the hidden tab that declares unload is %v", surface)
	}
	if surface := surfaces["tab-cccccc"]; surface == nil || surface["visible"] != false {
		t.Fatalf("the hidden tab without the declaration is %v", surface)
	}
}

// A hidden tab of another space mounts at startup, and its view reads the text scale of its stored card.
func TestAHiddenTabOfAnotherSpaceReadsTheTextScaleOfItsCard(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = hiddenTabsDocument
	stored.common = map[string]any{"memorySaver": false}
	project := storedProject(tab("tab-aaaaaa", "notes"))
	other := map[string]any{"xs": []float64{0, 1}, "ys": []float64{0, 1}, "paidBy": map[string]any{}, "cards": []map[string]any{{
		"id": "main", "c0": 0, "c1": 1, "r0": 0, "r1": 1, "data": map[string]any{"tabs": []map[string]any{tab("tab-dddddd", "plain")}, "activeId": "tab-dddddd", "textSize": 1.5}}}}
	project["spaces"] = append(project["spaces"].([]map[string]any), map[string]any{"id": "spc-bbbbbb", "title": "other", "layout": map[string]any{"state": other}})
	stored.projects = []map[string]any{project}
	f := newTabApp(t, stored, hiddenTabsDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	if surface := stored.lastSurfaces(t)["tab-dddddd"]; surface == nil || surface["visible"] != false {
		t.Fatalf("the hidden tab of the other space is %v", surface)
	}
	f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-dddddd", "plugin": "plain", "generation": 1, "id": 5, "command": "runtime.textSize.read"})
	f.settle()
	if reply := stored.replies[len(stored.replies)-1]; reply["error"] != nil || reply["result"] != 1.5 {
		t.Fatalf("the read is %v", reply)
	}
}

const memoryDelayMinutes = 5

// delaySections opens a project on a clock, with the setting memorySaverDelay at its lowest value.
func delaySections(t *testing.T, common map[string]any) (*tabApp, *surfaceHost, *clock) {
	t.Helper()
	stored := &surfaceHost{}
	stored.installed = sectionsDocument
	stored.common = common
	stored.common["memorySaverDelay"] = memoryDelayMinutes
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}
	time := &clock{}
	f := newTabAppAt(t, stored, sectionsDocument, tabClock{time})
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	return f, stored, time
}

// The delay unloads a section that a person hid, as it does a hidden tab, and the next show restores it.
func TestTheDelayUnloadsAHiddenSection(t *testing.T) {
	f, stored, time := delaySections(t, sectionsSet())
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "fieldprobe.tree"})
	time.tick(memoryDelayMinutes*minute - 1)
	f.settle()
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface == nil || surface["visible"] != false {
		t.Fatalf("before the delay the hidden section is %v", surface)
	}
	time.tick(1)
	f.settle()
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface != nil {
		t.Fatalf("after the delay the hidden section is %v", surface)
	}
	if state := f.memoryOf(sectionTabs)["state"]; state != "unloaded" {
		t.Fatalf("after the delay the hidden section is %v", state)
	}
	if surface := stored.lastSurfaces(t)[sectionBookmarks]; surface == nil {
		t.Fatal("the delay unloaded a section without a declaration")
	}
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown section is %v", surface)
	}
	if state := f.memoryOf(sectionTabs)["state"]; state != "loaded" {
		t.Fatalf("the restored section is %v", state)
	}
}

// A set that a person links after the start holds no page of a hidden section that declares unload, and its show mounts it.
func TestASetLinkedAfterTheStartHoldsNoPageOfAHiddenSection(t *testing.T) {
	f, stored, _ := delaySections(t, map[string]any{})
	values := f.ask("status.get", map[string]any{"name": "core.settings"})["result"].(map[string]any)["values"].(map[string]any)
	sets := append(values["sets"].([]any), sectionsSet()["sets"].([]any)...)
	f.command("core.settings.set", map[string]any{"patch": map[string]any{"sets": sets}, "scope": "common"})
	f.command("core.settings.link", map[string]any{"place": "left", "plugin": nil, "set": "set-all", "scope": "common"})
	surfaces := stored.lastSurfaces(t)
	if surface := surfaces[sectionTabs]; surface != nil {
		t.Fatalf("after the link the hidden section is %v", surface)
	}
	if state := f.memoryOf(sectionTabs)["state"]; state != "unloaded" {
		t.Fatalf("after the link the hidden section is %v", state)
	}
	if surface := surfaces[sectionBookmarks]; surface == nil || surface["visible"] != false {
		t.Fatalf("after the link the hidden section without a declaration is %v", surface)
	}
	f.command("core.sidebar.section.select", map[string]string{"sidebar": "left", "section": "boxprobe.tabs"})
	if surface := stored.lastSurfaces(t)[sectionTabs]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown section is %v", surface)
	}
}

// twoProjectsApp opens the first of two projects on a clock, with a shown tab and a hidden tab in each.
func twoProjectsApp(t *testing.T) (*tabApp, *surfaceHost, *clock) {
	t.Helper()
	stored := &surfaceHost{}
	stored.installed = hiddenTabsDocument
	stored.common = map[string]any{"memorySaverDelay": memoryDelayMinutes, "projectOpening": "tabs"}
	other := storedProject(tab("tab-dddddd", "plain"), tab("tab-eeeeee", "notes"))
	other["id"], other["root"], other["identity"] = "prj-b", "/b", "identity of /b"
	other["spaces"].([]map[string]any)[0]["id"] = "spc-bbbbbb"
	other["activeSpaceId"] = "spc-bbbbbb"
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes")), other}
	time := &clock{}
	f := newTabAppAt(t, stored, hiddenTabsDocument, tabClock{time})
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	return f, stored, time
}

// A project that the window has not opened has no surface and no entry of the memory saver.
func TestAProjectThatTheWindowHasNotOpenedHoldsNoSurface(t *testing.T) {
	f, stored, _ := twoProjectsApp(t)
	if surface := stored.lastSurfaces(t)["tab-dddddd"]; surface != nil {
		t.Fatalf("the tab of the project that was not opened is %v", surface)
	}
	for _, entry := range f.ask("status.get", map[string]any{"name": "core.tab.memory"})["result"].(map[string]any)["tabs"].([]any) {
		if entry.(map[string]any)["tab"] == "tab-dddddd" {
			t.Fatalf("the memory saver holds the tab of the project that was not opened: %v", entry)
		}
	}
}

// A project that the window left stays in the memory saver: the delay unloads its hidden tab, and its show restores it.
func TestTheDelayUnloadsATabOfAProjectThatTheWindowLeft(t *testing.T) {
	f, stored, time := twoProjectsApp(t)
	f.command("core.project.activate", map[string]string{"id": "prj-b"})
	if surface := stored.lastSurfaces(t)["tab-aaaaaa"]; surface == nil || surface["visible"] != false {
		t.Fatalf("the tab of the project that was left is %v", surface)
	}
	time.tick(memoryDelayMinutes * minute)
	f.settle()
	if surface := stored.lastSurfaces(t)["tab-aaaaaa"]; surface != nil {
		t.Fatalf("after the delay the tab of the project that was left is %v", surface)
	}
	if state := f.memoryOf("tab-aaaaaa")["state"]; state != "unloaded" {
		t.Fatalf("after the delay the tab of the project that was left is %v", state)
	}
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	if surface := stored.lastSurfaces(t)["tab-aaaaaa"]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown tab is %v", surface)
	}
	if state := f.memoryOf("tab-aaaaaa")["state"]; state != "loaded" {
		t.Fatalf("the restored tab is %v", state)
	}
}

// A hidden tab of a project that the window opens later has never been seen, so it starts unloaded and its show mounts it.
func TestAHiddenTabOfAProjectOpenedLaterStartsUnloaded(t *testing.T) {
	f, stored, _ := twoProjectsApp(t)
	f.command("core.project.activate", map[string]string{"id": "prj-b"})
	if surface := stored.lastSurfaces(t)["tab-eeeeee"]; surface != nil {
		t.Fatalf("the hidden tab of the later project is %v", surface)
	}
	if state := f.memoryOf("tab-eeeeee")["state"]; state != "unloaded" {
		t.Fatalf("the hidden tab of the later project is %v", state)
	}
	f.command("core.tab.select", map[string]string{"tab": "tab-eeeeee"})
	if surface := stored.lastSurfaces(t)["tab-eeeeee"]; surface == nil || surface["visible"] != true {
		t.Fatalf("the shown tab is %v", surface)
	}
}

func TestColdHiddenSurfaceStatusKeepsThePublicCompositionKind(t *testing.T) {
	stored := &surfaceHost{}
	stored.common = map[string]any{"memorySaver": false}
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"), tab("tab-cccccc", "plain"))}
	f := newTabApp(t, stored, hiddenTabsDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	for _, id := range []string{"tab-bbbbbb", "tab-cccccc"} {
		row := f.surfaceOf(id)
		if row == nil || row["visible"] != false || row["composition"] != "view" {
			t.Errorf("a cold hidden retained view must expose the same public kind string: %s %+v", id, row)
		}
		held := stored.lastSurfaces(t)[id]
		if held == nil || held["composition"] == nil {
			t.Errorf("the internal hidden composition configuration was lost: %s %+v", id, held)
		}
	}
}
