package host

// The failure of a startup step of the host (docs/spec/hosts.md#process-lifecycle). It ends the process with its message on the
// standard error, the record of the failure in the event log and the status 1, as the Tauri host does for the failure of its
// setup steps.

import (
	"fmt"
	"os"
	"time"
)

// ExitOnFailureWith writes the message of err through write and ends the process through exit with the status 1 when err is not
// nil. The exit function of a test returns.
func ExitOnFailureWith(err error, write func(string), exit func(int)) {
	if err == nil {
		return
	}
	write(err.Error())
	exit(1)
}

// ExitOnFailure ends the process after a failed startup step: the message goes to the standard error and to the application log,
// the log is flushed so that the record is stored, and the status is 1.
func ExitOnFailure(err error) {
	ExitOnFailureWith(err, func(text string) {
		fmt.Fprintln(os.Stderr, text)
		LogError("startup", text)
	}, func(status int) {
		if flushErr := FlushRecords(2 * time.Second); flushErr != nil {
			fmt.Fprintf(os.Stderr, "event writer: the record of the startup failure was not stored: %v\n", flushErr)
		}
		os.Exit(status)
	})
}
