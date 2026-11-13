//go:build diagnostics

// Diagnostic recording state tests. The recording device records its calls and succeeds; the fault points inject its failures.
// They are compiled only in a diagnostic build.
package host_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// The fault injection points of the recording (packages/host/go/src/recording.go). A failure of the device call is set with the
// variable of its point, whose value is the error text.
const (
	faultOpen  = "SOKSAK_FAULT_CAPTURE_OPEN"
	faultStart = "SOKSAK_FAULT_CAPTURE_START"
	faultStop  = "SOKSAK_FAULT_CAPTURE_STOP"
)

// fakeCapture records the calls of the recording device and writes the records of a start into its folder, as the native device
// does before the start answers. Its failures come from the fault points, and it removes no folder itself. A file of blockDirectory
// stops the removal of its folder by the real filesystem.
type fakeCapture struct {
	calls                []string
	plans                []host.CapturePlan
	blockDirectoryOnOpen string
	blockDirectoryOnStop string
}

func blockDirectory(path string) error {
	if err := os.WriteFile(filepath.Join(path, "blocker"), []byte("prevent removal"), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0)
}

func (f *fakeCapture) Open(target host.CaptureTarget) error {
	kind := ""
	if target.Display {
		kind = " display"
	}
	f.calls = append(f.calls, fmt.Sprintf("open %d%s", target.Window, kind))
	if f.blockDirectoryOnOpen != "" {
		if err := blockDirectory(f.blockDirectoryOnOpen); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeCapture) Start(directory string, plan host.CapturePlan) error {
	f.calls = append(f.calls, "start")
	f.plans = append(f.plans, plan)
	for _, name := range []string{"stills.jsonl", "display-link.json"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("{}\n"), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeCapture) Stop() (int, error) {
	f.calls = append(f.calls, "stop")
	if f.blockDirectoryOnStop != "" {
		if err := blockDirectory(f.blockDirectoryOnStop); err != nil {
			return 0, err
		}
	}
	return 3, nil
}

var window = host.CaptureTarget{Window: 7}

// plan is the plan of the stills of the recordings of these tests.
var plan = host.CapturePlan{Gap: 8, Frames: 120}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func expectCalls(t *testing.T, fake *fakeCapture, want ...string) {
	t.Helper()
	if !reflect.DeepEqual(fake.calls, want) {
		t.Fatalf("calls %v, want %v", fake.calls, want)
	}
}

// contract: recording.finish.keeps-folder-and-reports-frames
func TestFinishedRecordingKeepsItsFolderAndReportsFrames(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, folder, plan); err != nil {
		t.Fatal(err)
	}
	if recording.Running() != folder {
		t.Fatalf("running %q", recording.Running())
	}
	directory, count, recorded, err := recording.Finish(fake)
	if err != nil || directory != folder || count != 3 || !exists(folder) || recorded == nil || *recorded != window.Window {
		t.Fatalf("finish %q %d window=%v %v", directory, count, recorded, err)
	}
	expectCalls(t, fake, "open 7", "start", "stop")
	if !reflect.DeepEqual(fake.plans, []host.CapturePlan{plan}) {
		t.Fatalf("the start received the plans %+v, want %+v", fake.plans, plan)
	}
	if _, _, _, err := recording.Finish(fake); err == nil {
		t.Fatal("a second finish succeeded")
	}
}

// contract: recording.finish.retired-stop-failure-releases-owner
func TestFinishRetiredStopFailureReleasesOwnerAndPreservesFolder(t *testing.T) {
	parent := t.TempDir()
	folder := filepath.Join(parent, "frames")
	t.Setenv(faultStop, "stop failed")
	fake := &fakeCapture{}
	var recording host.Recording
	if err := recording.Start(fake, window, folder, plan); err != nil {
		t.Fatal(err)
	}
	directory, _, _, err := recording.Finish(fake)
	if err == nil || !strings.Contains(err.Error(), "stop failed") {
		t.Fatalf("finish error %v, want stop failure", err)
	}
	if directory != folder || !exists(folder) || recording.Running() != "" {
		t.Fatalf("retired finish directory=%q exists=%t running=%q", directory, exists(folder), recording.Running())
	}
	if err := recording.Start(&fakeCapture{}, window, filepath.Join(parent, "next"), plan); err != nil {
		t.Fatalf("next start after retired stop failure: %v", err)
	}
	expectCalls(t, fake, "open 7", "start", "stop")
}

// contract: recording.start.failed-open-removes-folder
func TestFailedOpenRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	t.Setenv(faultOpen, "open failed")
	fake := &fakeCapture{}
	err := recording.Start(fake, window, folder, plan)
	if err == nil || err.Error() != "open failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
	expectCalls(t, fake, "open 7")
}

// contract: recording.start.failed-start-removes-folder
func TestFailedStartRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	t.Setenv(faultStart, "the first still was not written before the window closed")
	fake := &fakeCapture{}
	err := recording.Start(fake, window, folder, plan)
	if err == nil || err.Error() != "the first still was not written before the window closed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
	// The native start ends its recording when still 0 fails, so the recording asks for no stop.
	expectCalls(t, fake, "open 7", "start")
	t.Setenv(faultStart, "")
	if err := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), plan); err != nil {
		t.Fatalf("next start after a failed start: %v", err)
	}
}

// contract: recording.start.no-first-still-removes-folder
func TestFailedFirstStillRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	t.Setenv(faultStart, "window 7 is not on screen")
	fake := &fakeCapture{}
	err := recording.Start(fake, window, folder, plan)
	if err == nil || err.Error() != "window 7 is not on screen" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v, running %q", err, exists(folder), recording.Running())
	}
	// The native start ended its recording with still 0, so the recording asks for no stop.
	expectCalls(t, fake, "open 7", "start")
	t.Setenv(faultStart, "")
	if err := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), plan); err != nil {
		t.Fatalf("next start after a failed first still: %v", err)
	}
}

