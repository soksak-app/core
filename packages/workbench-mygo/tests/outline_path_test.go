package workbench_test

import (
	"math"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

func number(v float64) *float64 { return &v }

// cubicAt is the point of a cubic at t.
func cubicAt(from layout.Point, step workbench.DrawStep, t float64) layout.Point {
	u := 1 - t
	return layout.Point{
		X: u*u*u*from.X + 3*u*u*t*step.C1X + 3*u*t*t*step.C2X + t*t*t*step.X,
		Y: u*u*u*from.Y + 3*u*u*t*step.C1Y + 3*u*t*t*step.C2Y + t*t*t*step.Y,
	}
}

// corner is the vertex of the loops whose rounded corner runs from start to end: the one at the same distance from both on one axis each.
func corner(t *testing.T, outline layout.Outline, start, end layout.Point, radius float64) layout.Point {
	t.Helper()
	for _, loop := range outline.Loops {
		for _, p := range loop {
			for _, candidate := range []layout.Point{{X: start.X, Y: end.Y}, {X: end.X, Y: start.Y}} {
				if math.Abs(candidate.X-p.X) < 1e-9 && math.Abs(candidate.Y-p.Y) < 1e-9 {
					return p
				}
			}
		}
	}
	t.Fatalf("no vertex for the corner from %v to %v at radius %v", start, end, radius)
	return layout.Point{}
}

func TestOutlineDrawStepsReplaceEachArcWithOneCubic(t *testing.T) {
	cases := []struct {
		name    string
		rects   []layout.Rect
		options layout.OutlineOptions
		loops   int
	}{
		{"one rect turns one way", []layout.Rect{{X: 10, Y: 20, W: 100, H: 50}}, layout.OutlineOptions{Pad: number(6)}, 1},
		{"an L turns both ways", []layout.Rect{{X: 0, Y: 0, W: 100, H: 40}, {X: 0, Y: 40, W: 40, H: 60}}, layout.OutlineOptions{Pad: number(0), Radius: number(8)}, 1},
		{"separate rects are one loop each", []layout.Rect{{X: 0, Y: 0, W: 40, H: 40}, {X: 100, Y: 0, W: 40, H: 40}}, layout.OutlineOptions{Pad: number(3)}, 2},
		{"an inset loop keeps its quarter arcs", []layout.Rect{{X: 0, Y: 0, W: 80, H: 40}}, layout.OutlineOptions{Pad: number(4), Radius: number(6), Inset: number(0.5)}, 1},
	}
	for _, kase := range cases {
		t.Run(kase.name, func(t *testing.T) {
			outline := layout.ComputeOutline(kase.rects, kase.options)
			steps := workbench.OutlineDrawSteps(outline)
			cubes, moves, closes := 0, 0, 0
			var at, first layout.Point
			for i, step := range steps {
				switch step.Op {
				case workbench.DrawMove:
					moves++
					at = layout.Point{X: step.X, Y: step.Y}
					first = at
				case workbench.DrawLine:
					at = layout.Point{X: step.X, Y: step.Y}
				case workbench.DrawCube:
					cubes++
					end := layout.Point{X: step.X, Y: step.Y}
					radius := math.Max(math.Abs(end.X-at.X), math.Abs(end.Y-at.Y))
					vertex := corner(t, outline, at, end, radius)
					center := layout.Point{X: at.X + end.X - vertex.X, Y: at.Y + end.Y - vertex.Y}
					// The cubic starts and ends on the arc, and between them it stays within 0.03 % of its radius.
					for n := 0; n <= 100; n++ {
						p := cubicAt(at, step, float64(n)/100)
						if drift := math.Abs(math.Hypot(p.X-center.X, p.Y-center.Y)-radius) / radius; drift > 0.0003 {
							t.Fatalf("step %d at t %d is %.5f of the radius %v off the arc", i, n, drift, radius)
						}
					}
					if start := cubicAt(at, step, 0); math.Hypot(start.X-at.X, start.Y-at.Y) > 1e-9 {
						t.Errorf("step %d starts at %v, the arc at %v", i, start, at)
					}
					if finish := cubicAt(at, step, 1); math.Hypot(finish.X-end.X, finish.Y-end.Y) > 1e-9 {
						t.Errorf("step %d ends at %v, the arc at %v", i, finish, end)
					}
					at = end
				case workbench.DrawClose:
					closes++
					at = first
				}
			}
			if want := outline.Corners - outline.Sharp; cubes != want {
				t.Errorf("%d cubics, want one for each of the %d rounded corners", cubes, want)
			}
			if moves != kase.loops || closes != kase.loops {
				t.Errorf("%d moves and %d closes, want %d of each", moves, closes, kase.loops)
			}
		})
	}
}

// A corner too tight to round has no arc, so it adds no cubic.
func TestOutlineDrawStepsKeepASquareCorner(t *testing.T) {
	outline := layout.ComputeOutline([]layout.Rect{{X: 0, Y: 0, W: 40, H: 40}}, layout.OutlineOptions{Pad: number(0), Radius: number(0)})
	if outline.Sharp != 4 {
		t.Fatalf("%d sharp corners, want 4", outline.Sharp)
	}
	for _, step := range workbench.OutlineDrawSteps(outline) {
		if step.Op == workbench.DrawCube {
			t.Fatalf("a square corner gave the cubic %+v", step)
		}
	}
}
