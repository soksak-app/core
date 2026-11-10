package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	sok "github.com/soksak-app/core/packages/sok/go/src"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// appWindow is the window of the fixture: the Frontend port with the frame requests of the framework adapter.
type appWindow struct {
	host.Frontend
	mu     sync.Mutex
	frames int
	starts chan struct{}
	// restarts counts the starts of the workbench of the window.
	restarts int
	// address is the address of the window, which names the project that it shows.
	address string
	// shown records each first screen that the workbench of the window shows.
	shown func()
}

// note records name among the calls, as a step of the window that the start of the workbench takes between its host calls.
func (h *storedHost) note(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, name)
}

// FirstScreen records that the workbench of the window shows its first screen.
func (w *appWindow) FirstScreen() {
	if w.shown != nil {
		w.shown()
	}
}

// OpenLayout opens no layout transaction: the fixture window draws no native view element, so no frame of it moves a surface host.
func (w *appWindow) OpenLayout() (uint64, error) { return 0, nil }

// Address returns the address of the window.
func (w *appWindow) Address() string { return w.address }

// SetAddress records the address of the window.
func (w *appWindow) SetAddress(address string) { w.address = address }

// StartWorkbench records a start of the workbench of the window.
func (w *appWindow) StartWorkbench() {
	w.mu.Lock()
	w.restarts++
	w.mu.Unlock()
	w.starts <- struct{}{}
}

func (w *appWindow) ElementTree() ([]ui.ElementNode, error) { return nil, nil }

func (w *appWindow) Visible() bool { return true }

func (w *appWindow) SetBackdrop(string) error { return nil }

func (w *appWindow) ContentSize() (width, height float64) { return 1200, 800 }

func (w *appWindow) Scale() (float64, error) { return 2, nil }

func (w *appWindow) ActElement(uint64, ui.Actions, string) error { return nil }

func (w *appWindow) Invalidate() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.frames++
}

// settle runs the later steps and draws each frame that the workbench asked for with tester, the view of the workbench of the
// window, as the window of the framework does: a command whose run asked for a frame answers after it
// (docs/spec/exposure.md#registration).
func (w *appWindow) settle(t *testing.T, queue steps, tester *ui.Tester) {
	t.Helper()
	drawn := 0
	for range 16 {
		queue.drain(t)
		w.mu.Lock()
		asked := w.frames > drawn
		drawn = w.frames
		w.mu.Unlock()
		if !asked {
			return
		}
		tester.Frame()
	}
	t.Fatal("the workbench asked for a frame after each of 16 frames")
}

// fixtureApp returns an application workbench over the table of stored and the replies that it sends the host.
func fixtureApp(t *testing.T, stored *storedHost) (*workbench.App, *appWindow, steps, *[]map[string]any) {
	t.Helper()
	return reportingApp(t, stored, func(line string) { t.Errorf("the workbench reported %s", line) })
}

// reportingApp is fixtureApp whose lines of the application log go to report.
func reportingApp(t *testing.T, stored *storedHost, report func(line string)) (*workbench.App, *appWindow, steps, *[]map[string]any) {
	t.Helper()
	queue := make(steps, 256)
	replies := &[]map[string]any{}
	table := func(host.Frontend) map[string]workbench.HostCall {
		calls := stored.table()
		calls["exposureReply"] = func(_ context.Context, argument json.RawMessage) (any, error) {
			var reply map[string]any
			if err := json.Unmarshal(argument, &reply); err != nil {
				return nil, err
			}
			queue.post(func() { *replies = append(*replies, reply) })
			return nil, nil
		}
		for name, call := range stored.extra {
			calls[name] = call
		}
		return calls
	}
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: queue.post, Detaching: func(host.Frontend) []string { return stored.detaching }, Element: func(host.Frontend, string) (uintptr, uintptr, bool) { return 0, 0, false }, Table: table, Installed: func() []byte { return []byte(stored.installedDocument()) }, Report: report})
	if err != nil {
		t.Fatal(err)
	}
	return app, &appWindow{starts: make(chan struct{}, 8)}, queue, replies
}

