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
	// does not block. It ignores the terminate signal of the stop, so it ends with its input and its release.
	ended := filepath.Join(directory, "ended")
	release := filepath.Join(directory, "release")
	for _, fifo := range []string{ended, release} {
		if err := syscall.Mkfifo(fifo, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\ntrap '' TERM\nexec 3<>" + release + " 4<>" + ended + "\nwhile read line; do echo \"$line\"; done\n" +
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
	// The script ignores the terminate signal of the stop, so it emits its image after the end of its input; its answer to the
	// open is the event that it set the trap and recorded its pid.
	script := "#!/bin/sh\ntrap '' TERM\necho $$ > DIR/pid\nread open\nprintf '%s\\n' '{\"surface\":\"s2\",\"body\":\"ready\"}'\nread closed\ncat >/dev/null\n" +
		"printf '%s\\n' '{\"surface\":\"s2\",\"body\":{\"image\":{\"format\":\"bgra8\",\"generation\":3,\"height\":10,\"name\":\"view\",\"raster\":4,\"scale\":1.0,\"sequence\":5,\"token\":{\"id\":7,\"kind\":\"iosurface-global\"},\"width\":10}}}'\n"
	sidecars, directory := support.ScriptSidecars(t, script)
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s2", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	if ready := owner.Next(t); ready.Surface != "s2" || string(ready.Body) != `"ready"` {
		t.Fatalf("ready event = %+v", ready)
	}
	sidecars.Close("s2")
	sidecars.Stop()
	requireEnded(t, support.ProcessID(t, directory))
	owner.Mu.Lock()
	delivered := append([]host.SidecarMessage(nil), owner.Events[1:]...)
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

// childFIFO makes the FIFO DIR/<name> to which a script writes the process id of a process that it started.
func childFIFO(t *testing.T, directory, name string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// holdFIFO makes the FIFO DIR/<name> and holds its write end until the check ends. A fixture process that reads it ends at
// the end of the check, also when the check is killed, because the kernel then closes the write end.
func holdFIFO(t *testing.T, directory, name string) *os.File {
	t.Helper()
	path := childFIFO(t, directory, name)
	// A read-write open does not wait for a reader, and the check holds the only writer.
	hold, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := hold.Close(); err != nil {
			t.Error(err)
		}
	})
	return hold
}

// childPID reads the process id that a script writes to the FIFO path; the read ends when the script closes its write.
func childPID(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		t.Fatalf("the script wrote %q as a process id: %v", data, err)
	}
	return pid
}

// requireGone waits for the exit of the process pid, as a process of an ended process group exits; a process that is gone already
// has exited too (ESRCH).
func requireGone(t *testing.T, pid int) {
	t.Helper()
	queue, err := syscall.Kqueue()
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(queue)
	change := []syscall.Kevent_t{{Ident: uint64(pid), Filter: syscall.EVFILT_PROC, Flags: syscall.EV_ADD | syscall.EV_ONESHOT, Fflags: syscall.NOTE_EXIT}}
	events := make([]syscall.Kevent_t, 1)
	for {
		n, err := syscall.Kevent(queue, change, events, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if err != nil {
			t.Fatalf("watch the exit of process %d: %v", pid, err)
		}
		if n == 1 && events[0].Flags&syscall.EV_ERROR != 0 && syscall.Errno(events[0].Data) != syscall.ESRCH {
			t.Fatalf("watch the exit of process %d: %v", pid, syscall.Errno(events[0].Data))
		}
		return
	}
}

// nextFailure returns the next failure of owner.
func nextFailure(t *testing.T, owner *support.FakeOwner) support.SidecarFailure {
	t.Helper()
	data, err := json.Marshal(<-owner.Failures)
	if err != nil {
		t.Fatal(err)
	}
	var failure support.SidecarFailure
	if err := json.Unmarshal(data, &failure); err != nil {
		t.Fatal(err)
	}
	return failure
}

// The end of a sidecar is the exit of its process: a process that it started keeps its output open, and the exit still fails the
// running sidecar and ends its process group (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
func TestASidecarThatExitsFailsWhileItsChildKeepsTheOutput(t *testing.T) {
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\ncat DIR/hold &\necho $! > DIR/child\nread request\nexit 3\n")
	holdFIFO(t, directory, "hold")
	fifo := childFIFO(t, directory, "child")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	child := childPID(t, fifo)
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	// A host that waits for the end of the output delivers no failure, and the check stops at the limit of its runner.
	failure := nextFailure(t, owner)
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
		"/usr/bin/perl -MPOSIX -e 'exit if fork; POSIX::setsid(); open(my $f, \">\", \"DIR/child\"); print $f $$; close $f; open(my $h, \"<\", \"DIR/hold\"); my $line = <$h>'\n"+
		"read request\nexit 3\n")
	holdFIFO(t, directory, "hold")
	fifo := childFIFO(t, directory, "child")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	child := childPID(t, fifo)
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	failure := nextFailure(t, owner)
	if failure.Surface != "s1" || failure.Reason != "output closed: exit status 3" {
		t.Fatalf("failure = %+v, want output closed: exit status 3", failure)
	}
}

// A stop ends by the exit of the sidecar and ends its process group, also when a process that the sidecar started keeps its output
// open (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.is-the-process-exit
func TestAStopEndsBySidecarExitWhileItsChildKeepsTheOutput(t *testing.T) {
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/pid\ncat DIR/hold &\necho $! > DIR/child\nexec cat >/dev/null\n")
	holdFIFO(t, directory, "hold")
	fifo := childFIFO(t, directory, "child")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	child := childPID(t, fifo)
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })
	// A stop that waits for the end of the output does not return, and the check stops at the limit of its runner.
	sidecars.Stop()
	requireGone(t, child)
}

