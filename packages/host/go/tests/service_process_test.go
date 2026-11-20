package host_test

import (
	"errors"
	"fmt"
	"os/exec"
	"testing"
	"time"

	platform "github.com/soksak-app/core/packages/host/go/src/platform"
	"golang.org/x/sys/unix"
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
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	// The exit event makes it a zombie: the parent did not wait, so it stays in the table after it dies.
	if ended, err := current.WaitServiceProcessEnd(sleep.Process.Pid, nil); err != nil || !ended {
		t.Fatalf("the killed sleep did not end: ended %v, %v", ended, err)
	}
	exists, err := current.ServiceProcessExists(sleep.Process.Pid, time.Now())
	if err != nil {
		t.Fatalf("inspect the zombie: %v", err)
	}
	if exists {
		// The state of the table at the failure: SZOMB is 5 and P_WEXIT is 0x2000 in <sys/proc.h>.
		state := "not listed"
		if processes, err := unix.SysctlKinfoProcSlice("kern.proc.pid", sleep.Process.Pid); err != nil {
			state = err.Error()
		} else if len(processes) > 0 {
			state = fmt.Sprintf("p_stat %d p_flag %#x", processes[0].Proc.P_stat, processes[0].Proc.P_flag)
		}
		t.Fatalf("a process that ended must not exist after its exit event: %s", state)
	}
	if err := sleep.Wait(); err == nil {
		t.Fatal("the killed sleep exited successfully")
	}
}

// A process of another user did not publish the endpoint, although it started before the publication, because the service runs as
// the user of the host.
// contract: sidecars-transport.endpoint.foreign-process-is-not-the-publisher
func TestAProcessOfAnotherUserIsNotThePublisher(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	// 1 is launchd, which root runs.
	exists, err := current.ServiceProcessExists(1, time.Now())
	if err != nil {
		t.Fatalf("inspect process 1: %v", err)
	}
	if exists {
		t.Fatal("process 1 of another user is not the publisher of an endpoint")
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
