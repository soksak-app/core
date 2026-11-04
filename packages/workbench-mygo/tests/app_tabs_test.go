// The tab parts of the application over the surfaces of a window: what the memory saver unloads leaves the placement, and a tab that is
// shown again returns through it.
package workbench_test

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// unloadDocument is the document of the installed plugins with a view that the memory saver can unload.
const unloadDocument = `{"plugins": [{"id": "notes", "package": "@soksak/plugin-notes", "version": "1.0.0", "manifest": {"id": "notes", "name": "노트",
	"mark": "n", "surface": {"unload": {"format": 1, "maxBytes": 1024}, "composition": {"kind": "view", "page": "ui/index.html"}}}}]}`

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

func newTabApp(t *testing.T, stored *surfaceHost, document string) *tabApp {
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
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: f.queue.post, Table: table,
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
