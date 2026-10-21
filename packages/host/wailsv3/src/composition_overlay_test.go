package host

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// The DOM overlays of a view surface keep their declared order, insets and visibility on their way to the native surface.
func TestAViewOverlayReachesTheNativeSurfaceInItsDeclaredOrder(t *testing.T) {
	// The overlays are declared as the toolbar then the sidebar, and the placements arrive in another order. The native
	// surface receives one entry per declared overlay with its own insets and visibility.
	names := []string{"toolbar", "sidebar"}
	overlays := map[string]CompositionPlacement{
		"sidebar": {Name: "sidebar", Left: 0, Top: 40, Right: 0, Bottom: 0, Visible: false},
		"toolbar": {Name: "toolbar", Left: 0, Top: 0, Right: 0, Bottom: 300, Visible: true},
	}
	want := []platform.DOMOverlay{
		{Left: 0, Top: 0, Right: 0, Bottom: 300, Visible: true},
		{Left: 0, Top: 40, Right: 0, Bottom: 0, Visible: false},
	}
	if got := nativeSurfaceOverlays(names, overlays); !reflect.DeepEqual(got, want) {
		t.Fatalf("a view overlay does not reach the native surface with its declared insets and visibility: got %+v, want %+v", got, want)
	}
}
