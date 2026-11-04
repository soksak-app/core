//go:build darwin

package darwin

import (
	"unsafe"

	"github.com/egoist/mygo"

	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
)

// pointer is the address of a C function that the framework gives as an integer.
func pointer(address uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&address)) }

// The functions are installed before any start of the library (docs/spec/hosts.md, main thread of the Wails host).
func init() {
	darwin.InstallMainThread(pointer(mygo.RunOnWorkerAddress()), pointer(mygo.RunOnMainAddress()))
}
