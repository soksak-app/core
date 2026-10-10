// Termination signal tests. A signal affects the whole process, so it is checked in a child process.
package host_test

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// terminationChild is the environment variable that tells that the process is a child process.
const terminationChild = "SOKSAK_TERMINATION_CHILD"

// contract: termination.signal.first-requests-quit-second-ends-process
func TestTerminationSignalRequestsQuitOnceAndTheNextEndsTheProcess(t *testing.T) {
	if os.Getenv(terminationChild) != "" {
		terminate()
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestTerminationSignalRequestsQuitOnceAndTheNextEndsTheProcess$")
	command.Env = append(os.Environ(), terminationChild+"=1")
	// The child waits while it reads standard input. The parent keeps the writing side open, so it does not end without a signal.
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	output, err := command.Output()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	status := exit.Sys().(syscall.WaitStatus)
	if !status.Signaled() || status.Signal() != syscall.SIGTERM || string(output) != "quit requested\n" {
		t.Fatalf("child status %v, output %q", status, output)
	}
}

// terminate receives the termination signal twice. The first signal calls quit and the second signal ends the process.
func terminate() {
	quit := make(chan struct{})
	if err := host.OnTermination(func() { close(quit) }); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	self, err := os.FindProcess(os.Getpid())
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	if err := self.Signal(syscall.SIGTERM); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	<-quit
	fmt.Println("quit requested")
	if err := self.Signal(syscall.SIGTERM); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	os.Stdin.Read(make([]byte, 1))
	fmt.Println("the second signal did not end the process")
	os.Exit(3)
}
