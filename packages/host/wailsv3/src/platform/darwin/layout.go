//go:build darwin

package darwin

/*
#include <stdbool.h>
#include <stdint.h>
#include "surface_layout.h"

void nativeWindowLayoutBegin(void *window, uint64_t ticket, uintptr_t callback);
bool nativeWindowAfterSettled(void *window, uintptr_t callback);
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

func (implementation) BeginLayout(window unsafe.Pointer, ticket uint64, ready func(bool)) error {
	handle := cgo.NewHandle(ready)
	C.nativeWindowLayoutBegin(window, C.uint64_t(ticket), C.uintptr_t(handle))
	return nil
}

func (implementation) CommitLayout(window unsafe.Pointer, ticket uint64) bool {
	return bool(C.surfaceLayoutCommit(window, C.uint64_t(ticket)))
}

func (implementation) CancelLayout(window unsafe.Pointer) error {
	C.surfaceLayoutCancel(window)
	return nil
}

//export nativeLayoutReady
func nativeLayoutReady(value C.uintptr_t, allowed C.bool) {
	handle := cgo.Handle(value)
	ready := handle.Value().(func(bool))
	handle.Delete()
	ready(bool(allowed))
}

func (implementation) AfterSettled(window unsafe.Pointer, done func(displayed float64)) error {
	handle := cgo.NewHandle(done)
	if !bool(C.nativeWindowAfterSettled(window, C.uintptr_t(handle))) {
		handle.Delete()
		return errors.New("native presentation is unavailable")
	}
	return nil
}

//export nativeSettledDone
func nativeSettledDone(value C.uintptr_t, displayed C.double) {
	handle := cgo.Handle(value)
	done := handle.Value().(func(float64))
	handle.Delete()
	done(float64(displayed))
}