func TestAppStartsWhenTheWindowShows(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	if app.Build(window) == nil {
		t.Fatal("the workbench has no view")
	}
	queue.drain(t)
	if len(stored.calls) != 0 {
		t.Fatalf("the workbench called %v before the host held its window", stored.calls)
	}
	app.Shown(window)
	queue.drain(t)
	if strings.Join(startCalls(stored.calls), " ") != "windowControls workspace workspace workspace windowReady notificationState pluginsState sidecarsOutdated sidecarsRetain" {
		t.Fatalf("the start called %v", stored.calls)
	}
}

// A reload builds a new workbench, which shows the project that the address of the window names before the window is ready.
func TestAStartShowsTheProjectOfTheAddress(t *testing.T) {
	opened := openedShell(t)
	stored := opened.host
	id := stored.projects[0]["id"].(string)
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=" + id
	stored.calls = nil
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	calls := startCalls(stored.calls)
	shown, ready := slices.Index(stored.calls, "projectShown"), slices.Index(stored.calls, "windowReady")
	if shown < 0 || ready < shown {
		t.Fatalf("the start called %v, %v", calls, stored.calls)
	}
	if window.address != "/?project="+id {
		t.Fatalf("the address is %s", window.address)
	}
}

// A reload keeps the last frame of the window until the new workbench shows its first screen: the project of the address with its
// cards, before the window is ready (docs/spec/native-host.md#page-start).
func TestAStartShowsItsFirstScreenOnceTheProjectIsShown(t *testing.T) {
	opened := openedShell(t)
	stored := opened.host
	id := stored.projects[0]["id"].(string)
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=" + id
	window.shown = func() { stored.note("firstScreen") }
	stored.calls = nil
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	shown, first, ready := slices.Index(stored.calls, "projectShown"), slices.Index(stored.calls, "firstScreen"), slices.Index(stored.calls, "windowReady")
	if shown < 0 || first < shown || ready < first || strings.Count(strings.Join(stored.calls, " "), "firstScreen") != 1 {
		t.Fatalf("the start called %v", stored.calls)
	}
}

// The first window of a launch that names no project shows the library as its first screen, before the window is ready.
func TestAStartAtTheLibraryShowsItsFirstScreenBeforeTheWindowIsReady(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	window.shown = func() { stored.note("firstScreen") }
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	snapshot, first, ready := slices.Index(stored.calls, "workspace"), slices.Index(stored.calls, "firstScreen"), slices.Index(stored.calls, "windowReady")
	if snapshot < 0 || first < snapshot || ready < first || strings.Count(strings.Join(stored.calls, " "), "firstScreen") != 1 {
		t.Fatalf("the start called %v", stored.calls)
	}
}

// A start that cannot read the workspace shows that failure as its first screen.
func TestAStartThatFailsShowsItsFailureAsItsFirstScreen(t *testing.T) {
	stored := &storedHost{failing: map[string]error{"workspace": errors.New("no store")}}
	app, window, queue, _ := fixtureApp(t, stored)
	window.shown = func() { stored.note("firstScreen") }
	app.Build(window)
	app.Shown(window)
	queue.until(t, func() bool { return len(stored.written("workbench.record.error")) == 1 })
	queue.drain(t)
	if !slices.Contains(stored.calls, "firstScreen") {
		t.Fatalf("the failed start called %v", stored.calls)
	}
}

// A start that the host refused, as one whose window cannot cancel its open layout, shows that failure as its first screen, calls no
// host and reports no ready window, as a main page whose start document failed (docs/spec/native-host.md#page-start).
func TestAStartThatTheHostRefusedShowsItsFailureAsItsFirstScreen(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	window.shown = func() { stored.note("firstScreen") }
	app.Build(window)
	app.StartFailed(window, errors.New("page reload: the layout of the window is not cancelled"))
	queue.until(t, func() bool { return len(stored.written("workbench.record.error")) == 1 })
	queue.drain(t)
	if !slices.Equal(stored.calls, []string{"firstScreen"}) {
		t.Fatalf("the refused start called %v, want only its first screen", stored.calls)
	}
	if text := fmt.Sprint(stored.written("workbench.record.error")); !strings.Contains(text, "page reload: the layout of the window is not cancelled") {
		t.Fatalf("the refused start wrote %s", text)
	}
}

