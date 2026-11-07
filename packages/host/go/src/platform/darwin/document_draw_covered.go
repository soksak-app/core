//go:build darwin && diagnostics

package darwin

// The covered drawing of the document regions of a window is implemented by sp_document_draw_covered in native/darwin.

import (
	"errors"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// DrawDocumentsCovered makes the document regions of the window show their documents while the window is occluded, or ends
// that (docs/spec/native-surfaces.md#document-regions). Call it in a main-thread step.
func (implementation) DrawDocumentsCovered(window platform.Window, draw bool) error {
	if !bool(diagnosticNative.MainSpDocumentDrawCovered(uintptr(window), bool(draw))) {
		return errors.New("a document region of the window cannot change its drawing while the window is occluded")
	}
	return nil
}
