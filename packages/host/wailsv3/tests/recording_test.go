//go:build diagnostics

// Diagnostic recording state tests. A fake replaces the recording device. They are compiled only in a diagnostic build.
package host_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// fakeCapture records the calls and fails at the specified stage.
type fakeCapture struct {
	calls                []string
	failOpen             bool
	failStart            bool
	noFrame              bool
	stopErr              bool
	ownedStream          bool
	retireOnStopError    bool
	streamQueryErr       error
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
	if f.failOpen {
		return errors.New("open failed")
	}
	return nil
}

func (f *fakeCapture) Start(_ string, frameIdentity bool) error {
	if frameIdentity {
		f.calls = append(f.calls, "start frameIdentity")
	} else {
		f.calls = append(f.calls, "start")
	}
	if f.failStart {
		return errors.New("start failed")
	}
	f.ownedStream = true
	return nil
}

func (f *fakeCapture) Wait() (bool, error) {
	f.calls = append(f.calls, "wait")
	return !f.noFrame, nil
}

func (f *fakeCapture) Stop() (int, error) {
	f.calls = append(f.calls, "stop")
	if f.blockDirectoryOnStop != "" {
		if err := blockDirectory(f.blockDirectoryOnStop); err != nil {
			return 0, err
		}
	}
	if f.stopErr {
		if f.retireOnStopError {
			f.ownedStream = false
		}
		return 0, errors.New("stop failed")
	}
	f.ownedStream = false
	return 3, nil
}

func (f *fakeCapture) HasStream() (bool, error) {
	f.calls = append(f.calls, "has stream")
	return f.ownedStream, f.streamQueryErr
}

var window = host.CaptureTarget{Window: 7}

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
	if err := recording.Start(fake, window, folder, true); err != nil {
		t.Fatal(err)
	}
	if recording.Running() != folder {
		t.Fatalf("running %q", recording.Running())
	}
	directory, count, frameIdentity, err := recording.Finish(fake)
	if err != nil || directory != folder || count != 3 || !frameIdentity || !exists(folder) {
		t.Fatalf("finish %q %d frameIdentity=%v %v", directory, count, frameIdentity, err)
	}
	expectCalls(t, fake, "open 7", "start frameIdentity", "wait", "stop")
	if _, _, _, err := recording.Finish(fake); err == nil {
		t.Fatal("a second finish succeeded")
	}
}

// contract: recording.finish.retired-stop-failure-releases-owner
func TestFinishRetiredStopFailureReleasesOwnerAndPreservesFolder(t *testing.T) {
	parent := t.TempDir()
	folder := filepath.Join(parent, "frames")
	fake := &fakeCapture{stopErr: true, retireOnStopError: true}
	var recording host.Recording
	if err := recording.Start(fake, window, folder, false); err != nil {
		t.Fatal(err)
	}
	directory, _, _, err := recording.Finish(fake)
	if err == nil || !strings.Contains(err.Error(), "stop failed") {
		t.Fatalf("finish error %v, want stop failure", err)
	}
	if directory != folder || !exists(folder) || recording.Running() != "" {
		t.Fatalf("retired finish directory=%q exists=%t running=%q", directory, exists(folder), recording.Running())
	}
	if err := recording.Start(&fakeCapture{}, window, filepath.Join(parent, "next"), false); err != nil {
		t.Fatalf("next start after retired stop failure: %v", err)
	}
}

// contract: recording.start.failed-open-removes-folder
func TestFailedOpenRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	err := recording.Start(&fakeCapture{failOpen: true}, window, folder, false)
	if err == nil || err.Error() != "open failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
}

// contract: recording.start.failed-start-removes-folder
func TestFailedStartRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	err := recording.Start(&fakeCapture{failStart: true}, window, folder, false)
	if err == nil || err.Error() != "start failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
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
	err := recording.Start(fake, window, folder, false)
	if err == nil || recording.Running() != "" || !exists(sentinel) {
		t.Fatalf("start error=%v running=%q caller path exists=%t", err, recording.Running(), exists(sentinel))
	}
	expectCalls(t, fake)
}

