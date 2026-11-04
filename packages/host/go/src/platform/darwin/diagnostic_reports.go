//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "diagnostic_reports.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

func (implementation) DiagnosticReportsDirectory() (string, error) {
	var failure *C.char
	directory := C.sp_diagnostic_reports_directory(&failure)
	if directory == nil {
		defer C.free(unsafe.Pointer(failure))
		return "", errors.New(C.GoString(failure))
	}
	defer C.free(unsafe.Pointer(directory))
	return C.GoString(directory), nil
}
