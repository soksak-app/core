// Termination signal tests. A signal affects the whole process, so it is checked in a child process.
package host_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// terminationChild is the environment variable that tells that the process is a child process.
const terminationChild = "SOKSAK_TERMINATION_CHILD"

// terminationDirectory is the environment variable that names the configuration folder of the child that records its end.
const terminationDirectory = "SOKSAK_TERMINATION_DIRECTORY"

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
	if err := host.OnTermination(&host.Quit{}, func() { close(quit) }); err != nil {
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

// contract: log.closed.signal-before-quit
func TestTerminationSignalRecordsLogClosedBeforeQuit(t *testing.T) {
	if os.Getenv(terminationChild) != "" {
		recordClosedOnSignal(t, os.Getenv(terminationDirectory))
		return
	}
	directory := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestTerminationSignalRecordsLogClosedBeforeQuit$")
	command.Env = append(os.Environ(), terminationChild+"=1", terminationDirectory+"="+directory)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	if !strings.Contains(string(output), `log.closed: {"cause":"signal","signal":15}`) {
		t.Fatalf("output %q", output)
	}
}

// recordClosedOnSignal receives the termination signal of the child, which stores its event log with the default policy.
// The record of the signal is stored before quit is requested, so it is in the log when quit has been requested.
func recordClosedOnSignal(t *testing.T, directory string) {
	log, err := host.StartEventLog(eventLogOptions(directory))
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	quit := make(chan struct{})
	if err := host.OnTermination(&host.Quit{}, func() { close(quit) }); err != nil {
		t.Fatal(err)
	}
	self, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if err := self.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	<-quit
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(nil)
	log.Close()
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "log.closed" {
			fields, err := json.Marshal(event["fields"])
			if err != nil {
				t.Fatal(err)
			}
			fmt.Printf("log.closed: %s\n", fields)
			return
		}
	}
	fmt.Println("log.closed: none")
}

// contract: termination.signal.begins-the-quit-state
// The first termination signal begins the quit state before it requests the quit, so the end of a page process during that quit
// writes no error line (docs/spec/hosts.md#process-lifecycle).
func TestTerminationSignalBeginsTheQuitStateBeforeQuit(t *testing.T) {
	if os.Getenv(terminationChild) != "" {
		quitDuringSignal()
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestTerminationSignalBeginsTheQuitStateBeforeQuit$")
	command.Env = append(os.Environ(), terminationChild+"=1")
	output, err := command.Output()
	var exit *exec.ExitError
	if err == nil {
		return
	}
	if !errors.As(err, &exit) {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	t.Fatalf("child status %v, output %q", exit.Sys(), output)
}

// quitDuringSignal delivers the termination signal and then reports whether the end of a page process during that quit is written.
func quitDuringSignal() {
	var state host.Quit
	quit := make(chan struct{})
	if err := host.OnTermination(&state, func() { close(quit) }); err != nil {
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
	if place, text, reported := host.PageProcessEnded("main", state.Active()); reported {
		fmt.Printf("the end of a page process during the quit is written: %s\n", host.ErrorLine(place, text))
		os.Exit(3)
	}
	fmt.Println("quit requested")
	os.Exit(0)
}
