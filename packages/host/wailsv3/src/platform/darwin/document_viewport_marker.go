//go:build darwin && diagnostics

package darwin

// The diagnostic viewport marker is implemented by sp_document_viewport_marker in native/darwin.

/*
#cgo CFLAGS: -x objective-c -fmodules -DSOKSAK_DIAGNOSTIC
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include "document_view.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

// SetDocumentViewportMarker changes the border of the document's native view. Call it on the UI thread.
func (implementation) SetDocumentViewportMarker(document unsafe.Pointer, enabled bool) ([3]uint8, float64, error) {
	var rgb [3]C.uint8_t
	var borderWidth C.double
	var nativeError *C.char
	changed := bool(C.sp_document_viewport_marker(document, C.bool(enabled), &rgb[0], &borderWidth, &nativeError))
	if nativeError != nil {
		defer C.free(unsafe.Pointer(nativeError))
		return [3]uint8{}, 0, fmt.Errorf("document viewport marker: %s", C.GoString(nativeError))
	}
	if !changed {
		return [3]uint8{}, 0, errors.New("document viewport marker failed without a native reason")
	}
	return [3]uint8{uint8(rgb[0]), uint8(rgb[1]), uint8(rgb[2])}, float64(borderWidth), nil
}
