//go:build diagnostics

// 진단 녹화 상태 테스트. 녹화 장치는 가짜가 대신한다. 진단 빌드에서만 컴파일한다.
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

// fakeCapture 는 호출을 기록하고 지정한 단계에서 실패한다.
type fakeCapture struct {
	calls     []string
	failOpen  bool
	failStart bool
	noFrame   bool
	stopErr   bool
}

func (f *fakeCapture) Open(target host.CaptureTarget) error {
	kind := ""
	if target.Display {
		kind = " display"
	}
	f.calls = append(f.calls, fmt.Sprintf("open %d%s", target.Window, kind))
	if f.failOpen {
		return errors.New("open failed")
	}
	return nil
}

func (f *fakeCapture) Start(string) error {
	f.calls = append(f.calls, "start")
	if f.failStart {
		return errors.New("start failed")
	}
	return nil
}

func (f *fakeCapture) Wait() (bool, error) {
	f.calls = append(f.calls, "wait")
	return !f.noFrame, nil
}

func (f *fakeCapture) Stop() (int, error) {
	f.calls = append(f.calls, "stop")
	if f.stopErr {
		return 0, errors.New("stop failed")
	}
	return 3, nil
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
	if err := recording.Start(fake, window, folder); err != nil {
		t.Fatal(err)
	}
	if recording.Running() != folder {
		t.Fatalf("running %q", recording.Running())
	}
	directory, count, err := recording.Finish(fake)
	if err != nil || directory != folder || count != 3 || !exists(folder) {
		t.Fatalf("finish %q %d %v", directory, count, err)
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop")
	if _, _, err := recording.Finish(fake); err == nil {
		t.Fatal("a second finish succeeded")
	}
}

// contract: recording.start.failed-open-removes-folder
func TestFailedOpenRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	err := recording.Start(&fakeCapture{failOpen: true}, window, folder)
	if err == nil || err.Error() != "open failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
}

// contract: recording.start.failed-start-removes-folder
func TestFailedStartRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	err := recording.Start(&fakeCapture{failStart: true}, window, folder)
	if err == nil || err.Error() != "start failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
}

// contract: recording.start.no-first-frame-stops-and-removes
func TestRecordingWithoutAFirstFrameIsStoppedAndRemoved(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{noFrame: true}
	if err := recording.Start(fake, window, folder); err == nil || exists(folder) || recording.Running() != "" {
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
	if err := recording.Start(fake, window, first); err != nil {
		t.Fatal(err)
	}
	if err := recording.Start(fake, window, second); err == nil || !strings.Contains(err.Error(), "is running") || exists(second) {
		t.Fatalf("a second recording started: %v", err)
	}
	recording.Abort(fake)
	if exists(first) {
		t.Fatal("the aborted folder remains")
	}
	if err := recording.Start(fake, window, second); err != nil {
		t.Fatal(err)
	}
	// 준비는 그때의 창 크기로 출력 크기를 정하므로 같은 창도 녹화마다 다시 준비한다.
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "open 7", "start", "wait")
}

// contract: recording.abort.reports-stop-failure-and-removes-folder
func TestAbortReportsStopFailureAndStillRemovesFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{stopErr: true}
	if err := recording.Start(fake, window, folder); err != nil {
		t.Fatal(err)
	}
	err := recording.Abort(fake)
	if err == nil || !strings.Contains(err.Error(), "stop capture: stop failed") {
		t.Fatalf("abort error %v", err)
	}
	if exists(folder) {
		t.Fatal("the aborted folder remains")
	}
}

// contract: recording.target.different-target-reopened
func TestDifferentTargetIsPreparedAgain(t *testing.T) {
	parent := t.TempDir()
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, window, filepath.Join(parent, "window")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := recording.Finish(fake); err != nil {
		t.Fatal(err)
	}
	display := host.CaptureTarget{Window: 7, Display: true}
	if err := recording.Start(fake, display, filepath.Join(parent, "display")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := recording.Finish(fake); err != nil {
		t.Fatal(err)
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "open 7 display", "start", "wait", "stop")
}
