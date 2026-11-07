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

func (implementation) OnMemoryPressure(report func(level string, seq uint64)) error {
	memoryPressureReport = report
	if !native.StartMemoryPressure() {
		return errors.New("failed to start the memory pressure source")
	}
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
