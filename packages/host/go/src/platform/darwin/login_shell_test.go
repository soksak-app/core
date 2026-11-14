//go:build darwin

package darwin

import (
	"os/exec"
	"os/user"
	"strings"
	"testing"
)

// The login shell is the one that the directory service names for the user of the process (docs/spec/cli.md#agents-in-the-application).
// contract: setup.host.reads-the-login-shell-environment
func TestTheLoginShellIsTheShellOfTheUserDatabase(t *testing.T) {
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("/usr/bin/dscl", ".", "-read", "/Users/"+account.Username, "UserShell").Output()
	if err != nil {
		t.Fatalf("dscl: %v", err)
	}
	want, found := strings.CutPrefix(strings.TrimSpace(string(output)), "UserShell: ")
	if !found {
		t.Fatalf("dscl printed %q", output)
	}
	shell, err := implementation{}.LoginShell()
	if err != nil || shell != want {
		t.Fatalf("LoginShell answered %q, %v; the directory service names %q", shell, err, want)
	}
}
