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

// The callback runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
extern void goNativeInputSourceAdopted(uintptr_t callback, char *failure);

static void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback) {
    wailsRunOnMain(^{
        sp_input_source_select_and_await(identifier, ^(const char *error) {
            wailsRunOnWorker(^{ goNativeInputSourceAdopted(callback, (char *)error); });
        });
    });
}
static char *main_sp_input_source_current(void) { return ON_MAIN(char *, sp_input_source_current()); }
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"strings"
	"unsafe"
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
	C.inputSourceSelectAndAwait(wanted, C.uintptr_t(cgo.NewHandle(adopted)))
}

//export goNativeInputSourceAdopted
func goNativeInputSourceAdopted(value C.uintptr_t, failure *C.char) {
	handle := cgo.Handle(value)
	adopted := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		adopted(nil)
		return
	}
	adopted(errors.New(C.GoString(failure)))
}