// A refused projects.json or settings.json does not fail the start: the workbench shows each error and starts without the file
// (docs/spec/projects.md#settings).
func TestAStartWithRefusedStoredFilesShowsTheirErrorsAndStarts(t *testing.T) {
	stored := &storedHost{startFails: true, refusedFiles: map[string]string{
		"projectsError": "/config/projects.json: projects.json: format must be 1",
		"settingsError": "/config/settings.json: settings.json: format must be 1",
	}}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	if !stored.called("windowReady") {
		t.Fatalf("the start with refused stored files did not report the window ready; it called %v", stored.calls)
	}
	var texts []string
	for _, event := range stored.written("workbench.record.error") {
		texts = append(texts, fmt.Sprint(event["fields"]))
	}
	for _, text := range stored.refusedFiles {
		if !slices.ContainsFunc(texts, func(line string) bool { return strings.Contains(line, text) }) {
			t.Fatalf("the start did not show %q; it showed %v", text, texts)
		}
	}
}

// A window that names a project that is gone starts at the library, without an address that names it.
func TestAStartLeavesAnAddressOfAnUnknownProject(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-gone"
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	if window.address != "/" || stored.called("projectOpen") {
		t.Fatalf("the address is %s and the calls %v", window.address, stored.calls)
	}
}

func TestExposureRequestRunsACommandInAStep(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, replies := fixtureApp(t, stored)
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	window.settle(t, queue, tester)
	app.Emit(window, "exposure-request", map[string]any{"id": 7, "method": "command.run",
		"params": map[string]any{"name": "core.library.form.open", "params": map[string]string{"mode": "open"}}})
	window.settle(t, queue, tester)
	if len(*replies) != 1 || (*replies)[0]["id"] != float64(7) || (*replies)[0]["error"] != nil {
		t.Fatalf("the replies are %v", *replies)
	}
}

func TestClosedWindowTakesNoEvent(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Close(window)
	app.Shown(window)
	queue.drain(t)
	if len(stored.calls) != 0 {
		t.Fatalf("a closed window called %v", stored.calls)
	}
}

// A reload ends the workbench of the window while its placement waits in presentSurfaces, and the host cancels that placement with
// the reload and answers it with a failure. The ended workbench states nothing of that answer: core.verify of the window belongs to
// the workbench that the reload builds.
func TestAPlacementAnsweredAfterTheWorkbenchEndedStatesNothing(t *testing.T) {
	stored := &storedHost{installed: installedSessionView, common: map[string]any{"memorySaverDelay": 30},
		projects: []map[string]any{storedProject(tab("tab-bbbbbb", "session"))}}
	viewPlacements(stored)
	presenting, release := make(chan struct{}, 8), make(chan struct{})
	stored.extra["presentSurfaces"] = func(context.Context, json.RawMessage) (any, error) {
		presenting <- struct{}{}
		<-release
		return nil, errors.New("surface preparation 9 is no longer current")
	}
	var mu sync.Mutex
	var changes []string
	stored.extra["exposureChanged"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		changes = append(changes, string(argument))
		return nil, nil
	}
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 1, "method": "status.watch", "params": map[string]any{"name": "core.verify"}})
	queue.drain(t)
	tester.Frame()
	queue.drain(t)
	if len(presenting) != 1 {
		t.Fatalf("%d placements wait in presentSurfaces before the end of the workbench, want 1", len(presenting))
	}
	mu.Lock()
	before := len(changes)
	mu.Unlock()
	app.Close(window)
	close(release)
	queue.drain(t)
	mu.Lock()
	defer mu.Unlock()
	if after := changes[before:]; len(after) != 0 {
		t.Fatalf("the ended workbench sent %v", after)
	}
}

