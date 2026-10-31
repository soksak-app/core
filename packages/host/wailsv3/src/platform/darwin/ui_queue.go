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
static void uiEnqueueAfter(uint64_t delay, uintptr_t context) { sp_ui_enqueue_after(delay, nativeUIRun, context); }
*/
import "C"

import (
	"fmt"
	"runtime/cgo"
	"time"
)

func (implementation) EnqueueUI(work func()) error {
	handle := cgo.NewHandle(work)
	C.uiEnqueue(C.uintptr_t(handle))
	return nil
}

func (implementation) EnqueueUIAfter(delay time.Duration, work func()) error {
	if delay < 0 {
		return fmt.Errorf("UI queue delay %s is negative", delay)
	}
	handle := cgo.NewHandle(work)
	C.uiEnqueueAfter(C.uint64_t(delay.Nanoseconds()), C.uintptr_t(handle))
	return nil
}

//export goNativeUIRun
func goNativeUIRun(context C.uintptr_t) {
	handle := cgo.Handle(context)
	work := handle.Value().(func())
	handle.Delete()
	work()
}
