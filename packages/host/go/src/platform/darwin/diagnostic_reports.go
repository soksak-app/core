//go:build darwin

package darwin

import (
	"errors"
	"unsafe"
)

func (implementation) DiagnosticReportsDirectory() (string, error) {
	var failure *byte
	directory := native.SpDiagnosticReportsDirectory(&failure)
	if directory == nil {
		defer native.Free(unsafe.Pointer(failure))
		return "", errors.New(native.GoString(failure))
	}
	defer native.Free(unsafe.Pointer(directory))
	return native.GoString(directory), nil
}
