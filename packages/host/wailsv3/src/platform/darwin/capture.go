//go:build darwin

package darwin

// 창을 녹화한다. 녹화 구현은 native/darwin 의 capture.m 이다.

/*
#include <stdlib.h>
#include "capture.h"
*/
import "C"

import "unsafe"

func (implementation) CaptureOpen(windowNumber int) error {
	C.sp_capture_open(C.long(windowNumber))
	return nil
}

func (implementation) CaptureStart(directory string) error {
	where := C.CString(directory)
	defer C.free(unsafe.Pointer(where))
	C.sp_capture_start(where)
	return nil
}

func (implementation) CaptureStop() (int, error) { return int(C.sp_capture_stop()), nil }

func (implementation) CaptureWait() (bool, error) { return C.sp_capture_wait() != 0, nil }
