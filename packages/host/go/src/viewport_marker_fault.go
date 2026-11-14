//go:build diagnostics

// The fault injection point and the call counter of the diagnostic viewport marker of a document region.

package host

import (
	"errors"
	"os"
	"sync/atomic"
)

// faultViewportMarker is the fault injection point of diagnostics.document.viewport-marker. Its value fail makes the call fail after the
// platform call returned, with the failure of the native marker.
const faultViewportMarker = "SOKSAK_FAULT_VIEWPORT_MARKER"

// viewportMarkerCalls counts the calls that diagnostics.document.viewport-marker made to the platform marker.
var viewportMarkerCalls atomic.Int64

// viewportMarkerResult counts the platform call and returns err, or the injected failure when the fault point names fail and err is nil.
func viewportMarkerResult(err error) error {
	viewportMarkerCalls.Add(1)
	if err == nil && os.Getenv(faultViewportMarker) == "fail" {
		return errors.New("native marker failed")
	}
	return err
}
