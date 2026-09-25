//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "link.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

func (implementation) OpenLink(url string) error {
	value := C.CString(url)
	defer C.free(unsafe.Pointer(value))
	failure := C.sp_link_open(value)
	if failure == nil {
		return nil
	}
	defer C.free(unsafe.Pointer(failure))
	return errors.New(C.GoString(failure))
}
