//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// testLimit ends the process with the stacks of every goroutine and the name of the test when the test runs longer than limit, so a step
// of the main thread that never returns fails its test with the state of the process instead of holding the package. The returned function
// ends the limit.
func testLimit(t *testing.T, limit time.Duration) func() {
	timer := time.AfterFunc(limit, func() {
		buffer := make([]byte, 1<<20)
		buffer = buffer[:runtime.Stack(buffer, true)]
		panic(fmt.Sprintf("%s ran longer than %v; the goroutines are:\n%s", t.Name(), limit, buffer))
	})
	return func() { timer.Stop() }
}

// realTrace returns the recording device of the real platform.
func realTrace(t *testing.T) platformCapture {
	t.Helper()
	capturer, ok := system.(platform.Capturer)
	if !ok {
		t.Fatal("the platform records no windows")
	}
	return platformCapture{Capturer: capturer}
}

// tracedPresent starts the layout trace of the real platform, prepares a layout of a real window and starts its present. stop ends the
// trace and returns the transaction of the ticket.
func tracedPresent(t *testing.T) (notice func(error), ticket uint64, finished chan error, stop func() map[string]any) {
	t.Helper()
	s, window, _ := realLayoutSurfaces(t)
	trace := realTrace(t)
	run := &layoutTraceRun{}
	if err := startLayoutTrace(trace, run); err != nil {
		t.Fatal(err)
	}
	notice, ticket, finished = presentPrepared(t, s, window)
	return notice, ticket, finished, func() map[string]any {
		layouts, err := stopLayoutTrace(trace, run)
		if err != nil {
			t.Fatal(err)
		}
		for _, layout := range layouts {
			if layout["ticket"] == ticket {
				return layout
			}
		}
		t.Fatalf("the layout trace holds no transaction of the ticket %d: %v", ticket, layouts)
		return nil
	}
}

// The layout transaction commits only after the presentation notice of the Frontend calls back: in the layout trace of the native layer,
// the commit of the transaction is not earlier than its presentation.
// contract: surface-layout.commits-after-the-presentation-notice
func TestLayoutCommitsAfterThePresentationNoticeOfTheFrontend(t *testing.T) {
	defer testLimit(t, 30*time.Second)()
	notice, ticket, finished, stop := tracedPresent(t)
	// The notice is called at an instant of the clock of the layout trace, which the native layer reads.
	var noticed float64
	runOnMainThread(func() { noticed = system.(platform.Capturer).CaptureClock() })
	notice(nil)
	if err := <-finished; err != nil {
		t.Fatalf("the present failed: %v", err)
	}
	layout := stop()
	committed := layout["committed"]
	if committed == nil || layout["commitPath"] != "present" {
		t.Fatalf("the transaction %d was committed %v by %v, want a commit by the present", ticket, committed, layout["commitPath"])
	}
	if committed.(float64) < noticed {
		t.Fatalf("the layout committed at %v, before the presentation notice at %v", committed, noticed)
	}
}

// A presentation notice that fails cancels the layout transaction and ends the present with its error.
// contract: surface-layout.commits-after-the-presentation-notice
func TestAFailedPresentationNoticeCancelsTheLayout(t *testing.T) {
	defer testLimit(t, 30*time.Second)()
	notice, ticket, finished, stop := tracedPresent(t)
	notice(errors.New("the window holds its frames"))
	if err := <-finished; err == nil || !strings.Contains(err.Error(), "the window holds its frames") {
		t.Fatalf("the present ended with %v, want the error of the notice", err)
	}
	layout := stop()
	if layout["commitPath"] != "cancel" {
		t.Fatalf("a failed notice ended the ticket %d by %v, want a cancel: %v", ticket, layout["commitPath"], layout)
	}
}

