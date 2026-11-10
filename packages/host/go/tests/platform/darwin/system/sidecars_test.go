//go:build darwin

package system_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// requireEnded checks that the process pid ended and was reaped.
func requireEnded(t *testing.T, pid int) {
	t.Helper()
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("sidecar process %d still exists after its failure: kill(0) = %v", pid, err)
	}
}

// contract: sidecars.failure.oversize-message-terminates-and-notifies
func TestOversizeSidecarMessageTerminatesAndNotifies(t *testing.T) {
	script, _ := support.PaddedMessageScript(support.MessageLimit+1, "exec sleep 600")
	sidecars, directory := support.ScriptSidecars(t, script)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	failure := owner.Failure(t)
	if failure.Sidecar != support.EchoSidecar || failure.Surface != "s1" || !strings.Contains(failure.Reason, "exceeds 67108864 bytes") {
		t.Fatalf("oversize failure = %+v", failure)
	}
	requireEnded(t, support.ProcessID(t, directory))
}

// contract: sidecars.failure.invalid-message-terminates-and-notifies
func TestInvalidSidecarMessageTerminatesAndNotifies(t *testing.T) {
	for _, line := range []string{`not json`, `{"surface":"s1"}`} {
		sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%s\\n' '"+line+"'\nexec sleep 600\n")
		owner := support.NewFakeOwner("/projects/a")
		if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
		failure := owner.Failure(t)
		if failure.Sidecar != support.EchoSidecar || failure.Surface != "s1" || !strings.Contains(failure.Reason, "invalid message") {
			t.Fatalf("%s: failure = %+v", line, failure)
		}
		requireEnded(t, support.ProcessID(t, directory))
	}
}

// TestCloseDuringStopSendsNothing verifies that a surface close and a window close after Stop ended the input and before the process ends send nothing.
// When the application ends, windows close together with Stop and call CloseOwner.
// contract: sidecars.stop.forgets-running-sidecars
func TestCloseDuringStopSendsNothing(t *testing.T) {
	directory := t.TempDir()
	// The sidecar: at start it opens ended and release for reading and writing. It echoes the lines it received, and when the input ends it writes one line to ended and
	// stays alive until one line arrives on release. The sidecar keeps both pipes open, so the line it wrote is not discarded and the opening side
	// does not block.
	ended := filepath.Join(directory, "ended")
	release := filepath.Join(directory, "release")
	for _, fifo := range []string{ended, release} {
		if err := syscall.Mkfifo(fifo, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\nexec 3<>" + release + " 4<>" + ended + "\nwhile read line; do echo \"$line\"; done\n" +
		"echo ended >&4\nread -r released <&3\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "lingering"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	// Writes one line to release so that no sidecar remains even if the check ends midway.
	var released sync.Once
	releaseSidecar := func() {
		released.Do(func() {
			fifo, err := os.OpenFile(release, os.O_RDWR, 0)
			if err != nil {
				t.Errorf("open release: %v", err)
				return
			}
			if _, err := fifo.Write([]byte("x\n")); err != nil {
				t.Errorf("write release: %v", err)
			}
			if err := fifo.Close(); err != nil {
				t.Errorf("close release: %v", err)
			}
		})
	}
	t.Cleanup(releaseSidecar)
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"lingering","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = support.Stall
	owner := support.NewFakeOwner("/projects/test")
	for _, surface := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, support.EchoSidecar, surface, json.RawMessage(`{"test":"data"}`)); err != nil {
			t.Fatalf("send %s: %v", surface, err)
		}
		if event := owner.Next(t); event.Surface != surface {
			t.Fatalf("echo event = %+v", event)
		}
	}

	stopped := make(chan struct{})
	go func() {
		sidecars.Stop()
		close(stopped)
	}()
	// When the sidecar writes to ended, Stop has ended the input and the process is still running.
	signal, err := os.Open(ended)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(signal).ReadString('\n')
	if closeErr := signal.Close(); closeErr != nil {
		t.Errorf("close ended: %v", closeErr)
	}
	if err != nil || line != "ended\n" {
		t.Fatalf("end of input signal = %q, %v", line, err)
	}
	sidecars.Close("s1")
	sidecars.CloseOwner(owner)
	if closing := sidecars.Closing(); len(closing) != 0 {
		t.Fatalf("closing during stop = %+v, want none", closing)
	}
	releaseSidecar()
	select {
	case <-stopped:
	case <-time.After(support.Stall):
		t.Fatal("stop did not return after the sidecar ended")
	}
}

