package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The head of a window sidebar is as high as the header of a card, since a sidebar is a card: the set starts one card header below the top
// of the sidebar rectangle (docs/spec/external-sidebars.md#sidebar-head-and-edge, the head-h chrome metric of both headers).
func TestTheWindowSidebarHeadIsAsHighAsACardHeader(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	cardHeader := float32(declared.ChromeNumber("head-h", "px"))
	f := newSidebars(t, sidebarsEnvironment, sidebarsInstalled)
	var failed error
	tt := ui.NewTester(func(c *ui.Context) {
		f.sidebars.Begin()
		frame, err := f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if err != nil {
			failed = err
			return
		}
		f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	set := element(t, tt, "core.sidebar", "left")
	// Bounds are relative to the box that the sidebar draws in, so the set starts at the height of the head band.
	if set.Bounds.Y != cardHeader {
		t.Fatalf("the set of the window sidebar starts %v below its top, want the card header height %v", set.Bounds.Y, cardHeader)
	}
}
