//go:build darwin

package darwin

import (
	"fmt"
	"syscall"
	"time"
)

// ProcessorTime returns the processor time, user and system, that this process used, from getrusage with RUSAGE_SELF
// (sys/resource.h). The error names the failed call, which the Rust host also names.
func (implementation) ProcessorTime() (time.Duration, error) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, fmt.Errorf("getrusage: %w", err)
	}
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano()), nil
}
