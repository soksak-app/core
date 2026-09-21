//go:build darwin

package darwin

/*
#include "ui_queue.h"
extern void nativeUIRun(uintptr_t context);
*/
import "C"

import "runtime/cgo"

func (implementation) EnqueueUI(work func()) error {
	handle := cgo.NewHandle(work)
	C.sp_ui_enqueue((*[0]byte)(C.nativeUIRun), C.uintptr_t(handle))
	return nil
}

//export nativeUIRun
func nativeUIRun(context C.uintptr_t) {
	handle := cgo.Handle(context)
	work := handle.Value().(func())
	handle.Delete()
	work()
}
