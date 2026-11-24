package host_test

import (
	"errors"
	"os/exec"
	"testing"

	platform "github.com/soksak-app/core/packages/host/go/src/platform"
)

// The wait for a service process ends by the exit of the process or by its stop, and by no time limit: the exit
// answers ended, the stop answers not ended, and a process that does not exist has ended.
// contract: sidecars-transport.endpoint.waits-for-the-end-of-a-service-process
func TestTheWaitForTheEndOfAServiceProcess(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	// The processes read their input, whose write end the check holds, so each runs until the check ends it and ends with the
	// check process also when the check is killed.
	cat := func() *exec.Cmd {
		process := exec.Command("cat")
		if _, err := process.StdinPipe(); err != nil {
			t.Fatal(err)
		}
		if err := process.Start(); err != nil {
			t.Fatalf("start cat failed: %v", err)
		}
		return process
	}
	ending := cat()
	waited := make(chan error, 1)
	go func() {
		ended, err := current.WaitServiceProcessEnd(ending.Process.Pid, nil)
		if err == nil && !ended {
			err = errors.New("the wait answered that the process did not end")
		}
		waited <- err
	}()
	// The kill is the event that ends the wait; a wait that does not end stops at the limit of the runner.
	if err := ending.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := <-waited; err != nil {
		t.Fatalf("a process that ends: %v", err)
	}
	ending.Wait()
	running := cat()
	defer func() { running.Process.Kill(); running.Wait() }()
	stop := make(chan struct{})
	close(stop)
	if ended, err := current.WaitServiceProcessEnd(running.Process.Pid, stop); err != nil || ended {
		t.Fatalf("a process that keeps running until the stop: ended %v, %v", ended, err)
	}
	if ended, err := current.WaitServiceProcessEnd(ending.Process.Pid, nil); err != nil || !ended {
		t.Fatalf("a process that does not exist: ended %v, %v", ended, err)
	}
}
