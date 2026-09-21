//go:build darwin && diagnostics

package darwin

// 창을 녹화한다. 녹화 구현은 native/darwin 의 capture.m 이다. 진단 빌드에만 들어간다.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "capture.h"
#import <Cocoa/Cocoa.h>

// 이 창과 이 창에 붙은 창의 윈도 서버 번호를 최대 max 개 기록하고 기록한 수를 반환한다.
// 캡처 도구는 이 번호로 창을 지정하므로, 창을 앞으로 옮기지 않고 윈도 서버가 합성한
// 페이지, 표면과 모달을 읽는다. 이 앱의 창 번호가 처음이다.
static int windowNumbers(void* nsWindow, long* out, int max) {
    NSWindow* window = (NSWindow*)nsWindow;
    if (window == nil || max <= 0) return 0;
    int n = 0;
    out[n++] = (long)[window windowNumber];
    for (NSWindow* child in [window childWindows]) {
        if (n >= max) break;
        out[n++] = (long)[child windowNumber];
    }
    return n;
}
*/
import "C"

import "unsafe"

func (implementation) WindowNumbers(window unsafe.Pointer) ([]int, error) {
	var buf [32]C.long
	n := int(C.windowNumbers(window, &buf[0], C.int(len(buf))))
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = int(buf[i])
	}
	return out, nil
}

func (implementation) CaptureOpen(windowNumber int, display bool) error {
	C.sp_capture_open(C.long(windowNumber), C.bool(display))
	return nil
}

func (implementation) CaptureStart(directory string) error {
	where := C.CString(directory)
	defer C.free(unsafe.Pointer(where))
	C.sp_capture_start(where)
	return nil
}

func (implementation) CaptureStop(after float64) (int, error) {
	return int(C.sp_capture_stop(C.double(after))), nil
}

func (implementation) CaptureWait() (bool, error) { return C.sp_capture_wait() != 0, nil }

func (implementation) CaptureLimited() bool { return bool(C.sp_capture_limited()) }

func (implementation) CaptureLongestGap() float64 { return float64(C.sp_capture_longest_gap()) }
