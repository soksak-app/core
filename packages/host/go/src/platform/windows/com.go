//go:build windows

package windows

import (
	"fmt"
	"sync"
	"syscall"
	"unsafe"
)

// The vtable slots of the COM interfaces that this package calls (WebView2.h).
const (
	slotAddRef  = 1
	slotRelease = 2

	// IStream.
	streamRead = 3
	streamSeek = 5

	// ICoreWebView2Controller.
	controllerGetIsVisible = 3
	controllerMoveFocus    = 12

	// ICoreWebView2.
	webviewAddProcessFailed           = 25
	webviewRemoveProcessFailed        = 26
	webviewCapturePreview             = 30
	webviewCallDevToolsProtocolMethod = 36

	// ICoreWebView2ProcessFailedEventArgs.
	processFailedArgsGetKind = 3
)

var procRtlMoveMemory = kernel32.NewProc("RtlMoveMemory")

// readAddress reads the address-sized value at address. The address is memory of COM and not of Go, so Go never turns it into a
// pointer: the system copies the value into a variable of Go.
func readAddress(address uintptr) uintptr {
	var value uintptr
	// default: RtlMoveMemory returns nothing and sets no error.
	procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&value)), address, unsafe.Sizeof(value))
	return value
}

// writeAddress writes value at address, which is memory of COM and not of Go, through a copy of the system.
func writeAddress(address, value uintptr) {
	// default: RtlMoveMemory returns nothing and sets no error.
	procRtlMoveMemory.Call(address, uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
}

// comCall calls slot of the vtable of object.
func comCall(object uintptr, slot int, args ...uintptr) uintptr {
	vtable := readAddress(object)
	method := readAddress(vtable + uintptr(slot)*unsafe.Sizeof(uintptr(0)))
	all := append([]uintptr{object}, args...)
	// default: a COM method reports its failure in the HRESULT that it returns, which every caller checks, not through GetLastError.
	result, _, _ := syscall.SyscallN(method, all...)
	return result
}

// failedResult tells whether an HRESULT is a failure.
func failedResult(result uintptr) bool { return int32(uint32(result)) < 0 }

// resultError names the failure of an HRESULT.
func resultError(name string, result uintptr) error {
	return fmt.Errorf("%s: HRESULT %#08x", name, uint32(result))
}

// completionHandler is a COM object that receives one completion. handlers keeps it for as long as COM holds it, because COM holds an
// address that the collector does not see.
type completionHandler struct {
	vtable *[4]uintptr
	refs   int32
	invoke func(result, value uintptr)
}

var (
	handlersMu sync.Mutex
	handlers   = map[uintptr]*completionHandler{}

	handlerVtables = sync.OnceValue(func() struct{ valued, plain *[4]uintptr } {
		release := syscall.NewCallback(func(this uintptr) uintptr {
			handlersMu.Lock()
			defer handlersMu.Unlock()
			handler := handlers[this]
			if handler == nil {
				return 0
			}
			handler.refs--
			if handler.refs == 0 {
				delete(handlers, this)
			}
			return uintptr(handler.refs)
		})
		addRef := syscall.NewCallback(func(this uintptr) uintptr {
			handlersMu.Lock()
			defer handlersMu.Unlock()
			handler := handlers[this]
			if handler == nil {
				return 0
			}
			handler.refs++
			return uintptr(handler.refs)
		})
		// WebView2 asks a completion handler only for itself, and this object has no other interface to refuse.
		query := syscall.NewCallback(func(this, _, out uintptr) uintptr {
			handlersMu.Lock()
			defer handlersMu.Unlock()
			if handler := handlers[this]; handler != nil {
				handler.refs++
			}
			writeAddress(out, this)
			return 0
		})
		run := func(this, result, value uintptr) uintptr {
			handlersMu.Lock()
			handler := handlers[this]
			handlersMu.Unlock()
			if handler != nil {
				handler.invoke(result, value)
			}
			return 0
		}
		return struct{ valued, plain *[4]uintptr }{
			valued: &[4]uintptr{query, addRef, release, syscall.NewCallback(func(this, result, value uintptr) uintptr { return run(this, result, value) })},
			plain:  &[4]uintptr{query, addRef, release, syscall.NewCallback(func(this, result uintptr) uintptr { return run(this, result, 0) })},
		}
	})
)

// newHandler returns the address of a COM object with vtable, which holds one reference for the caller.
func newHandler(vtable *[4]uintptr, invoke func(result, value uintptr)) uintptr {
	handler := &completionHandler{vtable: vtable, refs: 1, invoke: invoke}
	address := uintptr(unsafe.Pointer(handler))
	handlersMu.Lock()
	handlers[address] = handler
	handlersMu.Unlock()
	return address
}
