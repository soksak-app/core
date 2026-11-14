//go:build diagnostics

package host

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// newWindowCapture returns the recording device of the real platform, whose steps run on the main thread, and a function that creates a
// real window with its main page that is not on screen.
func newWindowCapture(t *testing.T) (platformCapture, func() platform.Window) {
	t.Helper()
	useCurrentPlatformForViews(t)
	capturer, ok := system.(platform.Capturer)
	if !ok {
		t.Fatal("the platform records no windows")
	}
	savedFramework := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = savedFramework })
	capture := platformCapture{Capturer: capturer}
	// A hold that a test leaves set would hold the show of a window of a later test.
	t.Cleanup(func() { runOnMainThread(capture.ReleaseNewWindow) })
	return capture, func() platform.Window {
		return support.TitledWindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	}
}

// contract: diagnostics.capture-start.new-window-is-strict-boolean
func TestCaptureStartNewWindowIsAStrictBooleanWithoutDisplay(t *testing.T) {
	got, err := parseCaptureStartOptions(json.RawMessage(`{"gap":8,"frames":10,"newWindow":true}`))
	if err != nil || !got.NewWindow {
		t.Fatalf("newWindow true = %+v, %v", got, err)
	}
	got, err = parseCaptureStartOptions(json.RawMessage(`{"gap":8,"frames":10}`))
	if err != nil || got.NewWindow {
		t.Fatalf("absent newWindow = %+v, %v", got, err)
	}
	for _, value := range []string{`null`, `"true"`, `1`} {
		_, err := parseCaptureStartOptions(json.RawMessage(`{"gap":8,"frames":10,"newWindow":` + value + `}`))
		if messageOf(err) != "newWindow must be a boolean" {
			t.Errorf("newWindow %s: error %v, want newWindow must be a boolean", value, err)
		}
	}
	_, err = parseCaptureStartOptions(json.RawMessage(`{"gap":8,"frames":10,"newWindow":true,"display":true}`))
	if messageOf(err) != "newWindow records the new window alone and cannot be combined with display" {
		t.Errorf("newWindow with display: error %v", err)
	}
}

// contract: diagnostics.capture-start.new-window-answers-once-held
// The hold is refused by the native library while another hold is set.
func TestAFailedHoldStartsNoRecording(t *testing.T) {
	capture, _ := newWindowCapture(t)
	if err := capture.HoldNewWindow(); err != nil {
		t.Fatal(err)
	}
	var recording Recording
	err := recording.StartNewWindow(capture, filepath.Join(t.TempDir(), "frames"), testPlan)
	if err == nil || !strings.Contains(err.Error(), "held") {
		t.Fatalf("start error %v, want the refusal of a second hold", err)
	}
	if recording.Running() != "" {
		t.Fatalf("a failed hold owns %q", recording.Running())
	}
}

// contract: diagnostics.capture-start.new-window-hold-ends
func TestTheStopEndsAHoldThatNoShowTook(t *testing.T) {
	capture, _ := newWindowCapture(t)
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.StartNewWindow(capture, directory, testPlan); err != nil {
		t.Fatal(err)
	}
	finished, _, _, err := recording.Finish(capture)
	if finished != directory || err == nil || err.Error() != "no new window was shown before the stop of the recording" {
		t.Fatalf("finish = %q, %v", finished, err)
	}
	if recording.Running() != "" {
		t.Fatalf("the ended hold still owns %q", recording.Running())
	}
}

// The wait for a held window runs on the native library with a real hold: no window is shown, so the wait ends only by its end.
// An end that comes after the wait registered ends it, also before it waits in the native library.
// contract: diagnostics.capture-start.new-window-hold-ends
func TestTheConnectionAndTheWindowOfTheRequestEndTheWaitForAHeldWindow(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	system, ok := current.(platform.Capturer)
	if !ok {
		t.Fatal("the platform records no windows")
	}
	previous := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = previous })
	for _, end := range []string{waitEndConnection, waitEndWindow} {
		t.Run(end, func(t *testing.T) {
			s := &Surfaces{name: "new-window-" + end}
			conn := endpointConnection(t)
			capture := platformCapture{Capturer: system, window: s, connection: conn}
			if err := capture.HoldNewWindow(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { runOnMainThread(capture.ReleaseNewWindow) })
			registered := make(chan struct{})
			result := make(chan error, 1)
			go func() {
				// The wait calls registerEnd after it registered with the window and the connection, and before it waits in the
				// native library.
				_, err := capture.WaitNewWindow(func(func(string)) { close(registered) })
				result <- err
			}()
			<-registered
			if end == waitEndConnection {
				conn.close("the requester closed")
			} else {
				endNativeWaits(s, waitEndWindow)
			}
			if err := <-result; err == nil || err.Error() != "no new window was shown before "+end {
				t.Fatalf("the wait ended with %v, want its end by %s", err, end)
			}
		})
	}
}

// contract: diagnostics.capture-start.new-window-answers-once-held
func TestTheHoldOfANewWindowRunsInAStepOfTheMainThread(t *testing.T) {
	// The native hold sets AppKit state and asserts the main thread, and this test calls it from a goroutine that is not the main
	// thread, so the hold of the native library holds only when the call runs in a step of the main thread.
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	capturer, ok := current.(platform.Capturer)
	if !ok {
		t.Fatal("the platform records no windows")
	}
	steps := &atomic.Int64{}
	previous := framework
	framework = countedStepFramework{steps: steps}
	t.Cleanup(func() { framework = previous })
	capture := platformCapture{Capturer: capturer}
	if err := capture.HoldNewWindow(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { runOnMainThread(capture.ReleaseNewWindow) })
	if got := steps.Load(); got != 1 {
		t.Fatalf("the hold ran in %d steps of the main thread, want 1", got)
	}
}
