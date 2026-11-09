package host

import (
	"fmt"
	"os"
	"syscall"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// OnTermination makes quit be called once when a termination request of the operating system is received, after it begins the quit
// state. A later termination request ends the process with the default action of the operating system.
func OnTermination(state *Quit, quit func()) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.OnTermination(func(value os.Signal, senderPid int) {
		number, ok := value.(syscall.Signal)
		if !ok {
			fmt.Fprintf(os.Stderr, "event writer: log.closed (signal) names no number: the signal %v is not a system signal\n", value)
			number = 0
		}
		QuitFromSignal(state, int(number), senderPid, quit)
	})
}
