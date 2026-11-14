//go:build diagnostics

// Diagnostic recording state tests. The state decides from the answers of the recording device and of the filesystem: those
// decisions are replayed from the case table docs/spec/cases/recording/decisions.json that the Rust host replays too, and the
// removal that the cases leave to the filesystem is judged on the real filesystem. The device itself, the recorder of the window
// server, is judged by e2e/capture-state.test.mjs, because a recording needs the images of a window of a display. The tests are
// compiled only in a diagnostic build.
package host_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// recordingCases is the case table of the decisions of the recording state.
type recordingCases struct {
	RefuseStart []struct {
		ID        string  `json:"id"`
		Directory string  `json:"directory"`
		Error     *string `json:"error"`
	} `json:"refuseStart"`
	RefuseFinish []struct {
		ID        string  `json:"id"`
		Directory string  `json:"directory"`
		Stopped   bool    `json:"stopped"`
		Error     *string `json:"error"`
	} `json:"refuseFinish"`
	NeedsStop []struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
		Stopped   bool   `json:"stopped"`
		Stop      bool   `json:"stop"`
	} `json:"needsStop"`
	StopFailure []struct {
		ID    string `json:"id"`
		Stop  string `json:"stop"`
		Error string `json:"error"`
	} `json:"stopFailure"`
	SettleCleanup []struct {
		ID          string  `json:"id"`
		Cause       *string `json:"cause"`
		Removal     *string `json:"removal"`
		RetainOwner bool    `json:"retainOwner"`
		Error       *string `json:"error"`
	} `json:"settleCleanup"`
}

func loadRecordingCases(t *testing.T) recordingCases {
	t.Helper()
	data, err := os.ReadFile("../../../../docs/spec/cases/recording/decisions.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases recordingCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("decisions.json: %v", err)
	}
	return cases
}

// answer is the error that a case gives as the answer of the recorder or of the filesystem, nil for a null.
func answer(text *string) error {
	if text == nil {
		return nil
	}
	return errors.New(*text)
}

// messageOf is the message of err, nil for no error, in the form of a case.
func messageOf(err error) *string {
	if err == nil {
		return nil
	}
	message := err.Error()
	return &message
}