// contract: recording.start.make-failure-preserves-unowned-path
func TestStartMakeFailurePreservesUnownedPath(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(folder, "caller-owned")
	if err := os.WriteFile(sentinel, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	var recording host.Recording
	fake := &fakeCapture{}
	err := recording.Start(fake, window, folder, plan)
	if err == nil || recording.Running() != "" || !exists(sentinel) {
		t.Fatalf("start error=%v running=%q caller path exists=%t", err, recording.Running(), exists(sentinel))
	}
	expectCalls(t, fake)
}

// contract: recording.start.cleanup-failure-retains-folder-owner
func TestFailedStartCleanupRetainsFolderOwner(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	t.Setenv(faultOpen, "open failed")
	fake := &fakeCapture{blockDirectoryOnOpen: folder}
	err := recording.Start(fake, window, folder, plan)
	defer os.Chmod(folder, 0o700)
	if err == nil || !strings.Contains(err.Error(), "remove failed capture directory") {
		t.Fatalf("start error = %v", err)
	}
	if recording.Running() != folder {
		t.Fatalf("cleanup owner %q, want %q", recording.Running(), folder)
	}
	blocked := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), plan)
	if blocked == nil || !strings.Contains(blocked.Error(), "is running") {
		t.Fatalf("a new recording was not blocked: %v", blocked)
	}
	if err := os.Chmod(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("abort left folder=%t running=%q", exists(folder), recording.Running())
	}
	expectCalls(t, fake, "open 7")
}

// contract: recording.start.rejects-while-running, recording.abort.stops-removes-and-allows-next, recording.target.prepared-each-recording
func TestAbortedRecordingIsStoppedAndRemovedAndAllowsTheNext(t *testing.T) {
	parent := t.TempDir()
	first, second := filepath.Join(parent, "first"), filepath.Join(parent, "second")
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, first, plan); err != nil {
		t.Fatal(err)
	}
	if err := recording.Start(fake, window, second, plan); err == nil || !strings.Contains(err.Error(), "is running") || exists(second) {
		t.Fatalf("a second recording started: %v", err)
	}
	recording.Abort(fake)
	if exists(first) {
		t.Fatal("the aborted folder remains")
	}
	if err := recording.Start(fake, window, second, plan); err != nil {
		t.Fatal(err)
	}
	// The preparation reads the windows of the target at that time, so the same window is prepared again for each recording.
	expectCalls(t, fake, "open 7", "start", "stop", "open 7", "start")
}

// contract: recording.abort.retired-stop-failure-removes-folder
func TestAbortRetiredStopFailureRemovesFolderAndReportsStopError(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, folder, plan); err != nil {
		t.Fatal(err)
	}
	t.Setenv(faultStop, "stop failed")
	err := recording.Abort(fake)
	if err == nil || !strings.Contains(err.Error(), "stop capture: stop failed") {
		t.Fatalf("abort error %v", err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retired abort left folder=%t running=%q", exists(folder), recording.Running())
	}
	if err := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), plan); err != nil {
		t.Fatalf("next start after retired abort: %v", err)
	}
	expectCalls(t, fake, "open 7", "start", "stop")
}

// contract: recording.abort.retired-stop-failure-cleanup-retry-skips-stop
func TestAbortRetiredStopFailureCleanupRetrySkipsStop(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{blockDirectoryOnStop: folder}
	if err := recording.Start(fake, window, folder, plan); err != nil {
		t.Fatal(err)
	}
	t.Setenv(faultStop, "stop failed")
	err := recording.Abort(fake)
	defer os.Chmod(folder, 0o700)
	if err == nil || !strings.Contains(err.Error(), "stop failed") || !strings.Contains(err.Error(), "remove capture directory") {
		t.Fatalf("abort error %v, want stop and cleanup errors", err)
	}
	if recording.Running() != folder {
		t.Fatalf("retired cleanup owner %q, want %q", recording.Running(), folder)
	}
	if err := os.Chmod(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(folder, "blocker")); err != nil {
		t.Fatal(err)
	}
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retry left folder=%t running=%q", exists(folder), recording.Running())
	}
	expectCalls(t, fake, "open 7", "start", "stop")
}

// contract: recording.abort.stop-complete-cleanup-retry-skips-stop
func TestAbortCleanupRetrySkipsCompletedStop(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{blockDirectoryOnStop: folder}
	if err := recording.Start(fake, window, folder, plan); err != nil {
		t.Fatal(err)
	}
	err := recording.Abort(fake)
	defer os.Chmod(folder, 0o700)
	if err == nil || !strings.Contains(err.Error(), "remove capture directory") {
		t.Fatalf("abort error = %v", err)
	}
	if recording.Running() != folder {
		t.Fatalf("cleanup owner %q, want %q", recording.Running(), folder)
	}
	expectCalls(t, fake, "open 7", "start", "stop")
	if err := os.Chmod(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retry left folder=%t running=%q", exists(folder), recording.Running())
	}
	expectCalls(t, fake, "open 7", "start", "stop")
}

// contract: recording.target.different-target-reopened
func TestDifferentTargetIsPreparedAgain(t *testing.T) {
	parent := t.TempDir()
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, filepath.Join(parent, "window"), plan); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := recording.Finish(fake); err != nil {
		t.Fatal(err)
	}
	display := host.CaptureTarget{Window: 7, Display: true}
	if err := recording.Start(fake, display, filepath.Join(parent, "display"), plan); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := recording.Finish(fake); err != nil {
		t.Fatal(err)
	}
	expectCalls(t, fake, "open 7", "start", "stop", "open 7 display", "start", "stop")
}
