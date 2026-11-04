// The file commands, the memory saver and the background sessions on the shell of a window: a request reaches them through the
// registry of the window, and the plane of the shown project is what they read.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestACommandThatAnswersLaterRepliesThroughTheRelay(t *testing.T) {
	r := registry(t)
	var answer func(any, error)
	r.CommandLater("core.file.place", func(params json.RawMessage, reply func(any, error)) { answer = reply })
	relay := newRelay(t, r)
	relay.requests.Deliver(map[string]any{"id": uint64(7), "method": "command.run", "params": json.RawMessage(`{"name":"core.file.place","params":{"name":"a.md"}}`)})
	relay.queue.run()
	select {
	case reply := <-relay.replies:
		t.Fatalf("the reply came before the answer: %s", reply)
	default:
	}
	answer(map[string]string{"path": "a.md"}, nil)
	equal(t, <-relay.replies, `{"id":7,"result":{"path":"a.md"}}`)
	relay.queue.run()
	code, text := relay.refused(relay.ask("command.run", `{"name":"core.file.place","params":{"name":3}}`))
	equal(t, code, workbench.InvalidParams)
	equal(t, text, "invalid params for core.file.place")
	list, err := r.Answer("exposure.list", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	listed := false
	for _, row := range list.(map[string][]map[string]any)["commands"] {
		if row["name"] == "core.file.place" {
			listed = row["registered"].(bool)
		}
	}
	equal(t, listed, true)
}

type fakeSurfaces struct {
	mounted  map[string]bool
	restored []string
}

func (f *fakeSurfaces) Mounted(tab string) bool { return f.mounted[tab] }
func (f *fakeSurfaces) DetachHeld(string) bool  { return false }
func (f *fakeSurfaces) Keeps(string) []string   { return nil }
func (f *fakeSurfaces) Regions(_ string, answer func([]string, error)) {
	answer(nil, nil)
}
func (f *fakeSurfaces) Interaction(_ string, answer func(map[string]string, error)) {
	answer(nil, nil)
}
func (f *fakeSurfaces) AttachedTabs() []string     { return nil }
func (f *fakeSurfaces) Restore(tab string)         { f.restored = append(f.restored, tab) }
func (f *fakeSurfaces) ReportTitle(string, string) {}
func (f *fakeSurfaces) ReportState(string, string) {}

// tabShell is a shell with its tab ports, over a host that also stores the tab state and answers the sidecar calls.
type tabShell struct {
	*shellFixture
	surfaces *fakeSurfaces
	timers   *clock
	commits  int
	sidecar  chan string
	events   *stateEvents
	failed   []string
	keptPuts []string
}

func newTabShell(t *testing.T, stored *storedHost) *tabShell {
	t.Helper()
	return newTabShellWithState(t, stored, nil)
}

