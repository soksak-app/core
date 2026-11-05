//go:build !diagnostics

package host_test

import (
	"reflect"
	"slices"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// A build without the diagnostics tag has no way to make a covered window draw: a person's covered window draws no region
// until it is on screen again.
// contract: image.drawing.covered-window-never-draws-without-diagnostics
func TestABuildWithoutDiagnosticsCannotDrawACoveredWindow(t *testing.T) {
	images := host.NewImages()
	if _, found := reflect.TypeOf(images).MethodByName("SetDrawCovered"); found {
		t.Fatal("Images.SetDrawCovered exists in a build without the diagnostics tag")
	}
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
		{"hidden surface while occluded", func() { images.SetSurfaceVisible(key.Surface, false) }, []string{"view=false hidden"}},
		{"shown surface while occluded", func() { images.SetSurfaceVisible(key.Surface, true) }, []string{"view=false"}},
		{"window on screen", func() { images.SetOnScreen(true) }, []string{"view=true"}},
	}
	for _, step := range steps {
		step.change()
		if got := drawingValues(images.DrawingChanges()); !slices.Equal(got, step.want) {
			t.Fatalf("%s: drawing changes %v, want %v", step.name, got, step.want)
		}
	}
}