// contract: recording.start.cleanup-failure-retains-folder-owner
func TestFailedStartCleanupRetainsFolderOwner(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{failOpen: true, blockDirectoryOnOpen: folder}
	err := recording.Start(fake, window, folder, false)
	defer os.Chmod(folder, 0o700)
	if err == nil || !strings.Contains(err.Error(), "remove failed capture directory") {
		t.Fatalf("start error = %v", err)
	}
	if recording.Running() != folder {
		t.Fatalf("cleanup owner %q, want %q", recording.Running(), folder)
	}
	blocked := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), false)
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

// contract: recording.start.stop-failure-preserves-retry-state
func TestStartStopFailurePreservesRetryState(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{noFrame: true, stopErr: true}
	err := recording.Start(fake, window, folder, false)
	if err == nil || !strings.Contains(err.Error(), "stop failed recording: stop failed") {
		t.Fatalf("start error = %v", err)
	}
	if !exists(folder) || recording.Running() != folder {
		t.Fatalf("failed stop lost cleanup owner: folder=%t running=%q", exists(folder), recording.Running())
	}
	blocked := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), false)
	if blocked == nil || !strings.Contains(blocked.Error(), "is running") {
		t.Fatalf("a new recording was not blocked: %v", blocked)
	}
	fake.stopErr = false
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retry left folder=%t running=%q", exists(folder), recording.Running())
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "has stream", "stop")
}

// contract: recording.start.retired-stop-failure-removes-folder
func TestStartRetiredStopFailureRemovesFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{noFrame: true, stopErr: true, retireOnStopError: true}
	err := recording.Start(fake, window, folder, false)
	if err == nil || !strings.Contains(err.Error(), "stop failed recording: stop failed") {
		t.Fatalf("start error = %v", err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retired failed start left folder=%t running=%q", exists(folder), recording.Running())
	}
}

// contract: recording.start.stop-query-failure-preserves-owner
func TestStartStopOwnershipQueryFailurePreservesOwner(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{noFrame: true, stopErr: true, streamQueryErr: errors.New("status unavailable")}
	err := recording.Start(fake, window, folder, false)
	if err == nil || !strings.Contains(err.Error(), "stop failed recording: stop failed") || !strings.Contains(err.Error(), "status unavailable") {
		t.Fatalf("start error %v, want stop and query errors", err)
	}
	if !exists(folder) || recording.Running() != folder {
		t.Fatalf("unknown ownership lost folder=%t running=%q", exists(folder), recording.Running())
	}
	fake.stopErr = false
	fake.streamQueryErr = nil
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
}

// contract: recording.start.no-first-frame-stops-and-removes
func TestRecordingWithoutAFirstFrameIsStoppedAndRemoved(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{noFrame: true}
	if err := recording.Start(fake, window, folder, false); err == nil || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop")
}

// contract: recording.start.rejects-while-running, recording.abort.stops-removes-and-allows-next, recording.target.prepared-each-recording
func TestAbortedRecordingIsStoppedAndRemovedAndAllowsTheNext(t *testing.T) {
	parent := t.TempDir()
	first, second := filepath.Join(parent, "first"), filepath.Join(parent, "second")
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, first, false); err != nil {
		t.Fatal(err)
	}
	if err := recording.Start(fake, window, second, false); err == nil || !strings.Contains(err.Error(), "is running") || exists(second) {
		t.Fatalf("a second recording started: %v", err)
	}
	recording.Abort(fake)
	if exists(first) {
		t.Fatal("the aborted folder remains")
	}
	if err := recording.Start(fake, window, second, false); err != nil {
		t.Fatal(err)
	}
	// The preparation decides the output size from the window size at that time, so the same window is prepared again for each recording.
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "open 7", "start", "wait")
}

