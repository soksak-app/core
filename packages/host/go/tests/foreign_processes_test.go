package host_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// The start of a host ends no process: a WebKit process of another application, listed in the record file that an earlier
// run of the host wrote with the host of that run ended, stays alive after the configuration directory is prepared. macOS
// ends the WebKit services of a host when the host ends, so the host keeps no record of them (docs/spec/hosts.md).
// contract: startup.ends-no-process
func TestTheStartEndsNoProcessOfAnotherApplication(t *testing.T) {
	foreign := exec.Command("/bin/sleep", "30")
	foreign.Args[0] = "com.apple.WebKit.Networking"
	started := time.Now()
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	ended := exec.Command("/usr/bin/true")
	if err := ended.Run(); err != nil {
		t.Fatal(err)
	}
	// The record of an earlier run named each child with its start time in the form of ps lstart.
	lstart := started.Format("Mon Jan _2 15:04:05 2006")
	config := t.TempDir()
	type child struct {
		PID    int    `json:"pid"`
		Kind   string `json:"kind"`
		Lstart string `json:"lstart"`
	}
	record, err := json.Marshal(struct {
		HostPID  int     `json:"host_pid"`
		Children []child `json:"children"`
	}{ended.Process.Pid, []child{{foreign.Process.Pid, "Networking", lstart}}})
	if err != nil {
		t.Fatal(err)
	}
	recordFile := filepath.Join(config, "webkit-children.json")
	if err := os.WriteFile(recordFile, record, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := host.PrepareConfigDirectory(config); err != nil {
		t.Fatal(err)
	}
	// The process ends only by a signal. The test sends SIGKILL now, so the wait status names SIGKILL unless the start sent an
	// earlier signal that ended it.
	if err := foreign.Process.Kill(); err != nil {
		t.Fatalf("the start ended process %d of another application: %v", foreign.Process.Pid, err)
	}
	var status syscall.WaitStatus
	if err := foreign.Wait(); err != nil {
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatal(err)
		}
		status = exit.Sys().(syscall.WaitStatus)
	}
	if !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("the start ended process %d of another application (wait status %v)", foreign.Process.Pid, status)
	}
}
