//go:build darwin && diagnostics

package darwin

// Reads and selects the keyboard input source. The implementation is input_source.m of native/darwin. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "input_source.h"
*/
import "C"

import (
	"errors"
	"fmt"
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

// SelectInputSource selects identifier among the enabled input sources. Call it on the main thread.
func (implementation) SelectInputSource(identifier string) error {
	if strings.IndexByte(identifier, 0) >= 0 {
		return errors.New("input source identifier contains NUL")
	}
	wanted := C.CString(identifier)
	defer C.free(unsafe.Pointer(wanted))
	if !bool(C.sp_input_source_select(wanted)) {
		return fmt.Errorf("input source %s is not enabled or could not be selected", identifier)
	}
	return nil
}
