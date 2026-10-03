//go:build darwin && diagnostics

package darwin

// 창과 웹뷰에 붙인 라이브러리 객체의 살아 있는 수를 센다. 구현은 native/darwin 의 window_objects.m 이다. 진단 빌드에만
// 들어간다.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include "window_objects.h"

extern void windowObjectsCounted(uintptr_t handle, long compositions, long hosts, long registrations, bool reached);
static void counted(void *context, const sp_window_objects *counts, bool reached) {
    windowObjectsCounted((uintptr_t)context, counts->windowCompositions, counts->surfaceHosts, counts->inputRegistrations,
        reached);
}
static void countWhen(const sp_window_objects *expected, double seconds, uintptr_t handle) {
    sp_window_objects_when(expected, seconds, counted, (void *)handle);
}
*/
import "C"

import (
	"runtime/cgo"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

//export windowObjectsCounted
func windowObjectsCounted(handle C.uintptr_t, compositions, hosts, registrations C.long, reached C.bool) {
	// handle 은 WindowObjectsWhen 이 만든 값이고 라이브러리는 done 을 한 번 호출한다.
	h := cgo.Handle(handle)
	done := h.Value().(func(platform.WindowObjects, bool))
	h.Delete()
	done(platform.WindowObjects{
		WindowCompositions: int64(compositions),
		SurfaceHosts:       int64(hosts),
		InputRegistrations: int64(registrations),
	}, bool(reached))
}

// WindowObjectsWhen 은 애플리케이션이 이벤트 하나를 처리한 뒤 수가 expected 와 같아질 때, 또는 seconds 가 지날 때의
// 수를 done 에 준다. 메인 스레드에서 호출한다.
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
