//go:build darwin && diagnostics

package darwin

// Reads and selects the keyboard input source. The implementation is input_source.m of native/darwin. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules -fblocks
#cgo pkg-config: soksak-darwin
#include <stdint.h>
#include <stdlib.h>
#include "input_source.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The callback runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).

static void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback) {
    hostRunOnMain(^{
        sp_input_source_select_and_await(identifier, ^(const char *error) {
            hostRunOnWorker(^{ sp_host_diagnostic_callback_native_input_source_adopted(callback, (char *)error); });
        });
    });
}
static char *main_sp_input_source_current(void) { return ON_MAIN(char *, sp_input_source_current()); }
*/
import "C"

import (
	"errors"

	"strings"
	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
)

// InputSource returns the identifier of the currently selected keyboard input source. Call it in a main-thread step.
func (implementation) InputSource() (string, error) {
	pointer := C.main_sp_input_source_current()
	if pointer == nil {
		return "", errors.New("the selected keyboard input source could not be read")
	}
	defer C.free(unsafe.Pointer(pointer))
	return C.GoString(pointer), nil
}

// SelectInputSource selects identifier and waits for active key-view context adoption. Call it in a main-thread step.
func (implementation) SelectInputSource(identifier string, adopted func(error)) {
	if adopted == nil {
		panic("input source selection requires an adoption callback")
	}
	if strings.IndexByte(identifier, 0) >= 0 {
		adopted(errors.New("input source identifier contains NUL"))
		return
	}
	wanted := C.CString(identifier)
	defer C.free(unsafe.Pointer(wanted))
	C.inputSourceSelectAndAwait(wanted, C.uintptr_t(handles.NewHandle(adopted)))
}

//export goHost_native_input_source_adopted
func goHost_native_input_source_adopted(value C.uintptr_t, failure *C.char) {
	handle := handles.Handle(value)
	adopted := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		adopted(nil)
		return
	}
	adopted(errors.New(C.GoString(failure)))
}
