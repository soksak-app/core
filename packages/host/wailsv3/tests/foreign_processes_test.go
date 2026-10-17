package host_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// The start of a host ends no process: a WebKit process of another application, listed in the record file that an earlier
// run of the host wrote with the host of that run ended, stays alive after the configuration directory is prepared. macOS
// ends the WebKit services of a host when the host ends, so the host keeps no record of them (docs/spec/hosts.md).
// contract: startup.ends-no-process
func TestTheStartEndsNoProcessOfAnotherApplication(t *testing.T) {
	foreign := exec.Command("/bin/sleep", "30")
	foreign.Args[0] = "com.apple.WebKit.Networking"
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	defer foreign.Wait()
	defer foreign.Process.Kill()
	ended := exec.Command("/usr/bin/true")
	if err := ended.Run(); err != nil {
		t.Fatal(err)
	}
	lstart, err := exec.Command("ps", "-o", "lstart=", "-p", fmt.Sprint(foreign.Process.Pid)).Output()
	if err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	record := fmt.Sprintf(`{"host_pid": %d, "children": [{"pid": %d, "kind": "Networking", "lstart": %q}]}`,
		ended.Process.Pid, foreign.Process.Pid, strings.TrimSpace(string(lstart)))
	if err := os.WriteFile(filepath.Join(config, "webkit-children.json"), []byte(record), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := host.PrepareConfigDirectory(config); err != nil {
		t.Fatal(err)
	}
	state, _ := exec.Command("ps", "-o", "stat=", "-p", fmt.Sprint(foreign.Process.Pid)).Output()
	if s := strings.TrimSpace(string(state)); s == "" || strings.HasPrefix(s, "Z") {
		t.Fatalf("the start ended process %d of another application (state %q)", foreign.Process.Pid, s)
	}
}
