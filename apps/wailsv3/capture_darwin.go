//go:build darwin

package main

// 이 애플리케이션의 창을 녹화한다. 녹화 구현은 native/darwin 의 capture.m 이다.

/*
#include <stdlib.h>
#include "capture.h"
*/
import "C"

import "unsafe"

func captureOpen(windowNumber int) { C.sp_capture_open(C.long(windowNumber)) }

func captureStart(directory string) {
	where := C.CString(directory)
	defer C.free(unsafe.Pointer(where))
	C.sp_capture_start(where)
}

func captureStop() int  { return int(C.sp_capture_stop()) }
func captureWait() bool { return C.sp_capture_wait() != 0 }
