//go:build darwin && diagnostics

package darwin

// The diagnostic viewport marker is implemented by sp_document_viewport_marker in native/darwin.

import (
	"errors"
	"fmt"
	"unsafe"
)

// SetDocumentViewportMarker changes the border of the document's native view. Call it in a main-thread step.
func (implementation) SetDocumentViewportMarker(document unsafe.Pointer, enabled bool) ([3]uint8, float64, error) {
	var rgb [3]uint8
	var borderWidth float64
	var nativeError *byte
	changed := bool(diagnosticNative.MainSpDocumentViewportMarker(document, bool(enabled), &rgb[0], &borderWidth, &nativeError))
	if nativeError != nil {
		defer native.Free(unsafe.Pointer(nativeError))
		return [3]uint8{}, 0, fmt.Errorf("document viewport marker: %s", native.GoString(nativeError))
	}
	if !changed {
		return [3]uint8{}, 0, errors.New("document viewport marker failed without a native reason")
	}
	return [3]uint8{uint8(rgb[0]), uint8(rgb[1]), uint8(rgb[2])}, float64(borderWidth), nil
}
