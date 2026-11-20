//go:build darwin && diagnostics

package darwin

// The action of a person is implemented by sp_input_person in native/darwin.

import (
	"errors"
	"runtime"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// DispatchPersonInput dispatches in the window the event that the window server gives the application for a press, a move or a
// scroll of a person at the point of the content (docs/spec/endpoint.md).
func (implementation) DispatchPersonInput(window platform.Window, action string, x, y float64) error {
	name := append([]byte(action), 0)
	var nativeError *byte
	done := bool(diagnosticNative.MainSpInputPerson(uintptr(window), &name[0], x, y, &nativeError))
	runtime.KeepAlive(name)
	if nativeError != nil {
		defer native.Free(unsafe.Pointer(nativeError))
		return errors.New(native.GoString(nativeError))
	}
	if !done {
		return errors.New("the action of a person failed without a native reason")
	}
	return nil
}
