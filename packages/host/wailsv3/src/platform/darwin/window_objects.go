//go:build darwin && diagnostics

package darwin

// Counts the live library objects attached to windows and web views. The implementation is window_objects.m of native/darwin. It is included only in
// diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include "window_objects.h"
#include "main_thread.h"

// The callback runs its Go function on the worker, and the native call runs on the main thread (main_thread.h).
extern void goWindowObjectsCounted(uintptr_t handle, long compositions, long hosts, long registrations, bool reached);
static void counted(void *context, const sp_window_objects *counts, bool reached) {
    long compositions = counts->windowCompositions, hosts = counts->surfaceHosts, registrations = counts->inputRegistrations;
    wailsRunOnWorker(^{ goWindowObjectsCounted((uintptr_t)context, compositions, hosts, registrations, reached); });
}
static void countWhen(const sp_window_objects *expected, double seconds, uintptr_t handle) {
    wailsRunOnMain(^{ sp_window_objects_when(expected, seconds, counted, (void *)handle); });
}
*/
import "C"

import (
	"runtime/cgo"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

//export goWindowObjectsCounted
func goWindowObjectsCounted(handle C.uintptr_t, compositions, hosts, registrations C.long, reached C.bool) {
	// handle is the value that WindowObjectsWhen created, and the library calls done once.
	h := cgo.Handle(handle)
	done := h.Value().(func(platform.WindowObjects, bool))
	h.Delete()
	done(platform.WindowObjects{
		WindowCompositions: int64(compositions),
		SurfaceHosts:       int64(hosts),
		InputRegistrations: int64(registrations),
	}, bool(reached))
}

// WindowObjectsWhen gives done the count at the time when the count becomes equal to expected after the application handled one event, or when seconds pass.
// Call it in a main-thread step.
func (implementation) WindowObjectsWhen(expected *platform.WindowObjects, seconds float64,
	done func(platform.WindowObjects, bool)) {
	var wanted *C.sp_window_objects
	if expected != nil {
		wanted = &C.sp_window_objects{
			windowCompositions: C.long(expected.WindowCompositions),
			surfaceHosts:       C.long(expected.SurfaceHosts),
			inputRegistrations: C.long(expected.InputRegistrations),
		}
	}
	C.countWhen(wanted, C.double(seconds), C.uintptr_t(cgo.NewHandle(done)))
}
