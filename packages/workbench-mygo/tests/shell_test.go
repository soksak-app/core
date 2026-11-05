package workbench_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	sok "github.com/soksak-app/core/packages/sok/go/src"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// storedHost answers the host calls of the shell from memory, as the workspace store of the language host library does.
type storedHost struct {
	folderSettings map[string]map[string]any // The settings files of the folders, by root.
	keepsProjects  bool                      // The answer of projectRemoveAsk is that the project stays.
	plugins        *pluginsHost
	// reloads counts the starts of the workbench that the shell asked for.
	reloads int
	// located is the project that the shell last named as the one that its window shows.
	located string
	// backdrops are the colors that the shell gave the window behind its surfaces.
	backdrops []string
	// detaching are the surfaces whose image detach is pending when a window starts.
	detaching []string
	projects  []map[string]any
	// createRefused is the refusal of projectCreate.
	createRefused error
	// open are the projects that the host names as owned by a window.
	open []string
	// appUpdate is the answer of appUpdateState, and opened holds the arguments of linkOpen.
	appUpdate any
	opened    []json.RawMessage
	// backgrounds are the values of setDialogBackground in their order.
	backgrounds []bool
	// forwards are the requests that the shell forwarded to surfaces, and each gets an empty result.
	forwards []map[string]any
	// extra holds the host calls that the base table has not.
	extra map[string]workbench.HostCall
	calls []string
	shown []any
	// tabState is the document of the tab state store, and sessionTabs the tabs with a stored session.
	tabState    any
	sessionTabs []string
	// startFails tells that the start of the shell shows an error, so the fixture does not audit it.
	startFails bool
	// retains holds the argument of each sidecarsRetain call.
	retains []json.RawMessage
	failing map[string]error
	// policies holds the policy of each log call that stores one, and traces the action of each performance call.
	policies []map[string]string
	traces   []string
	// installed is the document of the installed plugins, and it is empty without plugins.
	installed string
	// classes is the policy in force that the host call log answers; none stores the errors.
	classes map[string]any
	// batchCalls makes each batch of events a call of calls.
	batchCalls bool
	mu         sync.Mutex
	batches    []map[string]any
	// common holds the common settings, and settings each write of the settings.
	common   map[string]any
	settings []map[string]any
	// theme and language hold the last theme and menu language that the shell sent.
	theme, language json.RawMessage
}

// log answers the host call log and keeps the events of its batches.
func (h *storedHost) log(_ context.Context, argument json.RawMessage) (any, error) {
	if err := h.failing["log"]; err != nil {
		return nil, err
	}
	var request struct {
		Action  string            `json:"action"`
		Events  []map[string]any  `json:"events"`
		Classes map[string]string `json:"classes"`
	}
	if err := json.Unmarshal(argument, &request); err != nil {
		return nil, err
	}
	switch request.Action {
	case "clock":
		return &host.ClockReading{TsMicros: time.Now().UnixMicro(), MonoNs: 1 << 40}, nil
	case "policy":
		h.mu.Lock()
		defer h.mu.Unlock()
		h.policies = append(h.policies, request.Classes)
		return nil, nil
	case "policy-read":
		if h.classes != nil {
			return map[string]any{"classes": h.classes}, nil
		}
		return map[string]any{"classes": sok.DefaultLogPolicy().Classes()}, nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.batches = append(h.batches, request.Events...)
	if h.batchCalls {
		h.calls = append(h.calls, "log")
	}
	return nil, nil
}

// called reports whether the host received the call name.
func (h *storedHost) called(name string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Contains(h.calls, name)
}

// written returns the events named name that reached the host.
func (h *storedHost) written(name string) []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	var events []map[string]any
	for _, event := range h.batches {
		if event["event"] == name {
			events = append(events, event)
		}
	}
	return events
}

// shownErrors takes the errors that the shell recorded and returns their texts.
func (f *shellFixture) shownErrors() []string {
	f.t.Helper()
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.host.mu.Lock()
	defer f.host.mu.Unlock()
	var texts []string
	kept := f.host.batches[:0]
	for _, event := range f.host.batches {
		if event["event"] != "workbench.record.error" {
			kept = append(kept, event)
			continue
		}
		fields, _ := event["fields"].(map[string]any)
		text, _ := fields["text"].(string)
		texts = append(texts, text)
	}
	f.host.batches = kept
	return texts
}

