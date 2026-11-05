//go:build diagnostics

package host_test

import (
	"slices"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// A check that reads the pixels of a covered window asks its regions to draw; the window stays occluded, and a region whose
// surface hides still draws nothing (docs/spec/native-surfaces.md#image-regions).
func TestARegionOfACoveredWindowDrawsWhileTheWindowDrawsCovered(t *testing.T) {
	images := host.NewImages()
	key := attachedDrawingImage(t, images, "tab-1")
	if err := images.SetVisible(key, true); err != nil {
		t.Fatal(err)
	}
	if got := drawingValues(images.DrawingChanges()); !slices.Equal(got, []string{"view=true"}) {
		t.Fatalf("placed visible on screen: drawing changes %v, want [view=true]", got)
	}
	steps := []struct {
		name   string
		change func()
		want   []string
	}{
		{"occluded window", func() { images.SetOnScreen(false) }, []string{"view=false"}},
		{"drawn while covered", func() { images.SetDrawCovered(true) }, []string{"view=true"}},
		{"hidden surface while drawn covered", func() { images.SetSurfaceVisible(key.Surface, false) }, []string{"view=false hidden"}},
		{"shown surface while drawn covered", func() { images.SetSurfaceVisible(key.Surface, true) }, []string{"view=true"}},
		{"no longer drawn while covered", func() { images.SetDrawCovered(false) }, []string{"view=false"}},
		{"window on screen", func() { images.SetOnScreen(true) }, []string{"view=true"}},
		{"drawn covered while on screen", func() { images.SetDrawCovered(true) }, []string{}},
	}
	for _, step := range steps {
		step.change()
		if got := drawingValues(images.DrawingChanges()); !slices.Equal(got, step.want) {
			t.Fatalf("%s: drawing changes %v, want %v", step.name, got, step.want)
		}
	}
}
