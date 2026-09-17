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

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// fakeCapture 는 호출을 기록하고 지정한 단계에서 실패한다.
type fakeCapture struct {
	calls     []string
	failOpen  bool
	failStart bool
	noFrame   bool
}

func (f *fakeCapture) Open(windowNumber int) error {
	f.calls = append(f.calls, fmt.Sprintf("open %d", windowNumber))
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
	return 3, nil
}

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

func TestFinishedRecordingKeepsItsFolderAndReportsFrames(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, 7, folder); err != nil {
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

func TestFailedOpenRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	err := recording.Start(&fakeCapture{failOpen: true}, 7, folder)
	if err == nil || err.Error() != "open failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
}

func TestFailedStartRemovesTheFolder(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	err := recording.Start(&fakeCapture{failStart: true}, 7, folder)
	if err == nil || err.Error() != "start failed" || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
}

func TestRecordingWithoutAFirstFrameIsStoppedAndRemoved(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "frames")
	var recording host.Recording
	fake := &fakeCapture{noFrame: true}
	if err := recording.Start(fake, 7, folder); err == nil || exists(folder) || recording.Running() != "" {
		t.Fatalf("start %v, folder kept %v", err, exists(folder))
	}
	expectCalls(t, fake, "open 7", "start", "wait", "stop")
}

func TestAbortedRecordingIsStoppedAndRemovedAndAllowsTheNext(t *testing.T) {
	parent := t.TempDir()
	first, second := filepath.Join(parent, "first"), filepath.Join(parent, "second")
	var recording host.Recording
	fake := &fakeCapture{}
	if err := recording.Start(fake, 7, first); err != nil {
		t.Fatal(err)
	}
	if err := recording.Start(fake, 7, second); err == nil || !strings.Contains(err.Error(), "is running") || exists(second) {
		t.Fatalf("a second recording started: %v", err)
	}
	recording.Abort(fake)
	if exists(first) {
		t.Fatal("the aborted folder remains")
	}
	if err := recording.Start(fake, 7, second); err != nil {
		t.Fatal(err)
	}
	// 같은 창이면 녹화 대상을 다시 준비하지 않는다.
	expectCalls(t, fake, "open 7", "start", "wait", "stop", "start", "wait")
}
