package host

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// A present that waits for the main thread ends when the sidecars stop, a presentation that the main thread runs later does not
// wait, and a present after the stop is refused without a step (docs/spec/sidecars.md#declaration-and-startup).
// contract: images.presentation.ends-with-the-sidecar-stop
func TestAPresentThatWaitsForTheMainThreadEndsWithTheStop(t *testing.T) {
	c, err := NewSidecars(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The main thread holds each step and does not run it, as the main thread that runs the stop at exit does.
	held := make(chan func(), 1)
	step := func(task func()) { held <- task }
	answered := make(chan error, 1)
	go func() { answered <- c.presents.present(func() error { return nil }, step) }()
	task := <-held
	c.Stop()
	// A present that still waits for the main thread does not answer, and the check stops at the limit of its runner.
	if err := <-answered; err == nil || err.Error() != presentsRefused {
		t.Fatalf("the present ended with %v, want %q", err, presentsRefused)
	}
	task()
	refused := c.presents.present(func() error {
		t.Error("a present after the stop ran")
		return nil
	}, func(func()) { t.Error("a present after the stop took a step") })
	if refused == nil || refused.Error() != presentsRefused {
		t.Fatalf("a present after the stop ended with %v, want %q", refused, presentsRefused)
	}
}

// A stop ends the wait of a replacement for the end of the process of the replaced service: the wait returns while that process
// runs, and the replacement ends (docs/spec/persistent-services.md#updates).
// contract: sidecars-transport.replace.waits-for-the-end-of-the-service-process
func TestAStopEndsTheWaitOfAReplacement(t *testing.T) {
	c, err := NewSidecars(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The process of the replaced service reads its input, whose write end the check holds, so it runs until the check ends it
	// and ends with the check process also when the check is killed.
	service := exec.Command("cat")
	input, err := service.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() {
		service.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		input.Close()
		<-exited
	})
	running, installed := "0.0.6", "0.0.7"
	c.mu.Lock()
	c.replacing["fixture-service"] = replacement{running: &running, installed: &installed, pid: service.Process.Pid}
	c.mu.Unlock()
	waited := make(chan struct{})
	go func() {
		c.awaitReplacedService("fixture-service")
		close(waited)
	}()
	// A stop that does not end the wait leaves it waiting, and the check stops at the limit of its runner.
	c.Stop()
	<-waited
	c.mu.Lock()
	_, replacing := c.replacing["fixture-service"]
	c.mu.Unlock()
	if replacing {
		t.Fatal("the replacement that the stop ended is still recorded")
	}
	select {
	case <-exited:
		t.Fatal("the wait ended by the exit of the service process and not by the stop")
	default:
	}
}

// The exit wait of a sidecar ends the process group of the exited process before it reaps that process, so while the group
// ends the leader is a process of the host that no one reaped and its pid names its group and no other process
// (docs/spec/sidecars.md#declaration-and-startup).
// contract: sidecars.end.group-ends-before-leader-reap
func TestAGroupEndsBeforeItsLeaderIsReaped(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	leader := exec.Command("true")
	if err := current.NewProcessGroup(leader); err != nil {
		t.Fatal(err)
	}
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	pid := leader.Process.Pid
	// The signal 0 reaches a process that exists, and a zombie that no one reaped exists; after the reap the pid names no
	// process.
	exists := func() (bool, error) {
		process, err := os.FindProcess(pid)
		if err != nil {
			return false, err
		}
		switch err := process.Signal(syscall.Signal(0)); {
		case err == nil:
			return true, nil
		case errors.Is(err, os.ErrProcessDone):
			return false, nil
		default:
			return false, err
		}
	}
	var exit processExit
	ended := false
	state, err := exit.endAndReap(leader.Process, current.WaitProcessExit, func() error {
		ended = true
		unreaped, err := exists()
		if err != nil {
			return err
		}
		if !unreaped {
			t.Errorf("the leader %d was reaped before the end of its group", pid)
		}
		return current.EndProcessGroup(pid)
	}, func(err error) { t.Error(err) })
	if err != nil {
		t.Fatalf("reap the leader %d: %v", pid, err)
	}
	if !ended {
		t.Fatal("the exit wait did not end the group")
	}
	if !state.Success() {
		t.Fatalf("the leader %d ended with %v", pid, state)
	}
	if unreaped, err := exists(); err != nil || unreaped {
		t.Fatalf("the leader %d is not reaped after the exit wait: exists %v, %v", pid, unreaped, err)
	}
	if err := exit.signalGroup(func() error {
		t.Error("a signal reached the group after its end")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
