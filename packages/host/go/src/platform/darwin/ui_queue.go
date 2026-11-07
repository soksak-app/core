//go:build darwin

package darwin

/*
#include "ui_queue.h"
#include "main_thread.h"

// The main queue runs the step in C: the work runs on the worker while the main thread waits (main_thread.h).
extern void goNativeUIRun(uintptr_t context);
static void nativeUIRun(uintptr_t context) {
    hostRunOnWorker(^{ goNativeUIRun(context); });
}
static void uiEnqueue(uintptr_t context) { sp_ui_enqueue(nativeUIRun, context); }
static void uiEnqueueAfter(uint64_t delay, uintptr_t context) { sp_ui_enqueue_after(delay, nativeUIRun, context); }
static void installMainThread(uintptr_t worker, uintptr_t main) {
    hostInstallMainThread((void (*)(void (^)(void)))worker, (void (*)(void (^)(void)))main);
}
static void mainThreadInstalled(bool *worker, bool *main) { hostMainThreadInstalled(worker, main); }
*/
import "C"

import (
	"fmt"
	"runtime/cgo"
	"strings"
	"time"
)

// InstallMainThread installs the main-thread functions of the framework (main_thread.h), given as the addresses of the C functions.
// A framework adapter calls it before the start of the library.
func InstallMainThread(worker, main uintptr) {
	C.installMainThread(C.uintptr_t(worker), C.uintptr_t(main))
}

func (implementation) RequireMainThread() error {
	var worker, main C.bool
	C.mainThreadInstalled(&worker, &main)
	var missing []string
	if !worker {
		missing = append(missing, "hostRunOnWorker")
	}
	if !main {
		missing = append(missing, "hostRunOnMain")
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("main-thread functions are not installed: %s; the framework adapter installs them through darwin.InstallMainThread before the start of the library", strings.Join(missing, " and "))
}

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
