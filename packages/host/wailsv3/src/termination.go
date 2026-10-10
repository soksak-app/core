package host

import "github.com/soksak-app/core/packages/host/wailsv3/src/platform"

// OnTermination makes quit be called once when a termination request of the operating system is received. A later termination
// request ends the process with the default action of the operating system.
func OnTermination(quit func()) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.OnTermination(quit)
}