func TestCloseRequestStoresThePlaneAndClosesTheWindow(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "project-close-request")
	queue.drain(t)
	if got := stored.calls[len(stored.calls)-1]; got != "windowClose" {
		t.Fatalf("the close request called %v", stored.calls)
	}
}

// started runs the steps until one start of the workbench of the window, the call StartWorkbench, and takes that start.
func (w *appWindow) started(t *testing.T, queue steps) {
	t.Helper()
	queue.until(t, func() bool { return len(w.starts) > 0 })
	<-w.starts
}

// A change of the installed plugins saves the projects and starts the workbench again, and one start covers the changes before it.
func TestPluginsChangedStartsTheWorkbenchAgain(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "plugins-changed", map[string]any{"action": "install", "plugin": "probe"})
	app.Emit(window, "plugins-changed", map[string]any{"action": "enable", "plugin": "probe"})
	queue.drain(t)
	window.started(t, queue)
	queue.drain(t)
	if len(window.starts) != 0 {
		t.Fatal("two changes started the workbench twice")
	}
}

// A change before the workbench started waits for its start, because the reload saves the projects.
func TestPluginsChangedWaitsForTheStart(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, _ := fixtureApp(t, stored)
	app.Build(window)
	app.Emit(window, "plugins-changed", map[string]any{"action": "install", "plugin": "probe"})
	queue.drain(t)
	if len(window.starts) != 0 || len(stored.calls) != 0 {
		t.Fatalf("the change ran before the start: %v", stored.calls)
	}
	app.Shown(window)
	queue.drain(t)
	window.started(t, queue)
}

// core.plugins.apply starts the workbench again as a change of the plugins does.
func TestPluginsApplyStartsTheWorkbenchAgain(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, replies := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run",
		"params": map[string]any{"name": "core.plugins.apply", "params": map[string]any{}}})
	queue.drain(t)
	window.started(t, queue)
	if len(*replies) != 1 || (*replies)[0]["result"].(map[string]any)["reloaded"] != true {
		t.Fatalf("the replies are %v", *replies)
	}
}

// A plugin change starts the workbench again only after the host took the reply of each request that was running, so the command
// that made the change answers (docs/spec/installation.md#applying-a-change).
func TestAPluginChangeStartsAfterTheReplyOfARunningCommand(t *testing.T) {
	stored := &storedHost{}
	release := make(chan struct{})
	stored.extra = map[string]workbench.HostCall{
		"pluginsRun": func(context.Context, json.RawMessage) (any, error) { <-release; return nil, nil },
	}
	app, window, queue, replies := fixtureApp(t, stored)
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	window.settle(t, queue, tester)
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run",
		"params": map[string]any{"name": "core.plugins.enable", "params": map[string]any{"plugin": "probe"}}})
	window.settle(t, queue, tester)
	app.Emit(window, "plugins-changed", map[string]any{"action": "enable", "plugin": "probe"})
	window.settle(t, queue, tester)
	if len(window.starts) != 0 {
		t.Fatal("the workbench started again before the command that changed the plugins answered")
	}
	close(release)
	window.settle(t, queue, tester)
	window.started(t, queue)
	answered := slices.IndexFunc(*replies, func(reply map[string]any) bool { return reply["id"] == float64(8) })
	if answered < 0 || (*replies)[answered]["error"] != nil {
		t.Fatalf("core.plugins.enable did not answer before the new start: the replies are %v", *replies)
	}
}

// installedSession is the document of the installed plugins with a plugin that keeps a background session.
const installedSession = `{"plugins": [{"id": "session", "package": "@scope/plugin-session", "version": "1.0.0", "manifest": {
	"id": "session", "name": "세션", "description": "session", "mark": "s", "icon": "<path d=\"M1 1h14\"/>", "dependencies": {"@scope/sidecar-session": "^1.0.0"},
	"background": {"sidecar": "@scope/sidecar-session", "operation": "open", "settings": {"shell": "shell"}},
	"settings": {"shell": {"type": "string", "label": "셸", "default": "login", "maxLength": 64}, "other": {"type": "string", "label": "다른 값", "default": "x", "maxLength": 64}},
	"surface": {"opens": {"extensions": ["log"]}, "params": {"type": "object", "properties": {"path": {"type": "string"}}}, "composition": {"kind": "view", "page": "ui/index.html"}}}}]}`

