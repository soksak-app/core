package host_test

import (
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: window-overlay.rects.packs-four-values-per-rect
func TestVisibleWindowOverlayRectsUsesFourStride(t *testing.T) {
	got := platform.VisibleWindowOverlayRects([]platform.WindowOverlay{{X: 1, Y: 2, W: 3, H: 4, Visible: true}, {X: 5, Y: 6, W: 7, H: 8, Visible: true}})
	if want := []float64{1, 2, 3, 4, 5, 6, 7, 8}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// contract: window-overlay.rects.filters-hidden
func TestVisibleWindowOverlayRectsFiltersHidden(t *testing.T) {
	got := platform.VisibleWindowOverlayRects([]platform.WindowOverlay{{X: 1, Y: 2, W: 3, H: 4}, {X: 5, Y: 6, W: 7, H: 8, Visible: true}})
	if want := []float64{5, 6, 7, 8}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
