// Termination signal tests. A signal affects the whole process, so it is checked in a child process.
package host_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// terminationChild is the environment variable that tells that the process is a child process.
const terminationChild = "SOKSAK_TERMINATION_CHILD"

// terminationStart is the environment variable that names the configuration folder of a child that runs the start of the host.
const terminationStart = "SOKSAK_TERMINATION_START"

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

// contract: termination.signal.first-requests-quit-second-ends-process
// The host waits for the start of the application before it requests the quit of a signal, so the start ends that wait.
func TestATerminationSignalAfterTheStartQuitsTheFramework(t *testing.T) {
	directory := t.TempDir()
	command := exec.Command(os.Args[0])
	command.Env = append(os.Environ(), terminationStart+"="+directory)
	output, err := command.Output()
	if err == nil && string(output) == "quit requested\n" {
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
	t.Fatalf("child ended with %v, output %q", err, output)
}

// quitAfterTheStart runs the start of the host with quitFramework, delivers the termination signal and reports whether the
// framework received the quit. The start of the host runs on the main thread, so TestMain calls it.
func quitAfterTheStart(directory string) {
	quit := make(chan struct{})
	session, err := host.Prepare(quitFramework{quit: quit}, fstest.MapFS{
		"frontend/background.js":                            {},
		"frontend/modules/@soksak/plugin-api/view-start.js": {},
		"frontend/view-imports.json":                        {Data: []byte("{}")},
	}, host.Options{ConfigDir: directory})
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	defer session.End()
	if err := session.Open(); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	session.Started()[0]()
	select {
	case <-quit:
		fmt.Println("the start failed:", session.Finish(nil))
		return
	default:
	}
	self, err := os.FindProcess(os.Getpid())
	if err == nil {
		err = self.Signal(syscall.SIGTERM)
	}
	if err != nil {
		fmt.Println(err)
		return
	}
	select {
	case <-quit:
		fmt.Println("quit requested")
	case <-time.After(5 * time.Second):
		fmt.Println("the framework received no quit")
	}
}

// quitFramework is the framework of the start of the host without an application. A step of the main thread is a native call that
// needs the application, so it does not run.
type quitFramework struct {
	host.Framework
	quit chan struct{}
}

func (quitFramework) ApplicationName() string { return "termination-test" }
func (quitFramework) MainPage() bool          { return true }
func (quitFramework) DisplayName() string     { return "Test" }
func (quitFramework) Step(func())             {}
func (quitFramework) RecordSteps(func(host.StepRecord), func(uint64)) func() {
	return nil
}
func (quitFramework) Post(func())               {}
func (quitFramework) SetMenu([]host.Menu) error { return nil }
func (f quitFramework) Quit()                   { close(f.quit) }
func (quitFramework) NewWindow(options host.WindowOptions) host.Frontend {
	return quitWindow{name: options.Name}
}

// quitWindow is a window that has no native window, as a window has before the application runs.
type quitWindow struct {
	host.Frontend
	name string
}

func (quitWindow) Frames() *host.WindowFrames { return nil }

func (quitWindow) ID() uint                               { return 1 }
func (w quitWindow) Name() string                         { return w.name }
func (quitWindow) NativeWindow() platform.Window          { return 0 }
func (quitWindow) OnWindowEvent(host.WindowEvent, func()) {}
func (quitWindow) OnClosing(func() bool)                  {}
func (quitWindow) IsFocused() bool                        { return false }
func (quitWindow) Emit(string, ...any)                    {}

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

// contract: log.closed.cause-before-quit
func TestAQuitStoresItsCauseBeforeItRuns(t *testing.T) {
	log := useEventLog(t)
	var fields any
	host.QuitWithCause("quit-command", func() {
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		for _, event := range readEventLog(t, log.Path()) {
			if event["event"] == "log.closed" {
				fields = event["fields"]
			}
		}
	})
	if cause, _ := fields.(map[string]any); cause == nil || cause["cause"] != "quit-command" {
		t.Fatalf("log.closed before quit = %v, want the cause quit-command", fields)
	}
}