// appStatus reads the status name of the window through its exposure request.
func appStatus(t *testing.T, app *workbench.App, window *appWindow, queue steps, replies *[]map[string]any, name string) map[string]any {
	t.Helper()
	app.Emit(window, "exposure-request", map[string]any{"id": 9, "method": "status.get", "params": map[string]any{"name": name}})
	queue.drain(t)
	reply := (*replies)[len(*replies)-1]
	if reply["error"] != nil {
		t.Fatalf("status %s: %v", name, reply["error"])
	}
	return reply["result"].(map[string]any)
}

// lifecycleInfo is the policy in force that stores the lifecycle class and no other.
func lifecycleInfo() map[string]any {
	classes := map[string]any{}
	for class := range sok.DefaultLogPolicy().Classes() {
		classes[class] = "off"
	}
	classes["lifecycle"] = "info"
	return classes
}

// A surface whose image detach is pending opens no session until the host tells the end of the detach, because its supplier still
// holds the image view of the workbench that the start replaced.
func TestABackgroundSessionWaitsForTheImageDetachOfItsTab(t *testing.T) {
	stored := &storedHost{installed: installedSession, common: map[string]any{"memorySaverDelay": 30},
		projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"), tab("tab-bbbbbb", "session"))}, detaching: []string{"tab-bbbbbb"}}
	sent := make(chan string, 8)
	stored.extra = map[string]workbench.HostCall{
		"sidecarListen": func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			sent <- string(argument)
			return nil, nil
		},
	}
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	if len(sent) != 0 {
		t.Fatalf("the session opened during the detach: %s", <-sent)
	}
	app.Emit(window, "image-detach-ended", map[string]any{"surface": "tab-bbbbbb", "error": nil})
	// The session opens with the host call sidecarSend, which the end of the detach starts.
	queue.until(t, func() bool { return len(sent) > 0 })
	if line := <-sent; !strings.Contains(line, `"operation":"open"`) {
		t.Fatalf("the host received %s", line)
	}
}

// A detach that failed leaves its tab without a session, and the tab shows the failure.
func TestAFailedImageDetachKeepsTheSessionOfItsTabClosed(t *testing.T) {
	stored := &storedHost{installed: installedSession, common: map[string]any{"memorySaverDelay": 30},
		projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"), tab("tab-bbbbbb", "session"))}, detaching: []string{"tab-bbbbbb"}}
	sent := make(chan string, 8)
	stored.extra = map[string]workbench.HostCall{
		"sidecarListen": func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			sent <- string(argument)
			return nil, nil
		},
	}
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "image-detach-ended", map[string]any{"surface": "tab-bbbbbb", "error": "the supplier stopped"})
	queue.drain(t)
	if len(sent) != 0 {
		t.Fatalf("the session opened after a failed detach: %s", <-sent)
	}
}

// viewPlacements answers the placement calls of a view and returns the syncSurfaces requests.
func viewPlacements(stored *storedHost) *[]string {
	placed := &[]string{}
	stored.extra = map[string]workbench.HostCall{
		"sidecarListen":      func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"sidecarSend":        func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"compositionDeclare": func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"presentSurfaces":    func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"syncSurfaces": func(_ context.Context, argument json.RawMessage) (any, error) {
			*placed = append(*placed, string(argument))
			return map[string]any{"ticket": len(*placed), "placements": []any{}, "chrome": map[string]any{}}, nil
		},
	}
	return placed
}