// contract: recording.abort.stop-failure-preserves-retry-state
func TestAbortStopFailurePreservesRetryState(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{stopErr: true}
	if err := recording.Start(fake, window, folder, false); err != nil {
		t.Fatal(err)
	}
	err := recording.Abort(fake)
	if err == nil || !strings.Contains(err.Error(), "stop capture: stop failed") {
		t.Fatalf("abort error %v", err)
	}
	if !exists(folder) || recording.Running() != folder {
		t.Fatalf("failed stop lost cleanup owner: folder=%t running=%q", exists(folder), recording.Running())
	}
	blocked := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), false)
	if blocked == nil || !strings.Contains(blocked.Error(), "is running") {
		t.Fatalf("a new recording was not blocked: %v", blocked)
	}
	fake.stopErr = false
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retry left folder=%t running=%q", exists(folder), recording.Running())
	}
}

// contract: recording.abort.retired-stop-failure-removes-folder
func TestAbortRetiredStopFailureRemovesFolderAndReportsStopError(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{stopErr: true, retireOnStopError: true}
	if err := recording.Start(fake, window, folder, false); err != nil {
		t.Fatal(err)
	}
	err := recording.Abort(fake)
	if err == nil || !strings.Contains(err.Error(), "stop capture: stop failed") {
		t.Fatalf("abort error %v", err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retired abort left folder=%t running=%q", exists(folder), recording.Running())
	}
	if err := recording.Start(&fakeCapture{}, window, filepath.Join(t.TempDir(), "next"), false); err != nil {
		t.Fatalf("next start after retired abort: %v", err)
	}
}

// contract: recording.abort.stop-query-failure-preserves-owner
func TestAbortStopOwnershipQueryFailurePreservesOwner(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{stopErr: true, streamQueryErr: errors.New("status unavailable")}
	if err := recording.Start(fake, window, folder, false); err != nil {
		t.Fatal(err)
	}
	err := recording.Abort(fake)
	if err == nil || !strings.Contains(err.Error(), "stop failed") || !strings.Contains(err.Error(), "status unavailable") {
		t.Fatalf("abort error %v, want stop and query errors", err)
	}
	if !exists(folder) || recording.Running() != folder {
		t.Fatalf("unknown ownership lost folder=%t running=%q", exists(folder), recording.Running())
	}
	fake.stopErr = false
	fake.streamQueryErr = nil
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
}

// contract: recording.abort.retired-stop-failure-cleanup-retry-skips-stop
func TestAbortRetiredStopFailureCleanupRetrySkipsStop(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{stopErr: true, retireOnStopError: true, blockDirectoryOnStop: folder}
	if err := recording.Start(fake, window, folder, false); err != nil {
		t.Fatal(err)
	}
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
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "has stream")
}

// contract: recording.finish.stop-query-failure-preserves-owner
func TestFinishStopOwnershipQueryFailurePreservesOwner(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{stopErr: true, retireOnStopError: true, streamQueryErr: errors.New("status unavailable")}
	if err := recording.Start(fake, window, folder, false); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := recording.Finish(fake)
	if err == nil || !strings.Contains(err.Error(), "stop failed") || !strings.Contains(err.Error(), "status unavailable") {
		t.Fatalf("finish error %v, want stop and query errors", err)
	}
	if !exists(folder) || recording.Running() != folder {
		t.Fatalf("unknown ownership lost folder=%t running=%q", exists(folder), recording.Running())
	}
}

// contract: recording.abort.stop-complete-cleanup-retry-skips-stop
func TestAbortCleanupRetrySkipsCompletedStop(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{blockDirectoryOnStop: folder}
	if err := recording.Start(fake, window, folder, false); err != nil {
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
	expectCalls(t, fake, "open 7", "start", "wait", "stop")
	if err := os.Chmod(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	if exists(folder) || recording.Running() != "" {
		t.Fatalf("retry left folder=%t running=%q", exists(folder), recording.Running())
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop")
}

// contract: recording.target.different-target-reopened
func TestDifferentTargetIsPreparedAgain(t *testing.T) {
	parent := t.TempDir()
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, filepath.Join(parent, "window"), false); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := recording.Finish(fake); err != nil {
		t.Fatal(err)
	}
	display := host.CaptureTarget{Window: 7, Display: true}
	if err := recording.Start(fake, display, filepath.Join(parent, "display"), false); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := recording.Finish(fake); err != nil {
		t.Fatal(err)
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "open 7 display", "start", "wait", "stop")
}
