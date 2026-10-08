package host_test

import (
	"math"
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: surfaces-geometry.rect.accepts-zero-size, surfaces-geometry.rect.rejects-negative-size, surfaces-geometry.rect.rejects-non-finite
func TestValidateRectRejectsNegativeAndNonFiniteSizes(t *testing.T) {
	if err := host.ValidateRect("surface", 0, 0, 0, 10); err != nil {
		t.Fatalf("zero-sized hidden surface should remain valid: %v", err)
	}
	if err := host.ValidateRect("surface", 0, 0, -1, 10); err == nil {
		t.Fatal("negative surface width must be rejected instead of clamped")
	}
	if err := host.ValidateRect("surface", 0, 0, math.NaN(), 10); err == nil {
		t.Fatal("non-finite surface width must be rejected")
	}
}

// contract: surfaces-geometry.sync.rejects-surface-rect-before-layout
func TestSyncRequestCheckRejectsAnInvalidSurfaceRectangle(t *testing.T) {
	dom := host.SurfaceComposition{Kind: "dom"}
	valid := host.Surface{ID: "tab-1", Visible: true, Plugin: "page", Composition: dom, Rect: host.Rect{W: 10, H: 10}}
	if _, err := host.CheckSyncRequest(host.SyncRequest{Settled: true, Titlebar: 40, Surfaces: []host.Surface{valid}}, map[string]host.SurfaceComposition{}, map[string]string{}); err != nil {
		t.Fatalf("a valid sync request was refused: %v", err)
	}
	negative := host.Surface{ID: "tab-2", Visible: true, Plugin: "page", Composition: dom, Rect: host.Rect{W: -1, H: 10}}
	_, err := host.CheckSyncRequest(host.SyncRequest{Settled: true, Titlebar: 40, Surfaces: []host.Surface{valid, negative}}, map[string]host.SurfaceComposition{}, map[string]string{})
	if want := `surface "tab-2" geometry must not have a negative size`; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v before the layout began, want %q", err, want)
	}
	nonFinite := host.Surface{ID: "tab-3", Visible: true, Plugin: "page", Composition: dom, Rect: host.Rect{X: math.Inf(1), W: 10, H: 10}}
	_, err = host.CheckSyncRequest(host.SyncRequest{Settled: true, Titlebar: 40, Surfaces: []host.Surface{nonFinite}}, map[string]host.SurfaceComposition{}, map[string]string{})
	if want := `surface "tab-3" geometry must contain finite numbers`; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v before the layout began, want %q", err, want)
	}
}

// contract: surfaces-geometry.sync.rejects-overlay-rect-before-layout
func TestSyncRequestCheckRejectsAnInvalidWindowOverlayRectangle(t *testing.T) {
	hidden := false
	request := host.SyncRequest{Settled: true, Titlebar: 40, Overlays: []host.WindowOverlayRequest{{X: 1, Y: 2, W: 3, H: 4}, {X: 5, Y: 6, W: 7, H: 8, Visible: &hidden}}}
	overlays, err := host.CheckSyncRequest(request, map[string]host.SurfaceComposition{}, map[string]string{})
	if err != nil {
		t.Fatalf("a valid sync request was refused: %v", err)
	}
	if want := []platform.WindowOverlay{{X: 1, Y: 2, W: 3, H: 4, Visible: true}, {X: 5, Y: 6, W: 7, H: 8}}; !reflect.DeepEqual(overlays, want) {
		t.Fatalf("overlays %v, want %v", overlays, want)
	}
	request.Overlays = append(request.Overlays, host.WindowOverlayRequest{W: 3, H: -4})
	_, err = host.CheckSyncRequest(request, map[string]host.SurfaceComposition{}, map[string]string{})
	if want := "window overlay geometry must not have a negative size"; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v before the layout began, want %q", err, want)
	}
}

// contract: surfaces-geometry.sync.plugin
func TestSyncRequestCheckRequiresTheSamePluginOfEachSurface(t *testing.T) {
	document := host.SurfaceComposition{Kind: "hybrid", Regions: []host.SurfaceRegion{{Name: "page", Kind: "document", Input: "native"}}, Overlays: []string{}}
	surface := host.Surface{ID: "tab-1", Visible: true, Plugin: "page", Composition: document, Rect: host.Rect{W: 10, H: 10}}
	held := map[string]host.SurfaceComposition{"tab-1": document}
	if _, err := host.CheckSyncRequest(host.SyncRequest{Settled: true, Titlebar: 40, Surfaces: []host.Surface{surface}}, held, map[string]string{"tab-1": "page"}); err != nil {
		t.Fatalf("a held surface with the same plugin was refused: %v", err)
	}
	_, err := host.CheckSyncRequest(host.SyncRequest{Settled: true, Titlebar: 40, Surfaces: []host.Surface{surface}}, held, map[string]string{"tab-1": "other"})
	if want := `surface "tab-1" changed its composition declaration`; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v for a changed plugin, want %q", err, want)
	}
	surface.Plugin = ""
	_, err = host.CheckSyncRequest(host.SyncRequest{Settled: true, Titlebar: 40, Surfaces: []host.Surface{surface}}, map[string]host.SurfaceComposition{}, map[string]string{})
	if want := `surface "tab-1" requires its plugin`; err == nil || err.Error() != want {
		t.Fatalf("the sync check returned %v for a surface without a plugin, want %q", err, want)
	}
}
