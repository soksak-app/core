//go:build darwin

package darwin

import (
	"errors"
	"unsafe"
)

func (implementation) OpenLink(url string) error {
	value := native.CString(url)
	defer native.Free(unsafe.Pointer(value))
	failure := native.MainSpLinkOpen(value)
	if failure == nil {
		return nil
	}
	defer native.Free(unsafe.Pointer(failure))
	return errors.New(native.GoString(failure))
}
