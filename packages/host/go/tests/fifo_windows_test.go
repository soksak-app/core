// The FIFO and the process checks on Windows, a held platform: Windows has no FIFO path and no signal check of a process.
package host_test

import "errors"

// makeFifo fails: Windows has no FIFO path.
func makeFifo(string) error {
	return errors.New("a FIFO path is not supported on windows")
}

// processAbsent fails: Windows has no signal check of a process.
func processAbsent(int) error {
	return errors.New("the signal check of a process is not supported on windows")
}
