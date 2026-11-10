// The close of a window and a new start of its workbench end the workbench, and that end answers what the workbench still runs, so
// neither waits for a command, a request or an event that starts after it was decided (docs/spec/hosts.md#process-lifecycle).
package workbench_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

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
// every step, and the flush still ends after the batch that carries what was queued (docs/spec/logging.md#operation-chains). The
// replies of the host arrive from other goroutines between the steps, so the test runs steps until the flush ends or the time of
// the test passes, not a count of steps that the steps of the gate could fill before any reply arrived.
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
	limit := time.Now().Add(5 * time.Second)
	for !flushed && time.Now().Before(limit) {
		f.queue.run()
	}
	if !flushed {
		t.Fatal("the flush did not end while the gate counted an event in every step")
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
	release := make(chan struct{})
	stored.holdWorkspace = release
	app.Emit(window, "project-close-request")
	queue.drain(t)
	if stored.called("windowClose") {
		t.Fatal("the close did not wait for the save of the geometry")
	}
	app.Emit(window, "exposure-request", map[string]any{"id": 9, "method": "command.run",
		"params": map[string]any{"name": "core.file.place", "params": map[string]any{"name": "a.txt"}}})
	queue.drain(t)
	close(release)
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