// A stop other than the quit returns before the process exits: a declaration that removes a running sidecar returns while the
// sidecar, which ignores the terminate signal and holds its exit until the test opens its gate, still runs, and the host reaps it
// at its exit (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.stop.returns-at-once-outside-the-quit
func TestAStopOutsideTheQuitReturnsBeforeTheExit(t *testing.T) {
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\ntrap '' TERM\necho $$ > DIR/started\nread request\nread gate < DIR/gate\nexit 3\n")
	started := childFIFO(t, directory, "started")
	gate := holdFIFO(t, directory, "gate")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	pid := childPID(t, started)
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	// A declaration that waits for the exit does not return before the gate opens, and the check stops at the limit of its runner.
	if err := sidecars.Declare([]host.SidecarDeclaration{}); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("the declaration returned after the stopping sidecar %d ended: %v", pid, err)
	}
	if _, err := gate.WriteString("open\n"); err != nil {
		t.Fatal(err)
	}
	requireGone(t, pid)
}

// The stop of the quit writes, for each process that it waits for, the record of that wait (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.stop.records-what-the-quit-waits-for
func TestTheQuitRecordsTheProcessesThatItWaitsFor(t *testing.T) {
	written := support.CaptureLog(t)
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\necho $$ > DIR/started\nwhile read line; do echo \"$line\"; done\n")
	started := childFIFO(t, directory, "started")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	pid := childPID(t, started)
	sidecars.Stop()
	want := "info host sidecar " + support.EchoSidecar + ": the quit waits for the exit of process " + strconv.Itoa(pid) + "\n"
	if logged := written(); !strings.Contains(logged, want) {
		t.Fatalf("log %q does not contain %q", logged, want)
	}
}

// The quit stop refuses the exit while a sidecar that it stops runs, ends at the exit of that sidecar, and accepts the exit
// after it; without a sidecar to stop it accepts the exit at once (docs/spec/hosts.md#process-lifecycle).
// contract: sidecars.stop.quit-exits-after-its-sidecars
func TestTheQuitStopExitsAfterItsSidecars(t *testing.T) {
	written := support.CaptureLog(t)
	// The sidecar ignores the terminate signal and the end of its input and exits when the check opens its gate.
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\ntrap '' TERM\necho $$ > DIR/started\nread request\nread gate < DIR/gate\nexit 0\n")
	started := childFIFO(t, directory, "started")
	gate := holdFIFO(t, directory, "gate")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	pid := childPID(t, started)
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	ended := make(chan struct{})
	if sidecars.QuitStop(false, func() { close(ended) }) {
		t.Fatal("the quit stop accepted the exit while its sidecar runs")
	}
	// The gate holds the sidecar, so no exit can end the stop before the gate opens.
	select {
	case <-ended:
		t.Fatal("the quit stop ended while its sidecar runs")
	default:
	}
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("the quit stop ended the sidecar %d that it waits for: %v", pid, err)
	}
	if _, err := gate.WriteString("open\n"); err != nil {
		t.Fatal(err)
	}
	<-ended
	requireGone(t, pid)
	if !sidecars.QuitStop(false, func() { t.Error("the end of an ended quit stop ran again") }) {
		t.Fatal("the quit stop refused the exit after its sidecars exited")
	}
	want := "info host sidecar " + support.EchoSidecar + ": the quit waits for the exit of process " + strconv.Itoa(pid) + "\n"
	if logged := written(); !strings.Contains(logged, want) {
		t.Fatalf("log %q does not contain %q", logged, want)
	}
	empty, _ := support.ScriptSidecars(t, "#!/bin/sh\ncat\n")
	if !empty.QuitStop(false, func() { t.Error("the quit stop without a sidecar ran its end") }) {
		t.Fatal("the quit stop without a sidecar refused the exit")
	}
}

// A quit request while the quit stop runs force-kills the process group of each sidecar that has not exited and records it; the
// stop then ends by that exit (docs/spec/hosts.md#process-lifecycle).
// contract: sidecars.stop.second-quit-kills-what-remains
func TestASecondQuitKillsTheSidecarsThatTheQuitStopWaitsFor(t *testing.T) {
	written := support.CaptureLog(t)
	// The sidecar ignores the terminate signal and the end of its input, and the check never opens its gate.
	sidecars, directory := support.ScriptSidecars(t, "#!/bin/sh\ntrap '' TERM\necho $$ > DIR/started\nread request\nread gate < DIR/gate\nexit 0\n")
	started := childFIFO(t, directory, "started")
	holdFIFO(t, directory, "gate")
	owner := support.NewFakeOwner("/projects/a")
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	pid := childPID(t, started)
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	ended := make(chan struct{})
	if sidecars.QuitStop(false, func() { close(ended) }) {
		t.Fatal("the quit stop accepted the exit while its sidecar runs")
	}
	if sidecars.QuitStop(false, func() { t.Error("the second quit ran a second end") }) {
		t.Fatal("the second quit accepted the exit while the sidecar runs")
	}
	// A second quit that kills nothing leaves the stop waiting, and the check stops at the limit of its runner.
	<-ended
	requireGone(t, pid)
	if !sidecars.QuitStop(false, func() {}) {
		t.Fatal("the quit stop refused the exit after the kill")
	}
	want := "info host sidecar " + support.EchoSidecar + ": the second quit kills process " + strconv.Itoa(pid) + "\n"
	logged := written()
	if !strings.Contains(logged, want) {
		t.Fatalf("log %q does not contain %q", logged, want)
	}
	// The exit by the force-kill signal of the second quit is the quit itself.
	if strings.Contains(logged, "exited while stopping") {
		t.Fatalf("log %q reports the exit that the second quit caused", logged)
	}
}
