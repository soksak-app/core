package sok

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

const processWaitTimeoutMax = 600000

var processWaitBooleans = map[string]bool{"help": true}
var processWaitOptions = map[string]bool{"config-dir": true, "timeout-ms": true}

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
	timeoutText, ok := parsed.values["timeout-ms"]
	if !ok {
		return usage("--timeout-ms is required")
	}
	if !decimalDigits(timeoutText) {
		return usage("timeout must be an integer from 1 to 600000 milliseconds")
	}
	timeoutMS, err := strconv.ParseUint(timeoutText, 10, 64)
	if err != nil || timeoutMS == 0 || timeoutMS > processWaitTimeoutMax {
		return usage("timeout must be an integer from 1 to 600000 milliseconds")
	}
	current, err := platform.Current()
	if err != nil {
		return fmt.Errorf("process wait: %w", err)
	}
	ended, err := current.WaitProcessEnd(int(parsedPID), time.Duration(timeoutMS)*time.Millisecond)
	if err != nil {
		return fmt.Errorf("process wait: %w", err)
	}
	if !ended {
		return fmt.Errorf("process %d did not end within %dms", parsedPID, timeoutMS)
	}
	return printJSON(stdout, map[string]any{"pid": int(parsedPID), "ended": true})
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
