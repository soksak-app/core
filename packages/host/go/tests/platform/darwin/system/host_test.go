//go:build darwin

package system_test

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// agentVariablesStart is the environment variable that names the configuration folder of a child that runs the start of the host and
// then starts a process.
const agentVariablesStart = "SOKSAK_AGENT_VARIABLES_START"

// The child inherits SOKSAK_CONFIG_DIR of another application, runs the start of the host and then starts a process, as the host
// starts the sok of an application update or a sidecar; that process does not hold the variable.
// contract: host.environment.removes-the-agent-variable
func TestTheStartRemovesTheAgentVariableBeforeItStartsAProcess(t *testing.T) {
	directory := t.TempDir()
	command := exec.Command(os.Args[0])
	// The start makes the socket folder `soksak` in the temporary folder of the child and keeps it, so the child gets a folder of the test.
	command.Env = append(os.Environ(), agentVariablesStart+"="+directory, "TMPDIR="+support.SocketParent(t),
		"SOKSAK_CONFIG_DIR=/other/config")
	output, err := command.Output()
	if err == nil && string(output) == "SOKSAK_CONFIG_DIR: absent\n" {
		return
	}
	// The start moves the standard error of the child to the files of its logs folder.
	files, failure := filepath.Glob(filepath.Join(directory, "logs", "host-*.[sc]*"))
	if failure != nil {
		t.Fatal(failure)
	}
	for _, file := range files {
		text, failure := os.ReadFile(file)
		if failure != nil {
			t.Fatal(failure)
		}
		t.Logf("%s: %s", filepath.Base(file), text)
	}
	t.Fatalf("child ended with %v, output %q, want the variable absent", err, output)
}

// environmentAfterTheStart runs the start of the host, then starts /usr/bin/printenv for SOKSAK_CONFIG_DIR and prints its value or
// `absent`. The start of the host runs on the main thread, so TestMain calls it.
func environmentAfterTheStart(directory string) {
	session, err := host.Prepare(quitFramework{quit: make(chan struct{})}, startAssets(), host.Options{ConfigDir: directory})
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	defer session.End()
	name := "SOKSAK_CONFIG_DIR"
	value, err := exec.Command("/usr/bin/printenv", name).Output()
	var exit *exec.ExitError
	switch {
	case err == nil:
		fmt.Printf("%s: %s", name, value)
	// printenv ends with the status 1 for a variable that the environment does not hold.
	case errors.As(err, &exit) && exit.ExitCode() == 1:
		fmt.Printf("%s: absent\n", name)
	default:
		fmt.Println(err)
		os.Exit(2)
	}
}
