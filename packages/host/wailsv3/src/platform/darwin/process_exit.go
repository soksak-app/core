//go:build darwin && diagnostics

package darwin

// 프로세스의 종료를 기다린다. 구현은 native/darwin 의 process_exit.m 이다. 진단 빌드에만 들어간다.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include "process_exit.h"

extern void processExitAnswered(uintptr_t handle, bool exited);
static void answered(void *context, bool exited) { processExitAnswered((uintptr_t)context, exited); }
static void whenExited(pid_t pid, double seconds, uintptr_t handle) {
    sp_process_when_exited(pid, seconds, answered, (void *)handle);
}
*/
import "C"

import "runtime/cgo"

//export processExitAnswered
func processExitAnswered(handle C.uintptr_t, exited C.bool) {
	// handle 은 WhenProcessExited 가 만든 값이고 라이브러리는 done 을 한 번 호출한다.
	h := cgo.Handle(handle)
	done := h.Value().(func(bool))
	h.Delete()
	done(bool(exited))
}

// WhenProcessExited 는 pid 의 프로세스가 끝나거나 seconds 가 지나면 done 에 답한다. 메인 스레드에서 호출한다.
func (implementation) WhenProcessExited(pid int32, seconds float64, done func(bool)) {
	C.whenExited(C.pid_t(pid), C.double(seconds), C.uintptr_t(cgo.NewHandle(done)))
}
