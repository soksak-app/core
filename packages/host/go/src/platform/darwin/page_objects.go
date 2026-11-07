//go:build darwin && diagnostics

package darwin

// Counts the elements and documents of a web view. The implementation is sp_webview_count_objects of native/darwin, which evaluates the count in
// the page content world or in the content world of document regions. It is included only in diagnostic builds.

import (
	"errors"

	"unsafe"

	handles "github.com/soksak-app/core/packages/host/go/src/callback"
)

func goHost_page_objects_counted(handle uintptr, elements, documents int64, failure *byte) {
	// handle is the value that CountPageObjects created, and the library calls done once.
	h := handles.Handle(handle)
	done := h.Value().(func(int64, int64, error))
	h.Delete()
	if failure != nil {
		done(0, 0, errors.New(native.GoString(failure)))
		return
	}
	done(int64(elements), int64(documents), nil)
}

// CountPageObjects evaluates the counts of view and gives done the result. Call it in a main-thread step.
func (implementation) CountPageObjects(view unsafe.Pointer, document bool, done func(elements, documents int64, err error)) {
	diagnosticNative.CountPageObjects(view, bool(document), uintptr(handles.NewHandle(done)))
}
