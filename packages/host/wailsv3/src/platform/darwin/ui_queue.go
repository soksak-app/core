//go:build darwin

package darwin

/*
#include "ui_queue.h"
#include "main_thread.h"

// The main queue runs the step in C: the work runs on the worker while the main thread waits (main_thread.h).
extern void goNativeUIRun(uintptr_t context);
static void nativeUIRun(uintptr_t context) {
    wailsRunOnWorker(^{ goNativeUIRun(context); });
}
static void uiEnqueue(uintptr_t context) { sp_ui_enqueue(nativeUIRun, context); }
*/
import "C"

import "runtime/cgo"

func (implementation) EnqueueUI(work func()) error {
	handle := cgo.NewHandle(work)
	C.uiEnqueue(C.uintptr_t(handle))
	return nil
}

//export goNativeUIRun
func goNativeUIRun(context C.uintptr_t) {
	handle := cgo.Handle(context)
	work := handle.Value().(func())
	handle.Delete()
	work()
}
