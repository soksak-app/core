package host_test

import (
	"os/exec"
	"testing"
	"time"

	platform "github.com/soksak-app/core/packages/host/wailsv3/src/platform"
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
	time.AfterFunc(150*time.Millisecond, func() { ending.Process.Kill() })
	started := time.Now()
	ended, err := current.WaitServiceProcessEnd(ending.Process.Pid, 10*time.Second)
	if err != nil || !ended || time.Since(started) > 5*time.Second {
		t.Fatalf("a process that ends within the timeout: ended %v after %v, %v", ended, time.Since(started), err)
	}
	ending.Wait()
	running := exec.Command("sleep", "30")
	if err := running.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
	defer func() { running.Process.Kill(); running.Wait() }()
	if ended, err := current.WaitServiceProcessEnd(running.Process.Pid, 200*time.Millisecond); err != nil || ended {
		t.Fatalf("a process that keeps running: ended %v, %v", ended, err)
	}
	if ended, err := current.WaitServiceProcessEnd(ending.Process.Pid, time.Second); err != nil || !ended {
		t.Fatalf("a process that does not exist: ended %v, %v", ended, err)
	}
}