// contract: sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail, sidecars.protocol.dropped-message-is-recorded, sidecars.image.retired-owner-dispositions
func TestClosedSurfaceMessagesAreDiscardedAndUnknownOnesFail(t *testing.T) {
	written := support.CaptureLog(t)
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nread open1\nread open2\nread open3\nread closed2\n"+
		"printf '%s\\n' '{\"surface\":\"s2\",\"body\":\"late\"}' '{\"surface\":\"s2\",\"body\":{\"image\":{\"name\":17}}}' '{\"surface\":\"s1\",\"body\":\"after\"}'\n"+
		"read barrier\nprintf '{\"surface\":\"s1\",\"body\":{\"barrier\":%s}}\\n' \"$barrier\"\n"+
		"printf '%s\\n' '{\"surface\":\"ghost\",\"body\":\"x\"}'\nexec sleep 600\n")
	owner := support.NewFakeOwner("/projects/a")
	for _, surface := range []string{"s1", "s2", "s3"} {
		if err := sidecars.Send(owner, support.EchoSidecar, surface, json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s2")
	// The late message of s2 is discarded, and the s1 message after it is the first event.
	if event := owner.Next(t); event.Surface != "s1" || string(event.Body) != `"after"` {
		t.Fatalf("first event = %+v", event)
	}
	// The script reads the next host request only after both closed-surface messages and the live-surface marker were read.
	// Closing s3 is the barrier: any erroneous response to either earlier message would reach the script first.
	sidecars.Close("s3")
	barrierEvent := owner.Next(t)
	var barrier struct {
		Barrier struct {
			Surface string `json:"surface"`
			Closed  bool   `json:"closed"`
		} `json:"barrier"`
	}
	if barrierEvent.Surface != "s1" || json.Unmarshal(barrierEvent.Body, &barrier) != nil ||
		barrier.Barrier.Surface != "s3" || !barrier.Barrier.Closed {
		t.Fatalf("barrier event = %+v, want the close request for s3 after both discarded messages", barrierEvent)
	}
	failure := owner.Failure(t)
	if failure.Sidecar != support.EchoSidecar || failure.Surface != "s1" || failure.Reason != "unknown surface ghost" {
		t.Fatalf("failure = %+v", failure)
	}
	requireEnded(t, support.ProcessID(t, directory))
	// The discarded message of s2 is recorded with its body.
	if want := ` warn host sidecar @fixture/sidecar-echo: message for surface s2 dropped: no window owns the surface: "late"`; !strings.Contains(written(), want) {
		t.Fatalf("the log has no %q:\n%s", want, written())
	}
	if want := ` warn host sidecar @fixture/sidecar-echo: message for surface s2 dropped: no window owns the surface: {"image":{"name":17}}`; !strings.Contains(written(), want) {
		t.Fatalf("the log has no %q:\n%s", want, written())
	}
}

// contract: sidecars.stop.stdin-eof-cancels-late-image
func TestStopCancelsAnImageEmittedAfterStdioSidecarInputCloses(t *testing.T) {
	written := support.CaptureLog(t)
	script := "#!/bin/sh\necho $$ > DIR/pid\nread open\nread closed\ncat >/dev/null\n" +
		"printf '%s\\n' '{\"surface\":\"s2\",\"body\":{\"image\":{\"format\":\"bgra8\",\"generation\":3,\"height\":10,\"name\":\"view\",\"raster\":4,\"scale\":1.0,\"sequence\":5,\"token\":{\"id\":7,\"kind\":\"iosurface-global\"},\"width\":10}}}'\n"
	sidecars, directory := support.ScriptSidecars(t, script)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s2")
	sidecars.Stop()
	requireEnded(t, support.ProcessID(t, directory))
	owner.Mu.Lock()
	delivered := append([]host.SidecarMessage(nil), owner.Events...)
	owner.Mu.Unlock()
	if len(delivered) != 0 {
		t.Fatalf("messages delivered while stopping after stdin EOF: %+v, want the late image canceled", delivered)
	}
	got := written()
	if strings.Contains(got, "error host sidecar "+support.EchoSidecar+": answer of the image of closed surface s2: sidecars are stopped") {
		t.Fatalf("stop logged a failed reply for process-owned output: %s", got)
	}
	if !strings.Contains(got, "info host sidecar "+support.EchoSidecar+": canceled transfer image of closed surface s2") {
		t.Fatalf("stop did not record cancellation of process-owned output: %s", got)
	}
}

// processEnd bounds the checks of the end of a sidecar process. The end comes from the exit of the process; the bound only ends a
// check whose end does not come.
const processEnd = 20 * time.Second

// recordedPID is the process id that a script wrote to DIR/<name>; it waits until the script wrote it.
func recordedPID(t *testing.T, directory, name string) int {
	t.Helper()
	deadline := time.Now().Add(processEnd)
	for {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if pid, parsed := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && parsed == nil && pid > 0 {
			return pid
		}
		if time.Now().After(deadline) {
			t.Fatalf("the script wrote no process id to %s", name)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// requireGone checks that the process pid ends, as a process of an ended process group does.
func requireGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(processEnd)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("process %d of the process group of the sidecar still runs after the sidecar ended", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// failureWithin returns the next failure of owner, or fails when none comes within processEnd.
func failureWithin(t *testing.T, owner *support.FakeOwner) support.SidecarFailure {
	t.Helper()
	select {
	case value := <-owner.Failures:
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var failure support.SidecarFailure
		if err := json.Unmarshal(data, &failure); err != nil {
			t.Fatal(err)
		}
		return failure
	case <-time.After(processEnd):
		t.Fatal("the sidecar exited and no failure came, because a process that it started keeps its output open")
	}
	return support.SidecarFailure{}
}

// The end of a sidecar is the exit of its process: a process that it started keeps its output open, and the exit still fails the
// running sidecar and ends its process group (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
func TestASidecarThatExitsFailsWhileItsChildKeepsTheOutput(t *testing.T) {
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nsleep 3600 &\necho $! > DIR/child\nread request\nexit 3\n")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	child := recordedPID(t, directory, "child")
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	failure := failureWithin(t, owner)
	if failure.Surface != "s1" || failure.Reason != "output closed: exit status 3" {
		t.Fatalf("failure = %+v, want output closed: exit status 3", failure)
	}
	requireGone(t, child)
}

// A process that left the process group of the sidecar and keeps its output open does not hold the end of the sidecar
// (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
func TestASidecarThatExitsFailsWhileAProcessOutsideItsGroupKeepsTheOutput(t *testing.T) {
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\n"+
		"/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); open(my $f, \">\", \"DIR/child\"); print $f $$; close $f; sleep 3600'\n"+
		"read request\nexit 3\n")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	child := recordedPID(t, directory, "child")
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	failure := failureWithin(t, owner)
	if failure.Surface != "s1" || failure.Reason != "output closed: exit status 3" {
		t.Fatalf("failure = %+v, want output closed: exit status 3", failure)
	}
}

// A stop ends by the exit of the sidecar and ends its process group, also when a process that the sidecar started keeps its output
// open (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
func TestAStopEndsBySidecarExitWhileItsChildKeepsTheOutput(t *testing.T) {
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\nsleep 3600 &\necho $! > DIR/child\nexec cat >/dev/null\n")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	child := recordedPID(t, directory, "child")
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	stopped := make(chan struct{})
	go func() {
		sidecars.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(processEnd):
		t.Fatal("the sidecar exited and the stop still waits, because a process that it started keeps its output open")
	}
	requireGone(t, child)
}
