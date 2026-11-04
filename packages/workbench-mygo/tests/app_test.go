package workbench_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// appWindow is the window of the fixture: the Frontend port with the frame requests of the framework adapter.
type appWindow struct {
	host.Frontend
	mu     sync.Mutex
	frames int
	starts chan struct{}
}

// StartWorkbench records a start of the workbench of the window.
func (w *appWindow) StartWorkbench() { w.starts <- struct{}{} }

func (w *appWindow) ElementTree() ([]ui.ElementNode, error) { return nil, nil }

func (w *appWindow) ActElement(uint64, ui.Actions, string) error { return nil }

func (w *appWindow) Invalidate() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.frames++
}

// fixtureApp returns an application workbench over the table of stored and the replies that it sends the host.
func fixtureApp(t *testing.T, stored *storedHost) (*workbench.App, *appWindow, steps, *[]map[string]any) {
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
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: queue.post, Table: table, Installed: func() []byte { return []byte(stored.installedDocument()) }, Report: func(line string) {
		t.Errorf("the workbench reported %s", line)
	}})
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
	if strings.Join(startCalls(stored.calls), " ") != "workspace workspace windowReady notificationState pluginsState sidecarsOutdated" {
		t.Fatalf("the start called %v", stored.calls)
	}
}

func TestExposureRequestRunsACommandInAStep(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, replies := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 7, "method": "command.run",
		"params": map[string]any{"name": "core.library.form.open", "params": map[string]string{"mode": "open"}}})
	queue.drain(t)
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

// started waits for one start of the workbench of the window.
func (w *appWindow) started(t *testing.T, stored *storedHost) {
	t.Helper()
	select {
	case <-w.starts:
	case <-time.After(10 * time.Second):
		t.Fatalf("the workbench did not start again; the calls are %v", stored.calls)
	}
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
	window.started(t, stored)
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
	window.started(t, stored)
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
	window.started(t, stored)
	if len(*replies) != 1 || (*replies)[0]["result"].(map[string]any)["reloaded"] != true {
		t.Fatalf("the replies are %v", *replies)
	}
}

// installedSession is the document of the installed plugins with a plugin that keeps a background session.
const installedSession = `{"plugins": [{"id": "session", "package": "@soksak/plugin-session", "version": "1.0.0", "manifest": {
	"background": {"sidecar": "@soksak/sidecar-session", "operation": "open", "settings": {"shell": "shell"}},
	"settings": {"shell": {"type": "text", "default": "login"}, "other": {"type": "text", "default": "x"}},
	"surface": {"opens": {"extensions": ["log"]}}}}]}`

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

func TestAnInstalledPluginGetsItsBackgroundSessionInTheApplication(t *testing.T) {
	stored := &storedHost{installed: installedSession, common: map[string]any{"memorySaverDelay": 30},
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
	if !strings.Contains(listen, `"tab-bbbbbb"`) || !strings.Contains(listen, "@soksak/sidecar-session") {
		t.Fatalf("listen %q", listen)
	}
	if !strings.Contains(send, `"operation":"open"`) || !strings.Contains(send, `"shell":"login"`) || strings.Contains(send, "other") {
		t.Fatalf("send %q", send)
	}
	for _, part := range []string{`"action":"batch"`, `"event":"workbench.background.session"`, `"ts_us":1700000000000000`, `"mono_ns":7`, `"start":"`} {
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
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: queue.post,
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
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: queue.post, Report: func(string) {},
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
