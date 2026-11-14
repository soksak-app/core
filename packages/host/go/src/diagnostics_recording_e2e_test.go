//go:build e2e && diagnostics

package host

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// The recordings of these tests record a window that is on the screen, which needs the window server images of a display, so they belong to
// the end-to-end tier (docs/operations/examples.md#test-kinds).

// realRecordingTarget returns the recording device of the real platform and the window server number of a real window with its main
// page, which a recording of the test records.
func realRecordingTarget(t *testing.T) (platformCapture, int) {
	t.Helper()
	useCurrentPlatformForViews(t)
	capturer, ok := system.(platform.Capturer)
	if !ok {
		t.Fatal("the platform records no windows")
	}
	savedFramework := framework
	framework = mainThreadFramework{}
	t.Cleanup(func() { framework = savedFramework })
	native := support.TitledWindowWithMainPage(t, runOnMainThread, 400, 300, "main-page.html")
	var shown error
	runOnMainThread(func() { shown = system.ShowWindow(native) })
	if shown != nil {
		t.Fatalf("show the window: %v", shown)
	}
	var numbers []int
	var err error
	runOnMainThread(func() { numbers, err = capturer.WindowNumbers(native) })
	if err != nil || len(numbers) == 0 {
		t.Fatalf("the window numbers of the window: %v, %v", numbers, err)
	}
	// The window server lists a shown window some time after the show and publishes no notification of its list, so the wait polls the
	// open of the recording until it lists the window.
	deadline := time.Now().Add(10 * time.Second)
	for {
		// The open runs on the goroutine of the test: the native open waits for the main run loop, which a step of the main thread blocks.
		opened := capturer.CaptureOpen(numbers[0], false)
		if opened == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the window server did not list the shown window %d: %v", numbers[0], opened)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return platformCapture{Capturer: capturer}, numbers[0]
}

// requirePlanRecorded reads the record of the stills that the real recorder wrote into directory: it holds one line for each planned still
// and each line names the gap of the plan that the recorder received.
func requirePlanRecorded(t *testing.T, directory string, plan CapturePlan, window int) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "stills.jsonl"))
	if err != nil {
		t.Fatalf("the finished recording kept no record of its stills in its folder: %v", err)
	}
	// The first still lists the window that the window server holds on screen and that the recording opened.
	var first struct {
		Outcome string `json:"outcome"`
		Windows []int  `json:"windows"`
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil || first.Outcome != "written" || !slices.Contains(first.Windows, window) {
		t.Fatalf("the first still is %s (%v), want a written frame of the window %d, which the window server lists on screen", lines[0], err, window)
	}
	if len(lines) != plan.Frames {
		t.Fatalf("the record holds %d stills, want the %d of the plan", len(lines), plan.Frames)
	}
	for _, line := range lines {
		var still struct {
			RequestedGap float64 `json:"requestedGap"`
			Windows      []int   `json:"windows"`
		}
		if err := json.Unmarshal([]byte(line), &still); err != nil || still.RequestedGap != plan.Gap {
			t.Fatalf("a still names the gap %v (%v), want the gap %v of the plan: %s", still.RequestedGap, err, plan.Gap, line)
		}
	}
}

// contract: recording.finish.keeps-folder-and-reports-frames
func TestE2ERecordingFinishKeepsTheFolder(t *testing.T) {
	capture, number := realRecordingTarget(t)
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.Start(capture, CaptureTarget{Window: number}, directory, testPlan); err != nil {
		t.Fatal(err)
	}
	finishedDirectory, _, window, err := recording.Finish(capture)
	if err != nil || finishedDirectory != directory || window == nil || *window != number {
		t.Fatalf("finish directory=%q window=%v error=%v", finishedDirectory, window, err)
	}
	requirePlanRecorded(t, directory, testPlan, number)
}

// contract: recording.finish.reports-the-recorded-window
func TestE2ERecordingFinishReportsTheRecordedWindow(t *testing.T) {
	capture, number := realRecordingTarget(t)
	var recording Recording
	if err := recording.Start(capture, CaptureTarget{Window: number, Display: true}, filepath.Join(t.TempDir(), "display"), testPlan); err != nil {
		t.Fatal(err)
	}
	if _, _, window, err := recording.Finish(capture); err != nil || window != nil {
		t.Fatalf("a display recording finished with window %v and error %v, want nil and nil", window, err)
	}
	if err := recording.Start(capture, CaptureTarget{Window: number}, filepath.Join(t.TempDir(), "window"), testPlan); err != nil {
		t.Fatal(err)
	}
	if _, _, window, err := recording.Finish(capture); err != nil || window == nil || *window != number {
		t.Fatalf("a window recording finished with window %v and error %v, want %d and nil", window, err, number)
	}
}

// showWindow shows native on the main thread, as the application shows a new window.
func showWindow(t *testing.T, native platform.Window) {
	t.Helper()
	var err error
	runOnMainThread(func() { err = system.ShowWindow(native) })
	if err != nil {
		t.Fatalf("show the window: %v", err)
	}
}

// contract: diagnostics.capture-start.new-window-answers-once-held
func TestE2EANewWindowRecordingAnswersOnceTheHoldIsSetAndRecordsTheHeldWindow(t *testing.T) {
	capture, newWindow := newWindowCapture(t)
	native := newWindow()
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.StartNewWindow(capture, directory, testPlan); err != nil {
		t.Fatal(err)
	}
	if recording.Running() != directory {
		t.Fatalf("the held recording owns %q, want %q", recording.Running(), directory)
	}
	showWindow(t, native)
	var numbers []int
	var err error
	runOnMainThread(func() { numbers, err = capture.WindowNumbers(native) })
	if err != nil || len(numbers) == 0 {
		t.Fatalf("the window numbers of the shown window: %v, %v", numbers, err)
	}
	finished, count, window, err := recording.Finish(capture)
	if err != nil || finished != directory || count < 1 || window == nil || *window != numbers[0] {
		t.Fatalf("finish = %q, %d, window %v, %v; want the held window %d", finished, count, window, err, numbers[0])
	}
	requirePlanRecorded(t, directory, testPlan, numbers[0])
}

// contract: diagnostics.capture-start.new-window-hold-ends
// A recording whose start fails after the hold took a window shows that window. The start fails in the native library for a plan with
// no gap.
func TestE2EAFailureAfterTheHoldReleasesTheHeldWindow(t *testing.T) {
	capture, newWindow := newWindowCapture(t)
	native := newWindow()
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.StartNewWindow(capture, directory, CapturePlan{Gap: 0, Frames: 1}); err != nil {
		t.Fatal(err)
	}
	showWindow(t, native)
	finished, _, _, err := recording.Finish(capture)
	if finished != directory || err == nil || strings.Contains(err.Error(), "no new window was shown") {
		t.Fatalf("finish = %q, %v, want the failure of the start of the held window", finished, err)
	}
	// The failure ended the hold: the native library takes a new hold only when none is set.
	if err := capture.HoldNewWindow(); err != nil {
		t.Fatalf("the failed recording left its hold set: %v", err)
	}
}