func newTabShellWithState(t *testing.T, stored *storedHost, refused error) *tabShell {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &tabShell{shellFixture: &shellFixture{t: t, host: stored, pending: make(steps, 256)}, surfaces: &fakeSurfaces{mounted: map[string]bool{}},
		timers: &clock{}, sidecar: make(chan string, 16), events: &stateEvents{}}
	table := stored.table()
	base := table["workspace"]
	table["workspace"] = func(ctx context.Context, argument json.RawMessage) (any, error) {
		var request struct {
			Kind string
			Tab  string
		}
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		switch request.Kind {
		case "tabState":
			return nil, refused
		case "tabSession":
			return nil, nil
		case "tabSessions":
			return []string{}, nil
		case "tabStatePut":
			f.keptPuts = append(f.keptPuts, string(argument))
			return 1, nil
		case "tabSessionPut":
			return 1, nil
		}
		return base(ctx, argument)
	}
	record := func(name string) workbench.HostCall {
		return func(_ context.Context, argument json.RawMessage) (any, error) {
			f.sidecar <- name + " " + string(argument)
			return nil, nil
		}
	}
	table["sidecarListen"] = record("listen")
	table["sidecarSend"] = record("send")
	shell, err := workbench.NewShell(workbench.ShellOptions{
		Declared:    declared,
		Calls:       workbench.NewCalls(table, f.pending.post),
		Environment: environment(t),
		Installed:   []byte(`{"plugins": []}`),
		Invalidate:  func() {},
		Post:        f.pending.post,
		Report:      func(line string) { f.lines = append(f.lines, line) },
		Tabs: &workbench.TabPorts{
			Plugins: func() []workbench.ShellPlugin {
				return []workbench.ShellPlugin{
					{ID: "notes", Opens: []string{"md"}, Unload: true},
					{ID: "session", Background: &workbench.BackgroundDeclaration{Sidecar: backgroundSidecar, Operation: "open"}},
				}
			},
			Surfaces:       f.surfaces,
			Enabled:        func() bool { return true },
			Delay:          func() int { return 120 },
			PluginSettings: func(string) map[string]any { return nil },
			Commit: func(answer func(error)) {
				f.commits++
				answer(nil)
			},
			Emit:  f.events.emit,
			Now:   func() int64 { return f.timers.now },
			After: f.timers.after,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.shell = shell
	f.tester = ui.NewTester(shell.View, 1200, 800)
	shell.Start()
	if refused != nil {
		f.pending.drain(t)
		f.tester.Frame()
		return f
	}
	f.settle()
	return f
}

func storedProject(tabs ...map[string]any) map[string]any {
	state := map[string]any{"xs": []float64{0, 1}, "ys": []float64{0, 1}, "paidBy": map[string]any{}, "cards": []map[string]any{{
		"id": "main", "c0": 0, "c1": 1, "r0": 0, "r1": 1, "data": map[string]any{"tabs": tabs, "activeId": tabs[0]["id"]}}}}
	return map[string]any{"id": "prj-a", "named": 1, "title": "a", "root": "/a", "identity": "identity of /a", "color": "#ffb36b", "activeSpaceId": "spc-aaaaaa",
		"spaces": []map[string]any{{"id": "spc-aaaaaa", "title": "main", "layout": map[string]any{"state": state}}}}
}

func (f *tabShell) open(t *testing.T) {
	t.Helper()
	if _, err := f.shell.Registry().Run("core.project.activate", json.RawMessage(`{"id":"prj-a"}`)); err != nil {
		t.Fatal(err)
	}
	f.settle()
}

func (f *tabShell) run(t *testing.T, name, params string) any {
	t.Helper()
	var value any
	var failure error
	answered := false
	f.shell.Registry().RunLater(name, json.RawMessage(params), func(result any, err error) { value, failure, answered = result, err, true })
	f.settle()
	if !answered {
		t.Fatalf("%s did not answer", name)
	}
	if failure != nil {
		t.Fatal(failure)
	}
	return value
}

func tab(id, plugin string) map[string]any {
	return map[string]any{"id": id, "plugin": plugin, "title": id}
}

func TestCoreFileOpenAddsATabOfTheOpenerAndActivatesItTheNextTime(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))}})
	f.open(t)
	opened := f.run(t, "core.file.open", `{"path":"docs/a.md"}`).(workbench.FileOpened)
	equal(t, opened.Card, "main")
	if !strings.HasPrefix(opened.Tab, "tab-") || opened.Tab == "tab-aaaaaa" {
		t.Fatalf("tab %s", opened.Tab)
	}
	if _, err := f.shell.Registry().Run("core.tab.select", json.RawMessage(`{"tab":"tab-aaaaaa"}`)); err != nil {
		t.Fatal(err)
	}
	again := f.run(t, "core.file.open", `{"path":"docs/a.md"}`).(workbench.FileOpened)
	equal(t, again, opened)
}

func TestCoreFileOpenWithoutAProjectIsRefused(t *testing.T) {
	f := newTabShell(t, &storedHost{})
	var failure error
	f.shell.Registry().RunLater("core.file.open", json.RawMessage(`{"path":"a.md"}`), func(_ any, err error) { failure = err })
	equal(t, message(failure), "this window shows no project")
}

func memoryTabs(t *testing.T, f *tabShell) map[string]map[string]any {
	t.Helper()
	status, err := f.shell.Registry().Read("core.tab.memory")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var read struct {
		Enabled bool
		Tabs    []map[string]any
	}
	if err := json.Unmarshal(encoded, &read); err != nil {
		t.Fatal(err)
	}
	equal(t, read.Enabled, true)
	tabs := map[string]map[string]any{}
	for _, row := range read.Tabs {
		tabs[row["tab"].(string)] = row
	}
	return tabs
}

