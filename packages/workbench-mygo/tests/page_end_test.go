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

// A flush waits for the events queued before it and not for an event stream that never goes quiet: a closed gate counts an event in
// every step, and the flush still ends after the batch that carries what was queued (docs/spec/logging.md#operation-chains).
// contract: workbench.events.flush-ends-at-its-watermark
func TestAFlushEndsWhileEventsKeepComing(t *testing.T) {
	f := newWriter(t, nil)
	f.events.Info("place: gated")
	flushed := false
	f.events.Flush(func() { flushed = true })
	var tick func()
	tick = func() {
		f.events.Info("place: gated")
		f.queue.post(tick)
	}
	f.queue.post(tick)
	for step := 0; step < 2000 && !flushed; step++ {
		f.queue.run()
	}
	if !flushed {
		t.Fatal("the flush did not end while the gate counted an event in every step")
	}
}

// The close of a window waits for the commands that ran when it was decided and for none that starts later
// (docs/spec/exposure.md#registration).
// contract: workbench.close.waits-for-the-commands-before-it
func TestTheCloseOfAWindowWaitsForNoCommandThatStartsAfterIt(t *testing.T) {
	stored := &storedHost{extra: map[string]workbench.HostCall{"filePlace": neverAnswered(t)}}
	f := newShell(t, stored)
	f.run("core.library.form.open", map[string]string{"mode": "open"})
	f.run("core.library.form.set", map[string]string{"field": "parent", "value": "/work/alpha"})
	f.run("core.library.form.submit", nil)
	// The close saves a new geometry of the window first, and that save waits until the test releases it.
	stored.geometry = map[string]any{"x": 10, "y": 20, "width": 900, "height": 700}
	release := make(chan struct{})
	stored.holdWorkspace = release
	f.shell.Event("project-close-request", nil)
	f.pending.drain(t)
	f.shell.Registry().RunLater("core.file.place", json.RawMessage(`{"name":"a.txt"}`), func(any, error) {})
	close(release)
	f.pending.drain(t)
	if !stored.called("windowClose") {
		t.Fatalf("the close waited for a command that started after it; the calls are %v", stored.calls)
	}
}

// A new start of the workbench for a plugin change waits for the replies of the requests delivered before the apply decided it and
// for none delivered later, which the end of the workbench ends (docs/spec/installation.md#applying-a-change).
// contract: workbench.reload.waits-for-the-requests-before-it
func TestAPluginApplyStartsAgainWithoutARequestDeliveredAfterIt(t *testing.T) {
	stored := &storedHost{extra: map[string]workbench.HostCall{"filePlace": neverAnswered(t)}}
	app, window, queue, replies := fixtureApp(t, stored)
	tester := ui.NewTester(app.Build(window), 1200, 800)
	app.Shown(window)
	window.settle(t, queue, tester)
	// The apply saves the projects through the workspace before its new start, and that save waits until the test releases it.
	release := make(chan struct{})
	stored.holdWorkspace = release
	app.Emit(window, "exposure-request", map[string]any{"id": 8, "method": "command.run",
		"params": map[string]any{"name": "core.plugins.apply", "params": map[string]any{}}})
	queue.drain(t)
	app.Emit(window, "exposure-request", map[string]any{"id": 9, "method": "command.run",
		"params": map[string]any{"name": "core.file.place", "params": map[string]any{"name": "a.txt"}}})
	queue.drain(t)
	close(release)
	queue.drain(t)
	window.started(t, stored)
	if len(*replies) == 0 || (*replies)[0]["id"] != float64(8) {
		t.Fatalf("core.plugins.apply did not answer before the new start: the replies are %v", *replies)
	}
}

// A runtime image detach of a view keeps the seat of its surface, as on the hosts with a main page: the surface stands in every
// placement while the detach runs, so no answer of the detach has a seat to give back (docs/spec/native-surfaces.md#view-surfaces).
// contract: workbench.view.image-detach-keeps-the-seat
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

// lastPlacementHolds tells whether the last syncSurfaces request of the host names the surface id.
func lastPlacementHolds(stored *surfaceHost, id string) bool {
	if len(stored.requests) == 0 {
		return false
	}
	encoded, err := json.Marshal(stored.requests[len(stored.requests)-1]["surfaces"])
	return err == nil && strings.Contains(string(encoded), `"`+id+`"`)
}
