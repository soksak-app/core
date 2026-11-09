package layout

import (
	"fmt"
	"math"
)

// The device pixel grid of the window (docs/spec/native-surfaces.md), as packages/workbench/device-grid.js keeps it. The host seats
// native surfaces on this grid, so the plane starts and ends on it.

// onGridLine is the tolerance of a coordinate that lies on a grid line but reads a little off it after floating point arithmetic.
const onGridLine = 1e-6

// GridPlane returns the rectangle of the plane that area leaves on the device pixel grid of scale: the top and left edges move to
// the next grid line and the bottom and right edges to the previous one. area is in points of the window, as gridInsets of
// packages/workbench/device-grid.js takes it in CSS pixels of the viewport.
func GridPlane(area Rect, scale float64) (Rect, error) {
	if !finite(area.X) || !finite(area.Y) || !finite(area.W) || !finite(area.H) || !finite(scale) || scale <= 0 {
		return Rect{}, fmt.Errorf("invalid plane area %+v or device pixel ratio %v", area, scale)
	}
	left := math.Ceil(area.X*scale-onGridLine) / scale
	top := math.Ceil(area.Y*scale-onGridLine) / scale
	right := math.Floor((area.X+area.W)*scale+onGridLine) / scale
	bottom := math.Floor((area.Y+area.H)*scale+onGridLine) / scale
	// An area of no room keeps its negative size, which the grid does not take (Grid.Resize), as the page does not resize the plane
	// of a hidden stage.
	return Rect{X: left, Y: top, W: right - left, H: bottom - top}, nil
}
