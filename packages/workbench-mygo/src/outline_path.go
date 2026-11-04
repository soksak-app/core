package workbench

import "github.com/soksak-app/core/packages/workbench-mygo/src/layout"

// The rail outline as the drawing calls of a path. A path of the mygo ui has no arc, and the layout model keeps its arcs because the shared
// layout cases and the page workbench state them, so the shell draws each arc as a cubic.

// DrawOp is the call of a DrawStep.
type DrawOp int

const (
	// DrawMove is Path.MoveTo.
	DrawMove DrawOp = iota
	// DrawLine is Path.LineTo.
	DrawLine
	// DrawCube is Path.CubeTo.
	DrawCube
	// DrawClose is Path.Close.
	DrawClose
)

// DrawStep is one call on a path. X and Y are its end; C1X, C1Y, C2X and C2Y are the control points of a cubic.
type DrawStep struct {
	Op  DrawOp
	X   float64
	Y   float64
	C1X float64
	C1Y float64
	C2X float64
	C2Y float64
}

// arcControl is the distance of the control points of a cubic from the ends of a quarter circle of radius 1. The cubic stays within 0.03 %
// of the radius.
const arcControl = 0.5523

// OutlineDrawSteps converts the path steps of an outline to drawing calls, with one cubic for each arc.
func OutlineDrawSteps(outline layout.Outline) []DrawStep {
	draw := make([]DrawStep, 0, len(outline.Steps))
	var fromX, fromY float64
	for _, step := range outline.Steps {
		switch step.Op {
		case layout.PathMove:
			draw = append(draw, DrawStep{Op: DrawMove, X: step.X, Y: step.Y})
		case layout.PathLine:
			draw = append(draw, DrawStep{Op: DrawLine, X: step.X, Y: step.Y})
		case layout.PathArc:
			draw = append(draw, arcCube(fromX, fromY, step))
		case layout.PathClose:
			draw = append(draw, DrawStep{Op: DrawClose})
			continue
		}
		fromX, fromY = step.X, step.Y
	}
	return draw
}

// arcCube is the cubic of a quarter circle. The centre lies at the distance of half the chord from its middle, on the side that the sweep
// turns toward; each control point lies along the tangent at its end, which turns the radius by a quarter.
func arcCube(fromX, fromY float64, arc layout.PathStep) DrawStep {
	side := 1.0
	if !arc.Sweep {
		side = -1
	}
	halfX, halfY := (arc.X-fromX)/2, (arc.Y-fromY)/2
	centreX := fromX + halfX - side*halfY
	centreY := fromY + halfY + side*halfX
	return DrawStep{
		Op:  DrawCube,
		X:   arc.X,
		Y:   arc.Y,
		C1X: fromX - side*arcControl*(fromY-centreY),
		C1Y: fromY + side*arcControl*(fromX-centreX),
		C2X: arc.X + side*arcControl*(arc.Y-centreY),
		C2Y: arc.Y - side*arcControl*(arc.X-centreX),
	}
}