func (h *storedHost) table() map[string]workbench.HostCall {
	answer := func(name string, read func(argument json.RawMessage) (any, error)) workbench.HostCall {
		return func(_ context.Context, argument json.RawMessage) (any, error) {
			h.mu.Lock()
			h.calls = append(h.calls, name)
			h.mu.Unlock()
			if err := h.failing[name]; err != nil {
				return nil, err
			}
			return read(argument)
		}
	}
	none := func(json.RawMessage) (any, error) { return nil, nil }
	return map[string]workbench.HostCall{
		"log": h.log,
		"notificationState": answer("notificationState", func(json.RawMessage) (any, error) {
			return map[string]string{"authorization": "notDetermined"}, nil
		}),
		"workspace": answer("workspace", h.workspace),
		"performance": answer("performance", func(argument json.RawMessage) (any, error) {
			var request struct {
				Action string `json:"action"`
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			h.traces = append(h.traces, request.Action)
			return nil, nil
		}),
		"projectFolder": answer("projectFolder", func(argument json.RawMessage) (any, error) {
			var root string
			if err := json.Unmarshal(argument, &root); err != nil {
				return nil, err
			}
			return map[string]string{"root": root, "identity": "identity of " + root}, nil
		}),
		"projectCreate": answer("projectCreate", func(argument json.RawMessage) (any, error) {
			if h.createRefused != nil {
				return nil, h.createRefused
			}
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
		"projectRemoveAsk": answer("projectRemoveAsk", func(json.RawMessage) (any, error) { return !h.keepsProjects, nil }),
		"folderChoose":     answer("folderChoose", func(json.RawMessage) (any, error) { return "/chosen", nil }),
		"windowReady":      answer("windowReady", none),
		"sidecarsRetain": answer("sidecarsRetain", func(argument json.RawMessage) (any, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.retains = append(h.retains, argument)
			return nil, nil
		}),
		"setTheme":           answer("setTheme", func(argument json.RawMessage) (any, error) { h.theme = argument; return nil, nil }),
		"compositionDeclare": answer("compositionDeclare", none),
		"syncSurfaces": answer("syncSurfaces", func(json.RawMessage) (any, error) {
			return map[string]any{"ticket": 1, "placements": []any{}, "chrome": map[string]any{}}, nil
		}),
		"presentSurfaces": answer("presentSurfaces", none),
		"surfaceFocus":    answer("surfaceFocus", none),
		"exposureForward": answer("exposureForward", func(argument json.RawMessage) (any, error) {
			var request map[string]any
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			h.forwards = append(h.forwards, request)
			return map[string]any{"result": nil}, nil
		}),
		"viewReply": answer("viewReply", none),
		"setDialogBackground": answer("setDialogBackground", func(argument json.RawMessage) (any, error) {
			var request host.DialogBackground
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			h.backgrounds = append(h.backgrounds, request.Enabled)
			return nil, nil
		}),
		"setMenuLanguage": answer("setMenuLanguage", func(argument json.RawMessage) (any, error) { h.language = argument; return nil, nil }),
		"windowNew":       answer("windowNew", none),
		"windowClose":     answer("windowClose", none),
		"windowCloseKept": answer("windowCloseKept", none),
		"pluginsState":    answer("pluginsState", h.pluginHost().state),
		"pluginsRun":      answer("pluginsRun", h.pluginHost().run),
		"pluginsUseRegistry": answer("pluginsUseRegistry", func(argument json.RawMessage) (any, error) {
			var request struct{ Index string }
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			plugins := h.pluginHost()
			plugins.used = append(plugins.used, request.Index)
			plugins.registry = request.Index
			return nil, nil
		}),
		"pluginsStarter": answer("pluginsStarter", func(argument json.RawMessage) (any, error) {
			var request struct {
				State, Pack, Registry string
				Plugins               []string
			}
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			plugins := h.pluginHost()
			plugins.jobs = append(plugins.jobs, request.State+" "+request.Pack)
			plugins.starter = map[string]any{"format": 1, "state": request.State, "pack": request.Pack, "registry": request.Registry, "plugins": request.Plugins}
			return nil, nil
		}),
		"linkOpen":         answer("linkOpen", func(argument json.RawMessage) (any, error) { h.opened = append(h.opened, argument); return nil, nil }),
		"appUpdateState":   answer("appUpdateState", func(json.RawMessage) (any, error) { return h.appUpdate, nil }),
		"appUpdateStage":   answer("appUpdateStage", func(json.RawMessage) (any, error) { return map[string]string{"bundle": "/staged/soksak.app"}, nil }),
		"appUpdateApply":   answer("appUpdateApply", none),
		"sidecarsOutdated": answer("sidecarsOutdated", func(json.RawMessage) (any, error) { return h.pluginHost().outdated, nil }),
		"debugFiles": answer("debugFiles", func(json.RawMessage) (any, error) {
			return []map[string]any{{"path": "older.log", "size": 1, "modified": 1}, {"path": "newer.log", "size": 2, "modified": 2}}, nil
		}),
		"debugRecord": answer("debugRecord", func(json.RawMessage) (any, error) {
			return map[string]string{"path": "logs/state-20261104T000000Z.json"}, nil
		}),
		"debugSave": answer("debugSave", func(argument json.RawMessage) (any, error) {
			var request struct{ Path string }
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			return map[string]string{"saved": "/saved/" + request.Path}, nil
		}),
		"debugRead": answer("debugRead", func(argument json.RawMessage) (any, error) {
			var request struct{ Path string }
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			return map[string]any{"path": request.Path, "size": 4, "kind": "text", "text": "text of " + request.Path}, nil
		}),
	}
}

// pluginHost returns the plugin state of the host, which has no plugin and a registry that the test did not set by default.
func (h *storedHost) pluginHost() *pluginsHost {
	if h.plugins == nil {
		h.plugins = &pluginsHost{core: "1.0.0", plugins: map[string]map[string]any{}}
	}
	return h.plugins
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
		Remove  []string
		Delta   int
	}
	if err := json.Unmarshal(argument, &request); err != nil {
		return nil, err
	}
	switch request.Kind {
	case "snapshot":
		for _, project := range h.projects {
			if settings, ok := h.folderSettings[project["root"].(string)]; ok {
				project["settings"] = settings
			}
		}
		return map[string]any{"projects": h.projects, "open": h.open, "common": h.common}, nil
	case "settings":
		h.settings = append(h.settings, map[string]any{"id": request.ID, "patch": request.Patch, "remove": request.Remove})
		return nil, nil
	case "tabState", "tabSession":
		return nil, nil
	case "tabSessions":
		return []string{}, nil
	case "tabStatePut", "tabSessionPut":
		return 1, nil
	case "add":
		for _, project := range h.projects {
			if project["root"] == request.Project["root"] {
				return project, nil
			}
		}
		delete(request.Project, "settings") // The settings of a project are the file of its folder.
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
	case "move":
		at := slices.IndexFunc(h.projects, func(project map[string]any) bool { return project["id"] == request.ID })
		to := at + request.Delta
		if at >= 0 && to >= 0 && to < len(h.projects) {
			project := h.projects[at]
			h.projects = slices.Insert(slices.Delete(h.projects, at, at+1), to, project)
		}
		return nil, nil
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
	t       testing.TB
	host    *storedHost
	shell   *workbench.Shell
	tester  *ui.Tester
	pending steps
	lines   []string
	reloads int
	// frames counts the frames that the shell asked for.
	frames int
	// treeReads counts the reads of the element tree.
	treeReads int
	// treeEdit changes the element tree that the shell reads, as a window that drew elsewhere.
	treeEdit func(tree []ui.ElementNode)
}

// installedDocument is the document of the installed plugins of the host.
func (h *storedHost) installedDocument() string {
	if h.installed == "" {
		return `{"plugins":[]}`
	}
	return h.installed
}

// environment reads the environment declaration of the application, which the shell receives from the assets of the application.
func environment(t testing.TB) []byte {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("testdata", "application-environment.json"))
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func newShell(t testing.TB, stored *storedHost) *shellFixture {
	t.Helper()
	f := startedShell(t, stored)
	f.settle()
	return f
}

// startedShell is newShell without its settle, for a start whose failure the test expects.
func startedShell(t testing.TB, stored *storedHost) *shellFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	f := &shellFixture{t: t, host: stored, pending: make(steps, 256)}
	shell, err := workbench.NewShell(workbench.ShellOptions{
		Detaching: func() []string { return nil },
		Window: func() (workbench.WindowView, error) {
			return workbench.WindowView{Visible: true, Scale: 2, Width: 1200, Height: 800}, nil
		},
		Element:     func(string) (uintptr, uintptr, bool) { return 0, 0, false },
		Declared:    declared,
		Calls:       workbench.NewCalls(stored.table(), f.pending.post),
		Environment: environment(t),
		Installed:   []byte(stored.installedDocument()),
		Invalidate:  func() { f.frames++ },
		Elements:    fixtureElements{f},
		Post:        f.pending.post,
		Report:      func(line string) { f.lines = append(f.lines, line) },
		Reload:      func() { stored.reloads++ },
		Located:     func(project string) { stored.located = project },
		Backdrop:    func(color string) error { stored.backdrops = append(stored.backdrops, color); return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.shell = shell
	f.tester = ui.NewTester(shell.View, 1200, 800)
	shell.Start()
	return f
}

// settle runs every later step and draws the frame that shows their result.
func (f *shellFixture) settle() {
	f.t.Helper()
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
	noteElementNames(f.tester.ElementTree())
	if len(f.lines) > 0 {
		f.t.Fatalf("the shell reported %q", f.lines)
	}
	if errors := f.host.written("workbench.record.error"); len(errors) > 0 {
		f.t.Fatalf("the shell recorded %v", errors)
	}
}

// exposedNode returns the element with the element name, and with the item when item is not "".
func exposedNode(nodes []ui.ElementNode, name, item string) (ui.ElementNode, bool) {
	noteElementNames(nodes)
	return findExposed(nodes, name, item)
}

func findExposed(nodes []ui.ElementNode, name, item string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == name && (item == "" || exposed.Item == item) {
			return node, true
		}
		if found, ok := findExposed(node.Children, name, item); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

// has tells whether the window shows the element: an element without a size holds its index and shows nothing.
func (f *shellFixture) has(name, item string) bool {
	node, ok := exposedNode(f.tester.ElementTree(), name, item)
	return ok && (node.Bounds.W > 0 || node.Bounds.H > 0)
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
	var failure error
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) { failure = err })
	f.settle()
	if failure != nil {
		f.t.Fatal(failure)
	}
}

// answerText runs a command as the endpoint runs it and returns its answer as JSON.
func (f *shellFixture) answerText(name string, params any) string {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	answered := false
	var value any
	var failure error
	f.shell.Registry().RunLater(name, raw, func(answer any, err error) { answered, value, failure = true, answer, err })
	f.settle()
	if !answered {
		f.t.Fatalf("%s did not answer", name)
	}
	if failure != nil {
		f.t.Fatalf("%s failed: %v", name, failure)
	}
	text, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(text)
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

func TestTheWindowNamesTheProjectThatItShows(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	if f.host.located != id {
		t.Fatalf("the window names %q, not %s", f.host.located, id)
	}
	f.run("core.projects.browse", nil)
	if f.host.located != id {
		t.Fatal("the library over an open project gave up the project of the window")
	}
	if err := f.finish("core.project.close", map[string]string{"id": id}); err != nil {
		t.Fatal(err)
	}
	if f.host.located != "" {
		t.Fatalf("the window still names %q", f.host.located)
	}
}

func TestWindowIsReadyAfterTheSnapshot(t *testing.T) {
	f := newShell(t, &storedHost{})
	if strings.Join(startCalls(f.host.calls), " ") != "workspace windowReady notificationState pluginsState sidecarsOutdated sidecarsRetain" {
		t.Fatalf("the start called %v", f.host.calls)
	}
}

func TestStartSendsTheThemeAndTheLanguageOfTheMenu(t *testing.T) {
	f := newShell(t, &storedHost{})
	if f.host.theme == nil || f.host.language == nil {
		t.Fatalf("the start called %v", f.host.calls)
	}
}

// startCalls are the calls of the start without the appearance and the trace switch, which run in their own order beside them.
func startCalls(calls []string) []string {
	var kept []string
	for _, call := range calls {
		if call != "setTheme" && call != "setMenuLanguage" && call != "performance" {
			kept = append(kept, call)
		}
	}
	return kept
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
	f := projectWithPlugins(t)
	before := f.tabbedCards()
	f.click("core.card.split-x", before[0])
	f.click("core.picker.item", "acme")
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
	f := projectWithPlugins(t)
	card := f.tabbedCards()[0]
	f.click("core.card.add", card)
	f.click("core.picker.item", "acme")
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
	first := projectWithPlugins(t)
	card := first.tabbedCards()[0]
	first.click("core.card.split-x", card)
	first.click("core.picker.item", "acme")
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
	shown, err := f.shell.Registry().Read("core.workbench.error")
	if err != nil {
		t.Fatal(err)
	}
	if text, ok := shown.(*string); !ok || text == nil || *text != "project directory is gone" {
		t.Fatalf("the status core.workbench.error is %v", shown)
	}
}

// drain runs the later steps until no call of the host is answering. The handlers of storedHost answer at once.
// until runs the steps until done reports true.
func (s steps) until(t testing.TB, done func() bool) {
	t.Helper()
	limit := time.After(5 * time.Second)
	for !done() {
		select {
		case task := <-s:
			task()
		case <-time.After(time.Millisecond):
			// The state can arrive on the goroutine of a host call, without a step.
		case <-limit:
			t.Fatal("the steps ended before the state arrived")
		}
	}
}

func (s steps) drain(t testing.TB) {
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

// core.project.open adds the folder as a project with a fresh layout, shows it and answers with the project.
func TestProjectOpenCommandOpensTheFolder(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	var answer any
	var failure error
	answered := false
	f.shell.Registry().RunLater("core.project.open", json.RawMessage(`{"root":"/work/alpha"}`), func(value any, err error) {
		answered, answer, failure = true, value, err
	})
	f.settle()
	if !answered || failure != nil {
		t.Fatalf("the command answered %v with %v", answered, failure)
	}
	project := status[map[string]any](t, f, "core.project")
	text, err := json.Marshal(answer)
	if err != nil {
		t.Fatal(err)
	}
	var opened struct {
		ID   string `json:"id"`
		Root string `json:"root"`
	}
	if err := json.Unmarshal(text, &opened); err != nil {
		t.Fatal(err)
	}
	if opened.Root != "/work/alpha" || project["id"] != opened.ID || len(stored.projects) != 1 || stored.projects[0]["color"] != "#ffb36b" {
		t.Fatalf("the command answered %s, the shell shows %v and stores %v", text, project, stored.projects)
	}
}

// answerOf runs the command name, which may answer in a later step, and returns the text of its answer.
func (f *shellFixture) answerOf(name string, params any) string {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	var value any
	var failure error
	answered := false
	f.shell.Registry().RunLater(name, raw, func(result any, err error) { value, failure, answered = result, err, true })
	f.settle()
	if !answered || failure != nil {
		f.t.Fatalf("%s answered %v with %v", name, answered, failure)
	}
	text, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(text)
}

// core.project.close answers after the host removed the project, as a client that closes the last window reads it.
func TestProjectCloseCommandAnswersThatItClosed(t *testing.T) {
	f := openedShell(t)
	id := f.host.projects[0]["id"].(string)
	if got := f.answerOf("core.project.close", map[string]string{"id": id}); got != `{"closed":true}` {
		t.Fatalf("the command answered %s", got)
	}
	if len(f.host.projects) != 0 {
		t.Fatalf("the host still stores %v", f.host.projects)
	}
}

func TestProjectCloseCommandAnswersThatTheHostKeptTheProject(t *testing.T) {
	f := openedShell(t)
	f.host.keepsProjects = true
	id := f.host.projects[0]["id"].(string)
	if got := f.answerOf("core.project.close", map[string]string{"id": id}); got != `{"closed":false}` {
		t.Fatalf("the command answered %s", got)
	}
	if len(f.host.projects) != 1 {
		t.Fatalf("the host stores %v", f.host.projects)
	}
}

func TestProjectCloseCommandRefusesAnUnknownProject(t *testing.T) {
	f := openedShell(t)
	if err := f.finish("core.project.close", map[string]string{"id": "project-none"}); err == nil || err.Error() != "Unknown project: project-none" {
		t.Fatalf("the command failed with %v", err)
	}
}

// core.window.new opens a window and answers null when the host opened it.
func TestWindowNewCommandOpensAWindow(t *testing.T) {
	f := newShell(t, &storedHost{})
	var answer any = "no answer"
	var failure error
	f.shell.Registry().RunLater("core.window.new", json.RawMessage(`{}`), func(value any, err error) { answer, failure = value, err })
	f.settle()
	if failure != nil || answer != nil {
		t.Fatalf("the command answered %v with %v", answer, failure)
	}
	if !f.host.called("windowNew") {
		t.Fatalf("the host received %v", f.host.calls)
	}
}

// A folder that holds a settings file shows them when it opens, as after a start of the application.
func TestAnOpenedFolderTakesTheSettingsOfItsFile(t *testing.T) {
	stored := &storedHost{folderSettings: map[string]map[string]any{"/work/alpha": {"mode": "light"}}}
	f := newShell(t, stored)
	if err := f.finish("core.project.open", map[string]string{"root": "/work/alpha"}); err != nil {
		t.Fatal(err)
	}
	var theme struct {
		Scheme string `json:"scheme"`
	}
	if err := json.Unmarshal(stored.theme, &theme); err != nil {
		t.Fatal(err)
	}
	if theme.Scheme != "light" {
		t.Fatalf("the window shows the scheme %s of %s", theme.Scheme, stored.theme)
	}
}

// A folder that the application knows opens as the project that it is.
func TestOpeningAKnownFolderAddsNoProject(t *testing.T) {
	f := newShell(t, &storedHost{})
	for range 2 {
		if err := f.finish("core.project.open", map[string]string{"root": "/work/alpha"}); err != nil {
			t.Fatal(err)
		}
	}
	projects := status[[]map[string]any](t, f, "core.projects")
	if len(projects) != 1 {
		t.Fatalf("the window lists %v", projects)
	}
}

// Coming back to the application keeps the theme: the mode is a setting.
func TestAnActivationKeepsTheTheme(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	before := string(stored.theme)
	f.shell.Event("window-active", nil)
	f.settle()
	if got := string(stored.theme); got != before {
		t.Fatalf("the theme went from %s to %s", before, got)
	}
}

// A project whose settings file the host refused does not open, and the window states the reason (docs/spec/projects.md#settings).
func TestAProjectWithARefusedSettingsFileDoesNotOpen(t *testing.T) {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	project["settingsError"] = "the settings file is refused"
	f := newShell(t, &storedHost{projects: []map[string]any{project}})
	if _, err := f.shell.Registry().Run("core.project.activate", json.RawMessage(`{"id":"`+project["id"].(string)+`"}`)); err != nil {
		t.Fatal(err)
	}
	f.pending.drain(t)
	f.tester.Frame()
	if errors := f.host.written("workbench.record.error"); len(errors) != 1 || !strings.Contains(fmt.Sprint(errors[0]), "the settings file is refused") {
		t.Fatalf("the shell recorded %v", errors)
	}
	if opened := f.host.called("projectOpen"); opened {
		t.Fatal("the window opened the project")
	}
}

// The host answers a folder that it knows with its project, and the window keeps one tab of that project.
func TestProjectOpenCommandShowsAKnownFolderOnce(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	for range 2 {
		if err := f.finish("core.project.open", map[string]string{"root": "/work/alpha"}); err != nil {
			t.Fatal(err)
		}
	}
	if projects := status[[]map[string]any](t, f, "core.projects"); len(projects) != 1 {
		t.Fatalf("the window holds the projects %v", projects)
	}
}

func TestProjectOpenCommandRefusesAnEmptyRoot(t *testing.T) {
	f := newShell(t, &storedHost{})
	if err := f.finish("core.project.open", map[string]string{"root": " "}); err == nil || err.Error() != "Project directory is empty" {
		t.Fatalf("the command failed with %v", err)
	}
}