// A shown tab whose image detach is pending is not placed, so the host creates no view for it, and it stands after the end of the detach.
func TestAShownTabStandsAfterTheImageDetachOfItsSurface(t *testing.T) {
	stored := &storedHost{installed: installedSessionView, common: map[string]any{"memorySaverDelay": 30},
		projects: []map[string]any{storedProject(tab("tab-bbbbbb", "session"))}, detaching: []string{"tab-bbbbbb"}}
	placed := viewPlacements(stored)
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	queue.drain(t)
	tester.Frame()
	queue.drain(t)
	if strings.Contains(strings.Join(*placed, ""), "tab-bbbbbb") {
		t.Fatalf("the surface stood during the detach: %v", *placed)
	}
	app.Emit(window, "image-detach-ended", map[string]any{"surface": "tab-bbbbbb", "error": nil})
	queue.drain(t)
	tester.Frame()
	queue.drain(t)
	if !strings.Contains(strings.Join(*placed, ""), "tab-bbbbbb") {
		t.Fatalf("the surface did not stand after the detach: %v", *placed)
	}
}

// A shown tab whose image detach failed shows that failure and stays without a view.
func TestAShownTabShowsTheFailureOfItsImageDetach(t *testing.T) {
	stored := &storedHost{installed: installedSessionView, common: map[string]any{"memorySaverDelay": 30},
		projects: []map[string]any{storedProject(tab("tab-bbbbbb", "session"))}, detaching: []string{"tab-bbbbbb"}}
	placed := viewPlacements(stored)
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "image-detach-ended", map[string]any{"surface": "tab-bbbbbb", "error": "the supplier stopped"})
	queue.drain(t)
	tester.Frame()
	queue.drain(t)
	if !tester.HasText("the supplier stopped") {
		t.Fatalf("the tab shows %q", tester.Texts())
	}
	if strings.Contains(strings.Join(*placed, ""), "tab-bbbbbb") {
		t.Fatalf("the failed surface stood: %v", *placed)
	}
}

// installedSessionView is installedSession with a plugin that stands in a view of its tab.
const installedSessionView = `{"plugins": [{"id": "session", "package": "@scope/plugin-session", "version": "1.0.0", "manifest": {
	"id": "session", "name": "세션", "description": "session", "mark": "s", "icon": "<path d=\"M1 1h14\"/>", "dependencies": {"@scope/sidecar-session": "^1.0.0"},
	"background": {"sidecar": "@scope/sidecar-session", "operation": "open"},
	"surface": {"composition": {"kind": "view", "page": "ui/index.html"}}}}]}`

// A tab whose view stays hidden behind the shown tab of its card owns its session through that view, so a background session would be
// a second owner of the surface.
func TestAHiddenTabWithAViewOpensNoBackgroundSession(t *testing.T) {
	stored := &storedHost{installed: installedSessionView, common: map[string]any{"memorySaverDelay": 30},
		projects: []map[string]any{storedProject(tab("tab-bbbbbb", "session"), tab("tab-aaaaaa", "other"))}}
	sent := make(chan string, 8)
	var placed []string
	stored.extra = map[string]workbench.HostCall{
		"sidecarListen":      func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"compositionDeclare": func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"presentSurfaces":    func(_ context.Context, argument json.RawMessage) (any, error) { return nil, nil },
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			sent <- string(argument)
			return nil, nil
		},
		"syncSurfaces": func(_ context.Context, argument json.RawMessage) (any, error) {
			placed = append(placed, string(argument))
			return map[string]any{"ticket": len(placed), "placements": []any{}, "chrome": map[string]any{}}, nil
		},
	}
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	queue.drain(t)
	tester.Frame()
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run",
		"params": map[string]any{"name": "core.tab.select", "params": map[string]string{"tab": "tab-aaaaaa"}}})
	queue.drain(t)
	tester.Frame()
	queue.drain(t)
	if len(placed) < 2 || !strings.Contains(placed[len(placed)-1], `"id":"tab-bbbbbb"`) || !strings.Contains(placed[len(placed)-1], `"visible":false`) {
		t.Fatalf("the view of the hidden tab is not held: %v", placed)
	}
	if len(sent) != 0 {
		t.Fatalf("the hidden tab opened a second owner of its surface: %s", <-sent)
	}
}

