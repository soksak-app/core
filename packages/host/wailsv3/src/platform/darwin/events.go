//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include "event_ring.h"
#include "activity_observers.h"
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

func (implementation) TakeNativeEventLoss() (uint64, uint64, error) {
	loss := C.sp_event_take_loss()
	return uint64(loss.events), uint64(loss.bytes), nil
}

func (implementation) ObserveActivity() error {
	C.sp_observe_activity()
	return nil
}
