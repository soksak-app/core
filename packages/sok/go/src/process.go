package sok

import (
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/soksak-app/core/packages/sok/go/src/platform"
)

var processWaitBooleans = map[string]bool{"help": true}
var processWaitOptions = map[string]bool{"config-dir": true}

// runProcess runs the process commands that do not connect to an application endpoint.
func runProcess(args []string, stdout io.Writer) error {
	if len(args) == 1 && args[0] == "--help" {
		_, err := fmt.Fprintln(stdout, Usage)
		return err
	}
	if len(args) == 0 {
		return usage("process requires an action")
	}
	if args[0] != "wait" {
		return usage("unknown command: process %s", strings.Join(args, " "))
	}
	return runProcessWait(args[1:], stdout)
}

// runProcessWait parses the command-specific flags and waits for the operating system to report the process ID ended.
func runProcessWait(args []string, stdout io.Writer) error {
	parsed, err := parseAllowed(args, processWaitBooleans, processWaitOptions)
	if err != nil {
		return err
	}
	if parsed.flags["help"] {
		_, err := fmt.Fprintln(stdout, Usage)
		return err
	}
	if len(parsed.positionals) == 0 {
		return usage("process wait requires a pid")
	}
	if len(parsed.positionals) > 1 {
		return usage("unexpected argument %s", parsed.positionals[1])
	}
	pidText := parsed.positionals[0]
	if !decimalDigits(pidText) {
		return usage("pid must be an integer from 1 to 2147483647")
	}
	parsedPID, err := strconv.ParseUint(pidText, 10, 31)
	if err != nil || parsedPID == 0 {
		return usage("pid must be an integer from 1 to 2147483647")
	}
	current, err := platform.Current()
	if err != nil {
		return fmt.Errorf("process wait: %w", err)
	}
	// The signals are watched before the wait starts, so a signal while the process runs always ends the wait. The wait runs
	// in its own goroutine, and the first of its end and a signal ends the command; a wait that a signal ended is left to
	// the end of the process of sok.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	ended := make(chan error, 1)
	Go("process-wait", func() { ended <- current.WaitProcessEnd(int(parsedPID)) })
	select {
	case received := <-signals:
		return fmt.Errorf("process %d wait was interrupted by %s", parsedPID, signalName(received))
	case err := <-ended:
		if err != nil {
			return fmt.Errorf("process wait: %w", err)
		}
	}
	return printJSON(stdout, map[string]any{"pid": int(parsedPID), "ended": true})
}

// signalName is the name of an interrupt signal as the specification writes it.
func signalName(received os.Signal) string {
	if received == syscall.SIGTERM {
		return "SIGTERM"
	}
	return "SIGINT"
}

func decimalDigits(text string) bool {
	if text == "" {
		return false
	}
	for _, char := range text {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