func TestAnInstalledPluginGetsItsBackgroundSessionInTheApplication(t *testing.T) {
	stored := &storedHost{installed: installedSession, common: map[string]any{"memorySaverDelay": 30, "diagnostics.log": lifecycleInfo()}, classes: lifecycleInfo(),
		projects: []map[string]any{storedProject(tab("tab-aaaaaa", "other"), tab("tab-bbbbbb", "session"))}}
	sent := make(chan string, 8)
	stored.extra = map[string]workbench.HostCall{
		"sidecarListen": func(_ context.Context, argument json.RawMessage) (any, error) {
			sent <- "listen " + string(argument)
			return nil, nil
		},
		"sidecarSend": func(_ context.Context, argument json.RawMessage) (any, error) {
			sent <- "send " + string(argument)
			return nil, nil
		},
		"log": func(_ context.Context, argument json.RawMessage) (any, error) {
			var request map[string]any
			if err := json.Unmarshal(argument, &request); err != nil {
				return nil, err
			}
			if request["action"] == "clock" {
				return map[string]any{"ts_us": 1700000000000000, "mono_ns": 7}, nil
			}
			if request["action"] == "batch" && strings.Contains(string(argument), "workbench.background.session") {
				sent <- "log " + string(argument)
			}
			return stored.log(context.Background(), argument)
		},
	}
	app, window, queue, replies := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run",
		"params": map[string]any{"name": "core.project.activate", "params": map[string]string{"id": "prj-a"}}})
	queue.drain(t)
	var listen, send, record string
	for len(sent) > 0 {
		line := <-sent
		switch strings.SplitN(line, " ", 2)[0] {
		case "listen":
			listen = line
		case "send":
			send = line
		case "log":
			record = line
		}
	}
	if !strings.Contains(listen, `"tab-bbbbbb"`) || !strings.Contains(listen, "@scope/sidecar-session") {
		t.Fatalf("listen %q", listen)
	}
	if !strings.Contains(send, `"operation":"open"`) || !strings.Contains(send, `"shell":"login"`) || strings.Contains(send, "other") {
		t.Fatalf("send %q", send)
	}
	for _, part := range []string{`"action":"batch"`, `"event":"workbench.background.session"`, `"ts_us":17000000`, `"mono_ns":`, `"start":"`} {
		if !strings.Contains(record, part) {
			t.Fatalf("log %q has no %s", record, part)
		}
	}
	memory := appStatus(t, app, window, queue, replies, "core.tab.memory")
	if memory["enabled"] != true || memory["delay"] != float64(30) {
		t.Fatalf("core.tab.memory %v", memory)
	}
}

func TestAnInstallationThatCannotBeReadIsShown(t *testing.T) {
	stored := &storedHost{installed: `{"error":"the installation is broken"}`}
	queue := make(steps, 256)
	app, err := workbench.NewApp(workbench.AppOptions{Detaching: func(host.Frontend) []string { return nil }, Environment: environment(t), Post: queue.post,
		Table:     func(host.Frontend) map[string]workbench.HostCall { return stored.table() },
		Report:    func(line string) { t.Fatal(line) },
		Installed: func() []byte { return []byte(stored.installedDocument()) }})
	if err != nil {
		t.Fatal(err)
	}
	window := &appWindow{}
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	queue.until(t, func() bool { return len(stored.written("workbench.record.error")) == 1 })
	if record := fmt.Sprint(stored.written("workbench.record.error")); !strings.Contains(record, "the installation is broken") {
		t.Fatalf("the record is %s", record)
	}
}

func TestACancelledTimerDoesNotRun(t *testing.T) {
	queue := make(steps, 8)
	app, err := workbench.NewApp(workbench.AppOptions{Detaching: func(host.Frontend) []string { return nil }, Environment: environment(t), Post: queue.post, Report: func(string) {},
		Table: func(host.Frontend) map[string]workbench.HostCall { return (&storedHost{}).table() }, Installed: func() []byte { return []byte(`{"plugins":[]}`) }})
	if err != nil {
		t.Fatal(err)
	}
	ran := false
	cancel := app.After(0, func() { ran = true })
	queue.run()
	equal(t, ran, true)
	cancel()
	ran = false
	cancel = app.After(0, func() { ran = true })
	cancel()
	queue.drain(t)
	equal(t, ran, false)
}
