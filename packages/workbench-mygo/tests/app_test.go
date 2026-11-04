package workbench_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// appWindow is the window of the fixture: the Frontend port with the frame requests of the framework adapter.
type appWindow struct {
	host.Frontend
	mu     sync.Mutex
	frames int
}

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
		return calls
	}
	app, err := workbench.NewApp(workbench.AppOptions{Environment: environment(t), Post: queue.post, Table: table, Report: func(line string) {
		t.Errorf("the workbench reported %s", line)
	}})
	if err != nil {
		t.Fatal(err)
	}
	return app, &appWindow{}, queue, replies
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
	if strings.Join(stored.calls, " ") != "workspace windowReady" {
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

func TestExposureRequestAnswersAFailureWithItsCode(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, replies := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run", "params": map[string]any{"name": "core.nothing"}})
	app.Emit(window, "exposure-request", map[string]any{"id": 9, "method": "no.method"})
	queue.drain(t)
	if len(*replies) != 2 {
		t.Fatalf("the replies are %v", *replies)
	}
	if code := (*replies)[0]["error"].(map[string]any)["code"]; code != float64(1001) {
		t.Fatalf("an unknown name answered %v", code)
	}
	if code := (*replies)[1]["error"].(map[string]any)["code"]; code != float64(-32601) {
		t.Fatalf("an unknown method answered %v", code)
	}
}

func TestExposureListIsTheDeclaration(t *testing.T) {
	stored := &storedHost{}
	app, window, queue, replies := fixtureApp(t, stored)
	app.Build(window)
	app.Shown(window)
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 1, "method": "exposure.list"})
	queue.drain(t)
	result := (*replies)[0]["result"].(map[string]any)
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	if len(result["commands"].([]any)) != len(declared.Commands) || len(result["status"].([]any)) != len(declared.Statuses) {
		t.Fatalf("the list holds %d commands and %d statuses", len(result["commands"].([]any)), len(result["status"].([]any)))
	}
	registered := map[string]bool{}
	for _, entry := range result["commands"].([]any) {
		item := entry.(map[string]any)
		registered[item["name"].(string)] = item["registered"].(bool)
	}
	if !registered["core.card.split"] || registered["core.settings.open"] {
		t.Fatalf("registered: split %v, settings %v", registered["core.card.split"], registered["core.settings.open"])
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
