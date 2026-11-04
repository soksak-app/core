//go:build e2e && diagnostics

package adapter_test

// Checks that the picture of a window holds what its view page drew: the window server composes the surface host of a
// view page under the Metal surface of the window, so only the picture of the window server shows both
// (docs/spec/hosts.md#native-views). A frame needs a display, so this test carries the build constraint e2e
// (docs/operations/examples.md#test-kinds).

import (
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// stillPixel takes a still of the window, as diagnostics.capture.still does, and returns the color of the middle of box
// in eight bits a channel.
func (s *viewSession) stillPixel(t *testing.T) [3]uint32 {
	t.Helper()
	capturer, ok := s.system.(platform.Capturer)
	if !ok {
		t.Fatal("this platform has no window capture")
	}
	var numbers []int
	var err error
	mygo.RunOnMain(func() { numbers, err = capturer.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		t.Fatal(err)
	}
	if len(numbers) == 0 {
		t.Fatal("the window has no window server number")
	}
	path := filepath.Join(t.TempDir(), fmt.Sprintf("window-%d.png", os.Getpid()))
	if err := capturer.CaptureStill(numbers[0], path); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	still, err := png.Decode(file)
	if err != nil {
		t.Fatal(err)
	}
	scale := float64(still.Bounds().Dx()) / float64(s.window.Window().ContentBounds().Width)
	r, g, b, _ := still.At(int((box.X+box.W/2)*scale), int((box.Y+box.H/2)*scale)).RGBA()
	return [3]uint32{r >> 8, g >> 8, b >> 8}
}

// The picture of a window shows the color that a view page fills its surface with.
func TestE2EAStillOfTheWindowShowsTheViewPage(t *testing.T) {
	session := viewHost(t)
	t.Cleanup(func() { session.layout(t) })
	session.layout(t, viewSurface("still", true))
	const r, g, b = 0x20, 0x40, 0x80
	var seen [3]uint32
	near := func(have, want uint32) bool { return have+8 >= want && have <= want+8 }
	wait(t, "the color of the view page in the picture of the window", func() bool {
		seen = session.stillPixel(t)
		return near(seen[0], r) && near(seen[1], g) && near(seen[2], b)
	})
	t.Logf("the middle of the surface is %v", seen)
}
