//go:build darwin && cgo && diagnostics

package support

/*
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "event_ring.h"
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// EmitNativeEvent stores the event name with the class (the order of docs/spec/logging.md#classes-and-policy), the level (0 error to 4 trace) and the
// fields (JSON text) in the native event ring of this process through the producer function of the native library, as a native producer does. It is an
// error when the native library refuses the event, which it counts as lost or gated. The test binary links the library statically, as the host of the
// tests does, so the ring is the ring that the host pulls.
func EmitNativeEvent(eventClass, level uint8, name, fields string) error {
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	cfields := C.CString(fields)
	defer C.free(unsafe.Pointer(cfields))
	if !bool(C.sp_event(C.uint8_t(eventClass), C.uint8_t(level), cname, cfields)) {
		return fmt.Errorf("emit native event %q: the native library refused it (class %d, level %d)", name, eventClass, level)
	}
	return nil
}
