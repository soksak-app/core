//go:build darwin && diagnostics

package darwin

// Counts the elements and documents of a web view. The implementation is sp_webview_count_objects of native/darwin, which evaluates the count in
// the page content world or in the content world of document regions. It is included only in diagnostic builds.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include "webview_geometry.h"

extern void pageObjectsCounted(uintptr_t handle, long elements, long documents, long parked, char *failure);
static void pageCounted(void *context, long elements, long documents, long parked, const char *failure) {
    pageObjectsCounted((uintptr_t)context, elements, documents, parked, (char *)failure);
}
static void countPageObjects(void *view, bool document, uintptr_t handle) {
    sp_webview_count_objects(view, document, pageCounted, (void *)handle);
}
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"unsafe"
)

//export pageObjectsCounted
func pageObjectsCounted(handle C.uintptr_t, elements, documents, parked C.long, failure *C.char) {
	// handle is the value that CountPageObjects created, and the library calls done once.
	h := cgo.Handle(handle)
	done := h.Value().(func(int64, int64, int64, error))
	h.Delete()
	if failure != nil {
		done(0, 0, 0, errors.New(C.GoString(failure)))
		return
	}
	done(int64(elements), int64(documents), int64(parked), nil)
}

// CountPageObjects evaluates the counts of view and gives done the result. Call it on the main thread.
func (implementation) CountPageObjects(view unsafe.Pointer, document bool, done func(elements, documents, parked int64, err error)) {
	C.countPageObjects(view, C.bool(document), C.uintptr_t(cgo.NewHandle(done)))
}
