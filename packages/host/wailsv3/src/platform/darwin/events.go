//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "event_ring.h"
#include "activity_observers.h"
#include "observe.h"
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func (implementation) PullNativeEvents(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, fmt.Errorf("pull native events: the buffer is empty")
	}
	return int(C.sp_event_drain((*C.uint8_t)(unsafe.Pointer(&buffer[0])), C.size_t(len(buffer)))), nil
}

func (implementation) TakeNativeEventLoss(channel uint8) (uint64, uint64, error) {
	loss := C.sp_event_take_loss(C.uint8_t(channel))
	return uint64(loss.events), uint64(loss.bytes), nil
}

func (implementation) SetNativeEventPolicy(levels [5]int8) error {
	if !bool(C.sp_event_set_policy((*C.int8_t)(unsafe.Pointer(&levels[0])))) {
		return fmt.Errorf("set native event policy: the native library refused %v (a level is -1 to 4)", levels)
	}
	return nil
}

func (implementation) MonotonicNanos() (uint64, error) {
	return uint64(C.sp_mono_ns()), nil
}

func (implementation) SetEventBoot(boot string) error {
	cboot := C.CString(boot)
	defer C.free(unsafe.Pointer(cboot))
	if !bool(C.sp_event_set_boot(cboot)) {
		return fmt.Errorf("set event boot: the native library refused %q (letters, digits, '-' and '_', at most 64 bytes)", boot)
	}
	return nil
}

func (implementation) FlushNativeObservers() error {
	C.sp_observe_flush()
	return nil
}

func (implementation) ObserveActivity() error {
	C.sp_observe_activity()
	return nil
}
