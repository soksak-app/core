package host

import (
	"fmt"
	"os"
	"syscall"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// OnTermination makes quit be called once when a termination request of the operating system is received. A later termination
// request ends the process with the default action of the operating system.
func OnTermination(quit func()) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.OnTermination(func(value os.Signal) {
		// The record of the signal is queued before quit runs, so it precedes the flush that the quit ends with.
		if number, ok := value.(syscall.Signal); ok {
			code := int(number)
			EmitClosed("signal", &code)
		} else {
			fmt.Fprintf(os.Stderr, "event writer: log.closed (signal) cannot be stored: the signal %v is not a system signal\n", value)
			EmitClosed("signal", nil)
		}
		quit()
	})
}
