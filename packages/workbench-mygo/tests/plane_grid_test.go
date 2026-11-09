package workbench_test

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The host seats native surfaces on the device pixel grid, so the plane starts and ends on that grid whatever lies above it
// (docs/spec/native-surfaces.md): the error line above the spaces, whose height follows its text, must not leave the plane between
// device pixels.
func TestAShownErrorAboveThePlaneLeavesThePlaneOnTheDevicePixelGrid(t *testing.T) {
	for _, scale := range []float64{2, 3} {
		stored := &surfaceHost{window: workbench.WindowView{Visible: true, Scale: scale, Width: 1200, Height: 800}}
		f := surfaceShellOn(t, installedDocument, stored)
		// A layout fault fails the next draw, which shows its error in the error line while the plane stays drawn.
		f.shell.Registry().Reply("diagnostics.layout.fail", json.RawMessage(`{}`), nil, func(value any, err error) {
			if value != nil || err != nil {
				t.Fatalf("diagnostics.layout.fail answered %v, %v", value, err)
			}
		})
		f.settle()
		f.tester.SetSize(1160, 800)
		shown := f.shownErrors()
		if len(shown) != 1 || !strings.Contains(shown[0], "surface presentation failed: diagnostic layout fault") {
			t.Fatalf("the fault showed %q", shown)
		}
		grid := status[struct {
			Plane map[string]float64 `json:"plane"`
		}](t, f, "core.grid")
		plane := grid.Plane
		if plane["w"] <= 0 || plane["h"] <= 0 {
			t.Fatalf("the window shows no plane: %v", plane)
		}
		edges := map[string]float64{"left": plane["x"], "top": plane["y"], "right": plane["x"] + plane["w"], "bottom": plane["y"] + plane["h"]}
		for name, edge := range edges {
			if math.Abs(edge*scale-math.Round(edge*scale)) > 1e-6 {
				t.Errorf("the plane %s %v is between device pixels at scale %v (plane %v)", name, edge, scale, plane)
			}
		}
	}
}
