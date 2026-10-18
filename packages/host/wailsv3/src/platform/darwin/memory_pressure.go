//go:build darwin

package darwin

// The memory pressure owner of the process (docs/spec/hosts.md#memory-pressure). The implementation is memory_pressure.m of
// native/darwin.

/*
#include <stdbool.h>
#include <stdlib.h>
#include "memory_pressure.h"

extern void goMemoryPressure(char *level, unsigned long long seq);
static bool startMemoryPressure(void) {
    return sp_memory_pressure_start(^(const char *level, unsigned long long seq) { goMemoryPressure((char *)level, seq); });
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// memoryPressureReport is the function that each report of the memory pressure source calls.
var memoryPressureReport func(level string, seq uint64)

//export goMemoryPressure
func goMemoryPressure(level *C.char, seq C.ulonglong) {
	memoryPressureReport(C.GoString(level), uint64(seq))
}

func (implementation) OnMemoryPressure(report func(level string, seq uint64)) error {
	memoryPressureReport = report
	if !C.startMemoryPressure() {
		return errors.New("failed to start the memory pressure source")
	}
	return nil
}

func (implementation) InjectMemoryPressure(level string) error {
	text := C.CString(level)
	defer C.free(unsafe.Pointer(text))
	if !C.sp_memory_pressure_inject(text) {
		return errors.New("the memory pressure source did not accept the level " + level)
	}
	return nil
}