func TestTheMemorySaverReadsTheTabsOfThePlaneAndAShowRestoresAnUnloadedTab(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"), tab("tab-cccccc", "session"), tab("tab-dddddd", "other"))}})
	f.open(t)
	tabs := memoryTabs(t, f)
	equal(t, tabs["tab-aaaaaa"]["reasons"], []any{"shown"})
	equal(t, tabs["tab-bbbbbb"]["reasons"], []any{})
	equal(t, tabs["tab-cccccc"]["reasons"], []any{"background"})
	equal(t, tabs["tab-dddddd"]["reasons"], []any{"undeclared"})
	// A hidden tab of a declaring plugin that was never shown starts unloaded.
	equal(t, tabs["tab-bbbbbb"]["state"], "unloaded")
	equal(t, f.commits, 1)
	if _, err := f.shell.Registry().Run("core.tab.select", json.RawMessage(`{"tab":"tab-bbbbbb"}`)); err != nil {
		t.Fatal(err)
	}
	f.settle()
	equal(t, memoryTabs(t, f)["tab-bbbbbb"]["state"], "restoring")
	equal(t, f.surfaces.restored, []string{"tab-bbbbbb"})
	// The first tab is hidden now, and the delay unloads it.
	f.timers.tick(120 * minute)
	f.settle()
	equal(t, memoryTabs(t, f)["tab-aaaaaa"]["state"], "unloaded")
	var unloaded []string
	for _, event := range f.events.events {
		if event.name == "workbench.tab.unloaded" {
			unloaded = append(unloaded, event.fields["tab"].(string))
		}
	}
	equal(t, unloaded, []string{"tab-aaaaaa"})
}

func TestCoreTabKeepStoresTheMarkInTheTabStateStore(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}})
	f.open(t)
	f.run(t, "core.tab.keep", `{"tab":"tab-bbbbbb","keep":true}`)
	f.timers.tick(1000)
	f.settle()
	equal(t, f.keptPuts, []string{`{"entry":{"kept":true},"kind":"tabStatePut","tab":"tab-bbbbbb"}`})
	equal(t, memoryTabs(t, f)["tab-bbbbbb"]["reasons"], []any{"kept"})
}

func TestAClosedTabLosesItsEntryAfterTheLayoutIsStored(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}})
	f.open(t)
	f.run(t, "core.tab.keep", `{"tab":"tab-bbbbbb","keep":true}`)
	if _, err := f.shell.Registry().Run("core.tab.close", json.RawMessage(`{"tab":"tab-bbbbbb"}`)); err != nil {
		t.Fatal(err)
	}
	f.settle()
	f.timers.tick(1000)
	f.settle()
	equal(t, f.keptPuts, []string{`{"entry":null,"kind":"tabStatePut","tab":"tab-bbbbbb"}`})
	if _, known := memoryTabs(t, f)["tab-bbbbbb"]; known {
		t.Fatal("the closed tab stayed")
	}
}

func TestABackgroundTabOpensItsSessionWhenTheProjectIsShownAndAMessageReachesIt(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-cccccc", "session"))}})
	f.open(t)
	equal(t, <-f.sidecar, `listen {"id":"tab-cccccc","on":true,"sidecar":"`+backgroundSidecar+`"}`)
	f.settle()
	equal(t, <-f.sidecar, `send {"body":{"operation":"open"},"cids":[],"sidecar":"`+backgroundSidecar+`","surface":"tab-cccccc"}`)
	f.settle()
	f.shell.Event("sidecar-message", []any{map[string]any{"sidecar": backgroundSidecar, "surface": "tab-cccccc", "body": map[string]any{"event": "connection", "connected": true}}})
	f.settle()
	equal(t, <-f.sidecar, `send {"body":{"operation":"open"},"cids":[],"sidecar":"`+backgroundSidecar+`","surface":"tab-cccccc"}`)
	f.settle()
	decisions := []string{}
	for _, event := range f.events.events {
		if event.name == "workbench.background.session" {
			decisions = append(decisions, event.fields["action"].(string))
		}
	}
	equal(t, decisions, []string{"open", "reopen"})
	if _, err := f.shell.Registry().Run("core.tab.select", json.RawMessage(`{"tab":"tab-cccccc"}`)); err != nil {
		t.Fatal(err)
	}
	f.settle()
	equal(t, <-f.sidecar, `listen {"id":"tab-cccccc","on":false,"sidecar":"`+backgroundSidecar+`"}`)
	f.settle()
}

func TestASidecarFailureWithoutAHandlerIsShown(t *testing.T) {
	f := newTabShell(t, &storedHost{})
	f.shell.Event("sidecar-failure", []any{map[string]any{"sidecar": "files", "surface": "tab-aaaaaa", "reason": "exited"}})
	if !slices.Contains(f.lines, "workbench: sidecar files failed for surface tab-aaaaaa: exited") {
		t.Fatalf("lines %v", f.lines)
	}
}

func TestAFailedOpenOfTheTabStateStoreIsShown(t *testing.T) {
	stored := &storedHost{}
	f := newTabShellWithState(t, stored, errors.New("tab-state.json: tab state format 2 is not 1"))
	if !f.tester.HasText("tab-state.json: tab state format 2 is not 1") {
		t.Fatalf("the window shows %q", f.tester.Texts())
	}
	if !slices.Contains(stored.calls, "windowReady") {
		t.Fatalf("the window stayed unready: %v", stored.calls)
	}
}