func sameText(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func show(text *string) string {
	if text == nil {
		return "no error"
	}
	return *text
}

// unreachedCapture is the recording device of a test whose judged code must not reach the device: a call fails the test.
type unreachedCapture struct{ t *testing.T }

func (c unreachedCapture) Open(host.CaptureTarget) error {
	c.t.Helper()
	c.t.Fatal("the recording opened its target")
	return nil
}

func (c unreachedCapture) Start(string, host.CapturePlan) error {
	c.t.Helper()
	c.t.Fatal("the recording started")
	return nil
}

func (c unreachedCapture) Stop() (int, error) {
	c.t.Helper()
	c.t.Fatal("the recording stopped")
	return 0, nil
}

// blockedFolder makes a folder with a file in it and removes its permissions, so the real filesystem refuses its removal. The
// returned function gives the permissions back.
func blockedFolder(t *testing.T) (string, func()) {
	t.Helper()
	folder := filepath.Join(t.TempDir(), "frames")
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	records, err := os.Create(filepath.Join(folder, "stills.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if err := records.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(folder, 0); err != nil {
		t.Fatal(err)
	}
	unblock := func() {
		if err := os.Chmod(folder, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { os.Chmod(folder, 0o700) })
	return folder, unblock
}

// folderWithRecords makes a folder with the records that a started recording leaves in it.
func folderWithRecords(t *testing.T) string {
	t.Helper()
	folder := filepath.Join(t.TempDir(), "frames")
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"stills.jsonl", "display-link.json"} {
		if err := os.WriteFile(filepath.Join(folder, name), []byte("records"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return folder
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// requireDecision replays the settleCleanup case with the removal result of the real filesystem in place of the removal text.
func requireCleanup(t *testing.T, cause, removal error, wantOwner bool, wantError *string) {
	t.Helper()
	got := host.SettleCleanup(cause, removal)
	if got.RetainOwner != wantOwner || !sameText(messageOf(got.Err), wantError) {
		t.Fatalf("cleanup of cause %v and removal %v: owner %t error %q, want owner %t error %q",
			cause, removal, got.RetainOwner, show(messageOf(got.Err)), wantOwner, show(wantError))
	}
}

// contract: recording.start.rejects-while-running
func TestStartIsRefusedWhileAFolderIsOwned(t *testing.T) {
	for _, c := range loadRecordingCases(t).RefuseStart {
		if got := messageOf(host.RefuseStart(c.Directory)); !sameText(got, c.Error) {
			t.Errorf("%s: refuse start of %q = %q, want %q", c.ID, c.Directory, show(got), show(c.Error))
		}
	}
}

// contract: recording.finish.keeps-folder-and-reports-frames
func TestFinishedRecordingKeepsItsFolderAndReportsFrames(t *testing.T) {
	for _, c := range loadRecordingCases(t).RefuseFinish {
		if got := messageOf(host.RefuseFinish(c.Directory, c.Stopped)); !sameText(got, c.Error) {
			t.Errorf("%s: refuse finish of %q stopped %t = %q, want %q", c.ID, c.Directory, c.Stopped, show(got), show(c.Error))
		}
	}
	// A recording that is not running has nothing to finish; the finish of a running recording keeps its folder and reports its
	// frames and window, which e2e/capture-state.test.mjs judges with the recorder of the window server.
	var recording host.Recording
	if _, _, _, err := recording.Finish(unreachedCapture{t}); err == nil || err.Error() != "no capture is running" {
		t.Fatalf("finish of an idle recording: %v", err)
	}
}

// contract: recording.finish.retired-stop-failure-releases-owner
func TestFinishRetiredStopFailureReleasesOwnerAndPreservesFolder(t *testing.T) {
	for _, c := range loadRecordingCases(t).StopFailure {
		if got := host.StopFailure(errors.New(c.Stop)).Error(); got != c.Error {
			t.Errorf("%s: stop failure = %q, want %q", c.ID, got, c.Error)
		}
	}
	// The finish of a recording whose stop failed leaves the empty state: it owns no folder, so the next start is accepted and a
	// finish reports no recording, and it removes nothing, so the folder that the start returned stays.
	folder := folderWithRecords(t)
	var recording host.Recording
	if err := host.RefuseStart(recording.Running()); err != nil {
		t.Fatalf("the next start after a retired stop failure: %v", err)
	}
	if _, _, _, err := recording.Finish(unreachedCapture{t}); err == nil || err.Error() != "no capture is running" {
		t.Fatalf("finish after a retired stop failure: %v", err)
	}
	if !exists(folder) {
		t.Fatal("the folder of the retired recording was removed")
	}
}

// contract: recording.start.failed-open-removes-folder
func TestFailedOpenRemovesTheFolder(t *testing.T) {
	folder := folderWithRecords(t)
	cause := errors.New("window 7 is not on screen")
	got := host.SettleCleanup(cause, os.RemoveAll(folder))
	if got.RetainOwner || got.Err != cause || exists(folder) {
		t.Fatalf("owner %t error %v folder kept %t", got.RetainOwner, got.Err, exists(folder))
	}
	for _, c := range loadRecordingCases(t).SettleCleanup {
		if c.ID == "failed-open-folder-removed" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
}

// contract: recording.start.failed-start-removes-folder
func TestFailedStartRemovesTheFolder(t *testing.T) {
	folder := folderWithRecords(t)
	cause := errors.New("the first still was not written before the window closed")
	got := host.SettleCleanup(cause, os.RemoveAll(folder))
	if got.RetainOwner || got.Err != cause || exists(folder) {
		t.Fatalf("owner %t error %v folder kept %t", got.RetainOwner, got.Err, exists(folder))
	}
	for _, c := range loadRecordingCases(t).SettleCleanup {
		if c.ID == "failed-start-folder-removed" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
}

// contract: recording.start.no-first-still-removes-folder
func TestFailedFirstStillRemovesTheFolder(t *testing.T) {
	// The native start ended its recording with still 0 and wrote its records into the folder, so the folder holds them when the
	// removal runs, and no stop follows: the owner is released with the folder.
	folder := folderWithRecords(t)
	cause := errors.New("window 7 is not on screen")
	got := host.SettleCleanup(cause, os.RemoveAll(folder))
	if got.RetainOwner || got.Err != cause || exists(folder) {
		t.Fatalf("owner %t error %v folder kept %t", got.RetainOwner, got.Err, exists(folder))
	}
	if host.NeedsStop("", false) {
		t.Fatal("a released recording asks for a stop")
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
	err := recording.Start(unreachedCapture{t}, host.CaptureTarget{Window: 7}, folder, host.CapturePlan{Gap: 8, Frames: 120})
	if err == nil || recording.Running() != "" || !exists(sentinel) {
		t.Fatalf("start error=%v running=%q caller path exists=%t", err, recording.Running(), exists(sentinel))
	}
}

// contract: recording.start.cleanup-failure-retains-folder-owner
func TestFailedStartCleanupRetainsFolderOwner(t *testing.T) {
	folder, unblock := blockedFolder(t)
	cause := errors.New("window 7 is not on screen")
	removal := os.RemoveAll(folder)
	if removal == nil {
		t.Fatal("the filesystem removed a folder without permissions")
	}
	got := host.SettleCleanup(cause, removal)
	want := "window 7 is not on screen; capture directory cleanup failed: " + removal.Error()
	if !got.RetainOwner || got.Err == nil || got.Err.Error() != want {
		t.Fatalf("owner %t error %v, want owner true error %q", got.RetainOwner, got.Err, want)
	}
	// The folder stays owned: another start is refused until the cleanup completes.
	if err := host.RefuseStart(folder); err == nil {
		t.Fatal("a new recording was not blocked while the folder is owned")
	}
	unblock()
	requireCleanup(t, nil, os.RemoveAll(folder), false, nil)
	if exists(folder) {
		t.Fatal("the retry left the folder")
	}
	for _, c := range loadRecordingCases(t).SettleCleanup {
		if c.ID == "failed-start-folder-kept" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
}

// contract: recording.abort.stops-removes-and-allows-next
func TestAbortedRecordingIsStoppedAndRemovedAndAllowsTheNext(t *testing.T) {
	cases := loadRecordingCases(t)
	for _, c := range cases.NeedsStop {
		if got := host.NeedsStop(c.Directory, c.Stopped); got != c.Stop {
			t.Errorf("%s: needs stop of %q stopped %t = %t, want %t", c.ID, c.Directory, c.Stopped, got, c.Stop)
		}
	}
	folder := folderWithRecords(t)
	requireCleanup(t, nil, os.RemoveAll(folder), false, nil)
	if exists(folder) {
		t.Fatal("the aborted folder remains")
	}
	for _, c := range cases.SettleCleanup {
		if c.ID == "abort-nothing-failed" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
	// An abort of a recording that is not running does nothing, so the next recording starts.
	var recording host.Recording
	if err := recording.Abort(unreachedCapture{t}); err != nil {
		t.Fatalf("abort of an idle recording: %v", err)
	}
}

// contract: recording.abort.retired-stop-failure-removes-folder
func TestAbortRetiredStopFailureRemovesFolderAndReportsStopError(t *testing.T) {
	folder := folderWithRecords(t)
	stop := host.StopFailure(errors.New("stop failed"))
	got := host.SettleCleanup(stop, os.RemoveAll(folder))
	if got.RetainOwner || got.Err == nil || got.Err.Error() != "capture stop failed: stop failed" || exists(folder) {
		t.Fatalf("owner %t error %v folder kept %t", got.RetainOwner, got.Err, exists(folder))
	}
	for _, c := range loadRecordingCases(t).SettleCleanup {
		if c.ID == "abort-stop-failed-folder-removed" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
}

// contract: recording.abort.retired-stop-failure-cleanup-retry-skips-stop
func TestAbortRetiredStopFailureCleanupRetrySkipsStop(t *testing.T) {
	folder, unblock := blockedFolder(t)
	stop := host.StopFailure(errors.New("stop failed"))
	removal := os.RemoveAll(folder)
	if removal == nil {
		t.Fatal("the filesystem removed a folder without permissions")
	}
	got := host.SettleCleanup(stop, removal)
	want := "capture stop failed: stop failed; capture directory cleanup failed: " + removal.Error()
	if !got.RetainOwner || got.Err == nil || got.Err.Error() != want {
		t.Fatalf("owner %t error %v, want owner true error %q", got.RetainOwner, got.Err, want)
	}
	// The native recording has ended, so the retry stops nothing and removes the folder.
	if host.NeedsStop(folder, true) {
		t.Fatal("the retry stops the ended recording again")
	}
	unblock()
	requireCleanup(t, nil, os.RemoveAll(folder), false, nil)
	if exists(folder) {
		t.Fatal("the retry left the folder")
	}
	for _, c := range loadRecordingCases(t).SettleCleanup {
		if c.ID == "abort-stop-failed-folder-kept" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
}

// contract: recording.abort.stop-complete-cleanup-retry-skips-stop
func TestAbortCleanupRetrySkipsCompletedStop(t *testing.T) {
	folder, unblock := blockedFolder(t)
	removal := os.RemoveAll(folder)
	if removal == nil {
		t.Fatal("the filesystem removed a folder without permissions")
	}
	got := host.SettleCleanup(nil, removal)
	want := "capture directory cleanup failed: " + removal.Error()
	if !got.RetainOwner || got.Err == nil || got.Err.Error() != want {
		t.Fatalf("owner %t error %v, want owner true error %q", got.RetainOwner, got.Err, want)
	}
	if host.NeedsStop(folder, true) {
		t.Fatal("the retry stops the ended recording again")
	}
	unblock()
	requireCleanup(t, nil, os.RemoveAll(folder), false, nil)
	if exists(folder) {
		t.Fatal("the retry left the folder")
	}
	for _, c := range loadRecordingCases(t).SettleCleanup {
		if c.ID == "abort-folder-kept" {
			requireCleanup(t, answer(c.Cause), answer(c.Removal), c.RetainOwner, c.Error)
		}
	}
}
