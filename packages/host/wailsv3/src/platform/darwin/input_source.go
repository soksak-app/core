//go:build darwin && diagnostics

package darwin

// Reads and selects the keyboard input source. The implementation is input_source.m of native/darwin. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules -fblocks
#cgo pkg-config: soksak-darwin
#include <stdint.h>
#include <stdlib.h>
#include "input_source.h"

extern void nativeInputSourceAdopted(uintptr_t callback, char *failure);

static void inputSourceSelectAndAwait(const char *identifier, uintptr_t callback) {
    sp_input_source_select_and_await(identifier, ^(const char *error) {
        nativeInputSourceAdopted(callback, (char *)error);
    });
}
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"strings"
	"unsafe"
)

// InputSource returns the identifier of the currently selected keyboard input source. Call it on the main thread.
func (implementation) InputSource() (string, error) {
	pointer := C.sp_input_source_current()
	if pointer == nil {
		return "", errors.New("the selected keyboard input source could not be read")
	}
	defer C.free(unsafe.Pointer(pointer))
	return C.GoString(pointer), nil
}

// SelectInputSource selects identifier and waits for active key-view context adoption. Call it on the main thread.
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

//export nativeInputSourceAdopted
func nativeInputSourceAdopted(value C.uintptr_t, failure *C.char) {
	handle := cgo.Handle(value)
	adopted := handle.Value().(func(error))
	handle.Delete()
	if failure == nil {
		adopted(nil)
		return
	}
	adopted(errors.New(C.GoString(failure)))
}
