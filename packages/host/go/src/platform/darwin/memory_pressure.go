//go:build darwin

package darwin

// The memory pressure owner of the process (docs/spec/hosts.md#memory-pressure). The implementation is memory_pressure.m of
// native/darwin.

import (
	"errors"
	"unsafe"
)

// memoryPressureReport is the function that each report of the memory pressure source calls.
var memoryPressureReport func(level string, seq uint64)

func goHost_memory_pressure(level *byte, seq uint64) {
	memoryPressureReport(native.GoString(level), uint64(seq))
}

// OnMemoryPressure starts the source of the process and sets report after the start succeeds: the native owner keeps one source,
// so a refused start leaves the report of the running source in place. The source reports on the main queue, so no report runs
// before the function is set.
func (implementation) OnMemoryPressure(report func(level string, seq uint64)) error {
	if !native.StartMemoryPressure() {
		return errors.New("failed to start the memory pressure source")
	}
	memoryPressureReport = report
	return nil
}

func (implementation) InjectMemoryPressure(level string) error {
	text := native.CString(level)
	defer native.Free(unsafe.Pointer(text))
	if !native.MainSpMemoryPressureInject(text) {
		return errors.New("the memory pressure source did not accept the level " + level)
	}
	return nil
}
