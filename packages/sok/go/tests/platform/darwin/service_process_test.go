//go:build darwin

package darwin

import (
	"fmt"
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/soksak-app/core/packages/sok/go/src/platform"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/darwin"
)

// contract: sidecars-transport.endpoint.zombie-service-does-not-exist
func TestAZombieServiceProcessDoesNotExist(t *testing.T) {
	// A spawn that was not waited for stays as a zombie. kill(pid, 0) passes a zombie (V5-106), so a zombie does not exist: the
	// decision to discard a stale endpoint and respawn must not be blocked by a zombie.
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
	if err := current.WaitProcessEnd(sleep.Process.Pid); err != nil {
		t.Fatalf("the killed sleep did not end: %v", err)
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
