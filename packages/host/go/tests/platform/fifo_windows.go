package platform

import "errors"

// MakeFifo fails: Windows, a held platform, has no FIFO path.
func MakeFifo(string) error {
	return errors.New("a FIFO path is not supported on windows")
}

// ProcessAbsent fails: Windows, a held platform, has no signal check of a process.
func ProcessAbsent(int) error {
	return errors.New("the signal check of a process is not supported on windows")
}
