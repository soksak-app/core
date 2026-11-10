package host_test

import (
	"errors"
	"os/exec"
	"testing"
	"time"

	platform "github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: sidecars-transport.endpoint.zombie-service-does-not-exist
func TestAZombieServiceProcessDoesNotExist(t *testing.T) {
	// A spawn that was not waited for stays as a zombie. kill(pid, 0) passes a zombie (V5-106), so
	// a zombie does not exist: the decision to discard a stale endpoint and respawn must not
	// be blocked by a zombie.
	sleep := exec.Command("sleep", "30")
	if err := sleep.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
	if err := sleep.Process.Kill(); err != nil {
		t.Fatalf("kill sleep failed: %v", err)
	}
	// Waits for it to become a zombie: the parent did not wait, so it stays in the table after it dies.
	time.Sleep(100 * time.Millisecond)
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	exists, err := current.ServiceProcessExists(sleep.Process.Pid)
	if err != nil {
		t.Fatalf("inspect the zombie: %v", err)
	}
	if exists {
		t.Fatal("a zombie service process must not exist")
	}
	if err := sleep.Wait(); err == nil {
		t.Fatal("the killed sleep exited successfully")
	}
}

// The signal check is refused for a process of another user. A refusal (EPERM) means that a process with that number exists, so that service
// process exists.
// contract: sidecars-transport.endpoint.foreign-service-process-exists
func TestAServiceProcessOfAnotherUserExists(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	// 1 is launchd, which root runs.
	exists, err := current.ServiceProcessExists(1)
	if err != nil {
		t.Fatalf("inspect process 1: %v", err)
	}
	if !exists {
		t.Fatal("process 1 of another user must exist")
	}
}

// The wait for a service process ends by the exit of the process or by its stop, and by no time limit: the exit
// answers ended, the stop answers not ended, and a process that does not exist has ended.
// contract: sidecars-transport.endpoint.waits-for-the-end-of-a-service-process
func TestTheWaitForTheEndOfAServiceProcess(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	ending := exec.Command("sleep", "30")
	if err := ending.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
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
	running := exec.Command("sleep", "30")
	if err := running.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
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
