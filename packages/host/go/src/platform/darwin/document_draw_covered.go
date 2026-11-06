//go:build darwin && diagnostics

package darwin

// The covered drawing of the document regions of a window is implemented by sp_document_draw_covered in native/darwin.

/*
#cgo CFLAGS: -x objective-c -fmodules -DSOKSAK_DIAGNOSTIC
#cgo pkg-config: soksak-darwin
#include <stdbool.h>
#include "document_view.h"
#include "main_thread.h"

// The native call runs on the main thread (main_thread.h).
static bool main_sp_document_draw_covered(void *window, bool draw) {
    return ON_MAIN(bool, sp_document_draw_covered(window, draw));
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// DrawDocumentsCovered makes the document regions of the window show their documents while the window is occluded, or ends
// that (docs/spec/native-surfaces.md#document-regions). Call it in a main-thread step.
func (implementation) DrawDocumentsCovered(window unsafe.Pointer, draw bool) error {
	if !bool(C.main_sp_document_draw_covered(window, C.bool(draw))) {
		return errors.New("a document region of the window cannot change its drawing while the window is occluded")
	}
	return nil
}
