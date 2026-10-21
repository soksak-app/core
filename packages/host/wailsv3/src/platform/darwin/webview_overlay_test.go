//go:build darwin

package darwin

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// The values that a view surface sends to the native overlay mask: five per overlay, in the order of the native call.
func TestAViewOverlaySendsItsInsetsAndVisibilityToTheNativeMask(t *testing.T) {
	// The native call reads the left, top, right and bottom insets and a visibility flag per overlay. A hidden overlay
	// sends 0 and a visible one sends 1, so the native mask cuts the plane only for a visible overlay.
	overlays := []platform.DOMOverlay{
		{Left: 1, Top: 2, Right: 3, Bottom: 4, Visible: true},
		{Left: 5, Top: 6, Right: 7, Bottom: 8, Visible: false},
	}
	want := []float64{1, 2, 3, 4, 1, 5, 6, 7, 8, 0}
	if got := surfaceOverlayValues(overlays); !reflect.DeepEqual(got, want) {
		t.Fatalf("a view overlay does not reach the native mask with its insets and visibility: got %v, want %v", got, want)
	}
}
