// The close of a window and a new start of its workbench end the workbench, and that end answers what the workbench still runs, so
// neither waits for a command, a request or an event that starts after it was decided (docs/spec/hosts.md#process-lifecycle).
package workbench_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// neverAnswered is a host call that answers only when the test ends.
func neverAnswered(t *testing.T) workbench.HostCall {
	never := make(chan struct{})
	t.Cleanup(func() { close(never) })
	return func(context.Context, json.RawMessage) (any, error) {
		<-never
		return nil, nil
	}
}

// A flush waits for the events queued before it and not for an event stream that never goes quiet: the closed gate counts an event
// after every step, and each step is the reply of a host call, so the counts are due at the end of every batch, and the flush still
// ends after the batch that carries what was queued (docs/spec/logging.md#operation-chains).
func TestAFlushEndsWhileEventsKeepComing(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Info("place: gated")
	flushed := false
	f.events.Flush(func() { flushed = true })
	for !flushed {
		f.queue.run()
		f.events.Info("place: gated")
	}
}

// Each command that opens a folder answers its caller once, and the window that shows the folder closes without a second answer
// of any command (docs/spec/exposure.md#registration).
func TestEachCommandOfAnOpenedFolderAnswersOnce(t *testing.T) {
	stored := &storedHost{common: map[string]any{"projectOpening": "windows"}}
	f := newShell(t, stored)
	answers := map[string]int{}
	run := func(name string, params any) {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		f.shell.Registry().RunLater(name, raw, func(any, error) { answers[name]++ })
		f.settle()
	}
	run("core.project.open", map[string]string{"root": "/work/alpha"})
	stored.geometry = map[string]any{"x": 10, "y": 20, "width": 900, "height": 700}
	f.shell.Event("project-close-request", nil)
	f.settle()
	if answers["core.project.open"] != 1 {
		t.Fatalf("the commands answered %v times", answers)
	}
	if shown := shownError(t, f); strings.Contains(shown, "answered a second time") {
		t.Fatalf("a command answered twice: %s", shown)
	}
}

// The close of a window waits for the commands that ran when it was decided and for none that starts later
// (docs/spec/exposure.md#registration). The window shows its project from its start, so no command ran before the close, and the
// close saves a new geometry of the window first, which waits until the test releases it.
func TestTheCloseOfAWindowWaitsForNoCommandThatStartsAfterIt(t *testing.T) {
	stored := &storedHost{projects: []map[string]any{storedProject(tab("tab-aaaaaa", "notes"))},
		extra: map[string]workbench.HostCall{"filePlace": neverAnswered(t)}}
	app, window, queue, _ := fixtureApp(t, stored)
	window.address = "/?project=prj-a"
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	window.settle(t, queue, tester)
	stored.geometry = map[string]any{"x": 10, "y": 20, "width": 900, "height": 700}
	release := newGate()
	stored.holdWorkspace = release
	app.Emit(window, "project-close-request")
	queue.drain(t)
	if stored.called("windowClose") {
		t.Fatal("the close did not wait for the save of the geometry")
	}
	app.Emit(window, "exposure-request", map[string]any{"id": 9, "method": "command.run",
		"params": map[string]any{"name": "core.file.place", "params": map[string]any{"name": "a.txt"}}})
	queue.drain(t)
	release.open()
	queue.drain(t)
	if !stored.called("windowClose") {
		t.Fatalf("the close waited for a command that started after it; the calls are %v", stored.calls)
	}
}

// A new start of the workbench for a plugin change waits for the replies of the requests delivered before the apply decided it and
// for none delivered later, which the end of the workbench ends (docs/spec/installation.md#applying-a-change).
func TestAPluginApplyStartsAgainWithoutARequestDeliveredAfterIt(t *testing.T) {
	stored := &storedHost{extra: map[string]workbench.HostCall{"filePlace": neverAnswered(t)}}
	app, window, queue, replies := fixtureApp(t, stored)
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	window.settle(t, queue, tester)
	// The apply saves the projects through the workspace before its new start, and that save waits until the test releases it.
	release := newGate()
	stored.holdWorkspace = release
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run",
		"params": map[string]any{"name": "core.plugins.apply", "params": map[string]any{}}})
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 9, "method": "command.run",
		"params": map[string]any{"name": "core.file.place", "params": map[string]any{"name": "a.txt"}}})
	queue.drain(t)
	release.open()
	queue.drain(t)
	window.started(t, queue)
	if len(*replies) == 0 || (*replies)[0]["id"] != float64(8) {
		t.Fatalf("core.plugins.apply did not answer before the new start: the replies are %v", *replies)
	}
}

// A runtime image detach of a view keeps the seat of its surface, as on the hosts with a main page: the surface stands in every
// placement while the detach runs, so no answer of the detach has a seat to give back (docs/spec/native-surfaces.md#view-surfaces).
func TestARuntimeImageDetachKeepsTheSeatOfItsSurface(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	stored.calls = map[string]workbench.HostCall{"imageDetach": neverAnswered(t)}
	f := newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	f.settle()
	if !lastPlacementHolds(stored, "tab-aaaaaa") {
		t.Fatalf("the shown tab does not stand before the detach: %v", stored.requests)
	}
	f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": 7, "command": "image.detach",
		"params": map[string]any{"name": "picture"}})
	f.settle()
	f.command("core.tab.select", map[string]string{"tab": "tab-bbbbbb"})
	f.command("core.tab.select", map[string]string{"tab": "tab-aaaaaa"})
	f.settle()
	if !lastPlacementHolds(stored, "tab-aaaaaa") {
		t.Fatalf("the surface lost its seat while its image detach runs: %v", stored.requests[len(stored.requests)-1])
	}
}

// lastPlacementHolds tells whether the last syncSurfaces request of the host stands the surface id visible. A held surface that its
// seat does not draw stays in the request without being visible.
func lastPlacementHolds(stored *surfaceHost, id string) bool {
	if len(stored.requests) == 0 {
		return false
	}
	surfaces, _ := stored.requests[len(stored.requests)-1]["surfaces"].([]any) // silent: a request without surfaces holds none.
	for _, surface := range surfaces {
		if fields, _ := surface.(map[string]any); fields["id"] == id && fields["visible"] == true {
			return true
		}
	}
	return false
}
