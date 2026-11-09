//go:build e2e

package adapter_test

// Checks the frames of a window of the mygo framework adapter. A frame presents only on a display, so these tests are end-to-end
// checks (docs/operations/examples.md#test-kinds).

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
)

// The window goes on the screen only after its first frame. The check reads whether the window is ordered in, not the event
// WindowShow: that event reports a change of the occlusion of the window, and a window of an application that is not active opens
// behind every window (docs/spec/hosts.md#launch-activation), where windows of other applications may cover all of it and its
// occlusion never changes (docs/spec/native-surfaces.md#image-regions). TestE2EAWindowHearsWhenAnotherCoversIt checks the event.
func TestE2EShowWaitsForTheFirstFrame(t *testing.T) {
	_, workbench, window := support.Open(t, "show")
	window.Show()
	support.Wait(t, "the show", window.Window().IsVisible)
	if !slices.Contains(workbench.Received(), "draw show") {
		t.Fatalf("the window showed before it drew: %v", workbench.Received())
	}
}

// A status read of whether the window is occluded is worth nothing to a watcher that hears of no change, so a window hears when
// some of it shows, when another covers all of it and when some of it shows again. Only a window that the screen shows hears
// these changes, and the check orders no window in front of the windows of other applications (docs/spec/hosts.md#launch-activation).
func TestE2EAWindowHearsWhenAnotherCoversIt(t *testing.T) {
	framework, _, below := support.Open(t, "below")
	above := framework.NewWindow(host.WindowOptions{Name: "above", Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(above.Window().Destroy)
	covered := make(chan struct{}, 8)
	uncovered := make(chan struct{}, 8)
	below.OnWindowEvent(host.WindowHide, func() { covered <- struct{}{} })
	below.OnWindowEvent(host.WindowShow, func() { uncovered <- struct{}{} })
	below.Show()
	support.Wait(t, "the window below", below.Window().IsVisible)
	receiveOnScreen(t, "the show of the window below", uncovered, below)
	above.Show()
	support.Wait(t, "the window above", above.Window().IsVisible)
	x, y := below.Position()
	above.SetSize(600, 500)
	above.SetPosition(x-100, y-100)
	receive(t, "the cover", covered)
	for len(uncovered) > 0 {
		<-uncovered
	}
	above.SetPosition(x+1000, y)
	receive(t, "the uncover", uncovered)
}

// A window that the host shows goes on the screen with the first screen of its workbench, and a check may size and move it before
// that, as e2e/placement.test.mjs does with the project window that covers the window of the check. The frame set while the window
// waited is the frame it goes on the screen with, above the window it covers, so the covered window hears the cover.
func TestE2EAWindowMovedOverAnotherBeforeItsFirstScreenCoversIt(t *testing.T) {
	framework, workbench, below := support.Open(t, "below")
	covered := make(chan struct{}, 8)
	uncovered := make(chan struct{}, 8)
	below.OnWindowEvent(host.WindowHide, func() { covered <- struct{}{} })
	below.OnWindowEvent(host.WindowShow, func() { uncovered <- struct{}{} })
	below.Show()
	support.Wait(t, "the window below", below.Window().IsVisible)
	receiveOnScreen(t, "the show of the window below", uncovered, below)
	workbench.HoldFirstScreen()
	above := framework.NewWindow(host.WindowOptions{Name: "above", Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(above.Window().Destroy)
	above.Show()
	support.Wait(t, "the start of the window above", func() bool { return slices.Contains(workbench.Received(), "shown above") })
	if above.Window().IsVisible() {
		t.Fatal("the window above went on the screen before the first screen of its workbench")
	}
	x, y := below.Position()
	above.SetSize(600, 500)
	above.SetPosition(x-100, y-100)
	mygo.RunOnMain(above.FirstScreen)
	support.Wait(t, "the window above", above.Window().IsVisible)
	if ax, ay := above.Position(); ax != x-100 || ay != y-100 {
		t.Fatalf("the window above went on the screen at %v,%v, not at the position %v,%v set before its first screen", ax, ay, x-100, y-100)
	}
	receive(t, "the cover", covered)
}

// receive waits for a value of events.
func receive(t *testing.T, what string, events <-chan struct{}) {
	t.Helper()
	select {
	case <-events:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s did not arrive within 10 s", what)
	}
}

// receiveOnScreen waits for a value of events that only a window that the screen shows produces. When none arrives, it reads from
// AppKit whether the screen shows some of window, and a window that the screen does not show is stated as the reason: nothing was
// measured, as unlessCovered of @soksak/window-check/frontmost.mjs states for the window checks.
func receiveOnScreen(t *testing.T, what string, events <-chan struct{}, window *adapter.Frontend) {
	t.Helper()
	select {
	case <-events:
		return
	case <-time.After(10 * time.Second):
	}
	system, err := platform.Current()
	if err != nil {
		t.Fatalf("%s did not arrive within 10 s, and the platform cannot be read: %v", what, err)
	}
	var onScreen bool
	mygo.RunOnMain(func() { onScreen, err = system.WindowOnScreen(window.NativeWindow()) })
	switch {
	case err != nil:
		t.Fatalf("%s did not arrive within 10 s, and whether the screen shows the window cannot be read: %v", what, err)
	case !onScreen:
		t.Fatalf("%s did not arrive within 10 s: the window is ordered in and the screen shows none of it, so its occlusion state "+
			"stays not visible, because windows of other applications cover all of it. Nothing was measured: uncover the window, "+
			"without activating the application, and run the check again", what)
	default:
		t.Fatalf("%s did not arrive within 10 s, though the screen shows some of the window", what)
	}
}

// presentation runs the presentation notice as a step of the main thread and returns its result.
func presentation(t *testing.T, window *adapter.Frontend) error {
	t.Helper()
	result := make(chan error, 1)
	var failed error
	mygo.RunOnMain(func() { failed = window.AfterPresentation(func(err error) { result <- err }) })
	if failed != nil {
		return failed
	}
	return <-result
}

func TestE2EThePresentationNoticeCallsBackAfterTheFrame(t *testing.T) {
	_, _, window := support.Open(t, "presentation")
	if err := presentation(t, window); err != nil {
		t.Fatalf("the presentation notice failed: %v", err)
	}
	// A frame of an unchanged scene presents nothing, and the content is on the screen.
	if err := presentation(t, window); err != nil {
		t.Fatalf("the notice of an unchanged scene failed: %v", err)
	}
}

func TestE2EThePresentationNoticeReportsAWindowThatClosed(t *testing.T) {
	_, _, window := support.Open(t, "presentation-closed")
	result := make(chan error, 1)
	var failed error
	mygo.RunOnMain(func() {
		failed = window.AfterPresentation(func(err error) { result <- err })
		window.Window().Destroy()
	})
	if failed != nil {
		t.Fatal(failed)
	}
	if err := <-result; err == nil || !strings.Contains(err.Error(), "did not present") {
		t.Fatalf("the notice of a closed window reported %v", err)
	}
}

// settle runs the settled wait of the platform over the settled presentation of window. Call it on the main thread.
func settle(window *adapter.Frontend, done func(displayed float64, err error)) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	present, err := window.SettledPresentation()
	if err != nil {
		return err
	}
	return system.AfterSettled(window.NativeWindow(), present, done)
}

func TestE2ETheSettledPresentationCallsBackOnTheMainThread(t *testing.T) {
	_, workbench, window := support.Open(t, "settled")
	type settled struct {
		displayed float64
		err       error
	}
	result := make(chan settled, 1)
	var failed error
	mygo.RunOnMain(func() {
		failed = settle(window, func(displayed float64, err error) { result <- settled{displayed, err} })
	})
	if failed != nil {
		t.Fatal(failed)
	}
	if got := <-result; got.err != nil || got.displayed <= 0 {
		t.Fatalf("the settled presentation reported %+v", got)
	}
	if !slices.Contains(workbench.Received(), "draw settled") {
		t.Fatalf("the window settled without a frame of its workbench: %v", workbench.Received())
	}
}

// quiet is the time in which a window that does not hold its frames draws a requested frame.
const quiet = 250 * time.Millisecond

// held opens a window of a framework whose surface layout transactions hold frames.
func held(t *testing.T, name string) (*adapter.Framework, *support.SceneWorkbench, *adapter.Frontend) {
	t.Helper()
	framework, workbench, window := support.Open(t, name)
	if err := framework.ObserveLayout(); err != nil {
		t.Fatal(err)
	}
	if err := presentation(t, window); err != nil {
		t.Fatal(err)
	}
	return framework, workbench, window
}

// begin starts a surface layout transaction of window and returns the commit of it.
func begin(t *testing.T, window *adapter.Frontend, ticket uint64) (commit func()) {
	t.Helper()
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan bool, 1)
	mygo.RunOnMain(func() {
		err = system.BeginLayout(window.NativeWindow(), ticket, func(allowed bool) { ready <- allowed })
	})
	if err != nil {
		t.Fatal(err)
	}
	if !<-ready {
		t.Fatal("the transaction did not start")
	}
	return func() {
		t.Helper()
		var committed bool
		mygo.RunOnMain(func() { committed = system.CommitLayout(window.NativeWindow(), ticket) })
		if !committed {
			t.Fatal("the transaction did not commit")
		}
	}
}

func TestE2EARecordingHoldsTheRequestAndThePresentationOfTheFrameOfATransaction(t *testing.T) {
	_, _, window := held(t, "recording")
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	capture, ok := system.(platform.Capturer)
	if !ok {
		t.Fatal("the platform has no capture")
	}
	mygo.RunOnMain(capture.LayoutTraceStart)
	commit := begin(t, window, 9)
	if err := presentation(t, window); err != nil {
		t.Fatal(err)
	}
	commit()
	// A notice outside a transaction belongs to no transaction, so it adds no record.
	if err := presentation(t, window); err != nil {
		t.Fatal(err)
	}
	var records [][5]float64
	mygo.RunOnMain(func() { records, err = capture.LayoutTraceStop() })
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("the recording holds %d transactions, want one: %v", len(records), records)
	}
	record := records[0]
	ticket, begun, presented, committed, requested := record[0], record[1], record[2], record[3], record[4]
	if ticket != 9 {
		t.Fatalf("the record has the ticket %v, want 9", ticket)
	}
	if !(begun <= requested && requested <= presented && presented <= committed) {
		t.Fatalf("begun %v, requested %v, presented %v, committed %v are not in this order", begun, requested, presented, committed)
	}
}

// draws returns how many frames the workbench drew in window.
func draws(workbench *support.SceneWorkbench, name string) int {
	count := 0
	for _, record := range workbench.Received() {
		if record == "draw "+name {
			count++
		}
	}
	return count
}

// drawsNothing fails when the window draws within quiet.
func drawsNothing(t *testing.T, workbench *support.SceneWorkbench, name string) {
	t.Helper()
	before := draws(workbench, name)
	time.Sleep(quiet)
	if after := draws(workbench, name); after != before {
		t.Fatalf("window %s drew %d frames while it holds its frames", name, after-before)
	}
}

func TestE2ETheNoticeHoldsTheFramesOfTheWindowUntilTheTransactionEnds(t *testing.T) {
	_, workbench, window := held(t, "hold")
	commit := begin(t, window, 1)
	result := make(chan error, 1)
	var failed error
	// The request in the callback runs in the step of the notice, after its hold.
	mygo.RunOnMain(func() {
		failed = window.AfterPresentation(func(err error) {
			result <- err
			window.Window().Invalidate()
		})
	})
	if failed != nil {
		t.Fatal(failed)
	}
	if err := <-result; err != nil {
		t.Fatalf("the notice failed: %v", err)
	}
	drawsNothing(t, workbench, "hold")
	before := draws(workbench, "hold")
	window.Window().Invalidate()
	drawsNothing(t, workbench, "hold")
	commit()
	support.Wait(t, "the frame after the transaction", func() bool { return draws(workbench, "hold") > before })
	time.Sleep(quiet)
	if count := draws(workbench, "hold") - before; count != 1 {
		t.Fatalf("the window drew %d frames after the transaction, want one", count)
	}
}

func TestE2EAResizeAndAZoomInATransactionDrawOneFrameAtTheEnd(t *testing.T) {
	_, workbench, window := held(t, "resize")
	commit := begin(t, window, 1)
	if err := presentation(t, window); err != nil {
		t.Fatal(err)
	}
	before := draws(workbench, "resize")
	window.Window().SetSize(520, 410)
	drawsNothing(t, workbench, "resize")
	window.Window().Maximize()
	drawsNothing(t, workbench, "resize")
	commit()
	support.Wait(t, "the frame after the transaction", func() bool { return draws(workbench, "resize") > before })
	time.Sleep(quiet)
	if count := draws(workbench, "resize") - before; count != 1 {
		t.Fatalf("the window drew %d frames after the transaction, want one", count)
	}
}

func TestE2EATransactionHoldsTheOtherWindowsAndTheWindowsOpenedMeanwhile(t *testing.T) {
	framework, workbench, first := held(t, "first")
	second := framework.NewWindow(host.WindowOptions{Name: "second", Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(second.Window().Destroy)
	if err := presentation(t, second); err != nil {
		t.Fatal(err)
	}
	before := draws(workbench, "second")
	commit := begin(t, first, 1)
	second.Window().Invalidate()
	third := framework.NewWindow(host.WindowOptions{Name: "third", Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(third.Window().Destroy)
	drawsNothing(t, workbench, "second")
	if count := draws(workbench, "third"); count != 0 {
		t.Fatalf("the window opened meanwhile drew %d frames", count)
	}
	commit()
	support.Wait(t, "the frame of the other window", func() bool { return draws(workbench, "second") > before })
	support.Wait(t, "the first frame of the window opened meanwhile", func() bool { return draws(workbench, "third") > 0 })
}

func TestE2EANewerPreparationReleasesTheHoldOfItsWindow(t *testing.T) {
	_, _, window := held(t, "newer")
	begin(t, window, 1)
	if err := presentation(t, window); err != nil {
		t.Fatal(err)
	}
	commit := begin(t, window, 2)
	if err := presentation(t, window); err != nil {
		t.Fatalf("the notice of the newer preparation failed: %v", err)
	}
	commit()
}

// A frame that draws other surface lines opens the layout of its window while it builds and presents in it, and the preparation of
// those lines takes the transaction over (docs/spec/hosts.md#native-views). That frame drew the lines that the preparation places, so
// it is the frame of the transaction, which the notice of the preparation hears: the window changes again before the preparation asks
// for its frame, as a resize does, and a second frame would wait for the commit that the preparation makes after its notice, which
// would hold the preparation until the host gives up. The frame of the change presents after the commit.
func TestE2EAPreparationThatTakesOverTheLayoutOfAFrameHearsItsFrame(t *testing.T) {
	_, workbench, window := held(t, "taken")
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan error, 1)
	workbench.InNextDraw(func() { opened <- system.BeginLayout(window.NativeWindow(), 1, func(bool) {}) })
	window.Window().SetSize(520, 410)
	select {
	case err := <-opened:
		if err != nil {
			t.Fatalf("the frame did not open the layout of its window: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the resized window drew no frame within 10 s")
	}
	commit := begin(t, window, 2)
	window.Window().SetSize(560, 430)
	result := make(chan error, 1)
	var failed error
	mygo.RunOnMain(func() { failed = window.AfterPresentation(func(err error) { result <- err }) })
	if failed != nil {
		t.Fatal(failed)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("the notice of the preparation that took the layout over failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the notice of the preparation that took the layout over did not come within 2 s: it waits for the commit")
	}
	commit()
	if err := presentation(t, window); err != nil {
		t.Fatalf("the frame after the commit did not present: %v", err)
	}
}

func TestE2ETheSettledPresentationWaitsForTheTransactionOfAnotherWindow(t *testing.T) {
	framework, workbench, first := held(t, "owner")
	other := framework.NewWindow(host.WindowOptions{Name: "other", Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(other.Window().Destroy)
	if err := presentation(t, other); err != nil {
		t.Fatal(err)
	}
	commit := begin(t, first, 1)
	result := make(chan error, 1)
	var failed error
	mygo.RunOnMain(func() {
		failed = settle(other, func(_ float64, err error) { result <- err })
		other.Window().Invalidate()
	})
	if failed != nil {
		t.Fatal(failed)
	}
	before := draws(workbench, "other")
	select {
	case err := <-result:
		t.Fatalf("the settled presentation answered %v during the transaction of the other window", err)
	case <-time.After(quiet):
	}
	commit()
	if err := <-result; err != nil {
		t.Fatalf("the settled presentation failed: %v", err)
	}
	if draws(workbench, "other") == before {
		t.Fatal("the settled presentation answered before the window drew")
	}
}