// The native content and the page of one layout reach the screen in one transaction: the preparation begins the layout of its
// ticket and sets the frame of each surface in it, the page draws that layout, and the presentation of the ticket commits it only
// after the presentation notice of the page called back, with the frame of the preparation unchanged
// (docs/spec/native-surfaces.md#acceptance-criteria). The surface is the real surface of a real view.
// contract: surface-layout.commits-the-prepared-geometry-with-its-ticket
func TestTheGeometryOfAPreparationIsCommittedWithItsTicketAfterThePresentationNotice(t *testing.T) {
	defer testLimit(t, 30*time.Second)()
	p := realViewProbe(t, Theme{}, nullOriginStart())
	framework = nestedMainFramework{}
	window := &openFrontend{noticeFrontend: noticeFrontend{notices: make(chan func(error), 1)}, native: p.window}
	p.s.window = window
	p.s.first.Do(func() {})
	p.s.surfacePlugins = map[string]string{"probe-surface": "probe"}
	composition := SurfaceComposition{Kind: "view", Page: "ui/page.html"}
	p.s.compositions = map[string]SurfaceComposition{"probe-surface": composition}
	trace := realTrace(t)
	// The commit of a transaction with a joined view happens when the view presented, after the present returned: the end of the
	// transaction of the window is the event that the native layer reports.
	ended := make(chan struct{}, 8)
	var watched error
	runOnMainThread(func() {
		watched = system.WatchLayoutEnds(func(window platform.Window) {
			if window == p.window {
				ended <- struct{}{}
			}
		})
	})
	if watched != nil {
		t.Fatalf("watch the ends of the layouts: %v", watched)
	}
	run := &layoutTraceRun{}
	if err := startLayoutTrace(trace, run); err != nil {
		t.Fatal(err)
	}
	slot := Rect{X: 10, Y: 20, W: 300, H: 200}
	prepared, err := p.s.SyncSurfaces(SyncRequest{Titlebar: 40, Settled: true, Surfaces: []Surface{
		{ID: "probe-surface", Visible: true, Plugin: "probe", Rect: slot, Composition: composition,
			Start: &ViewStart{Origin: json.RawMessage(`{"directory":null}`), Diagnostics: json.RawMessage(`null`), Section: json.RawMessage(`null`)}},
	}})
	if err != nil {
		t.Fatalf("the preparation failed: %v", err)
	}
	if len(prepared.Placements) != 1 || prepared.Placements[0].Rect != slot {
		t.Fatalf("the preparation answers the placements %v, want the slot %v", prepared.Placements, slot)
	}
	finished := make(chan []Placement, 1)
	failed := make(chan error, 1)
	go func() {
		placed, err := p.s.PresentSurfaces(PresentRequest{Ticket: prepared.Ticket, Placements: prepared.Placements, Settled: true})
		if err != nil {
			failed <- err
			return
		}
		finished <- placed
	}()
	var notice func(error)
	select {
	case notice = <-window.notices:
	case err := <-failed:
		t.Fatalf("the presentation ended before it asked for the presentation notice: %v", err)
	}
	var noticed float64
	runOnMainThread(func() { noticed = system.(platform.Capturer).CaptureClock() })
	notice(nil)
	var placed []Placement
	select {
	case placed = <-finished:
	case err := <-failed:
		t.Fatalf("the presentation failed: %v", err)
	}
	<-ended
	layouts, err := stopLayoutTrace(trace, run)
	if err != nil {
		t.Fatal(err)
	}
	var layout map[string]any
	for _, candidate := range layouts {
		if candidate["ticket"] == prepared.Ticket {
			layout = candidate
		}
	}
	if layout == nil || layout["begun"] == nil || layout["committed"] == nil || layout["commitPath"] != "view-join" ||
		layout["committed"].(float64) < noticed || layout["begun"].(float64) > noticed {
		t.Fatalf("the transaction of the ticket %d is %v, want its begin, the presentation notice at %v and then its commit", prepared.Ticket, layout, noticed)
	}
	if len(placed) != 1 || placed[0].Rect != slot {
		t.Fatalf("the presentation answers the frames %v read at its commit, want the prepared slot %v", placed, slot)
	}
	var frame struct{ X, Y, W, H float64 }
	runOnMainThread(func() {
		got := system.SurfaceFrame(p.surface)
		frame.X, frame.Y, frame.W, frame.H = got.X, got.Y, got.W, got.H
	})
	if frame.X != slot.X || frame.Y != slot.Y || frame.W != slot.W || frame.H != slot.H {
		t.Fatalf("the surface holds the frame %+v after the commit, want the frame of the preparation %v", frame, slot)
	}
}
