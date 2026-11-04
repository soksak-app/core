package layout

import (
	"math"
	"sort"
	"strings"
)

// The outline of a set of rects: the path around them, padded and rounded, as a list of loops and an SVG path string. Adjacent rects
// give one loop; separated rects give one loop each.

// Point is a vertex of a loop.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// OutlineOptions are how far outside the rect borders the outline runs (default 0), the corner radius (default pad) and how far the
// joined loops move inward after the union (default 0). A field that is nil is not given.
type OutlineOptions struct {
	Pad    *float64 `json:"pad"`
	Radius *float64 `json:"radius"`
	Inset  *float64 `json:"inset"`
}

// PathOp is the command of a PathStep.
type PathOp byte

const (
	// PathMove starts a loop at the end of the step.
	PathMove PathOp = 'M'
	// PathLine draws a line to the end of the step.
	PathLine PathOp = 'L'
	// PathArc draws a quarter circle to the end of the step.
	PathArc PathOp = 'A'
	// PathClose ends a loop. It has no end.
	PathClose PathOp = 'Z'
)

// PathStep is one command of the path of a loop, as the path data writes it. R and Sweep are those of an arc: Sweep is the SVG sweep flag,
// true when the arc turns clockwise on the screen.
type PathStep struct {
	Op    PathOp
	X     float64
	Y     float64
	R     float64
	Sweep bool
}

// Outline is the SVG path data of every loop, the closed rectilinear loops before rounding, and the corner count with the number too
// tight to round. Steps are the commands of the path data before their numbers are written; the shared layout cases state the data.
type Outline struct {
	Path    string     `json:"path"`
	Steps   []PathStep `json:"-"`
	Loops   [][]Point  `json:"loops"`
	Corners int        `json:"corners"`
	Sharp   int        `json:"sharp"`
}

func snapTo(v float64) float64 { return jsRound(v*100) / 100 }

func vertexKey(x, y float64) string { return jsString(snapTo(x)) + "," + jsString(snapTo(y)) }

// collapse is the distinct coordinates, with any two one snap apart read as one.
func collapse(values []float64) []float64 {
	sorted := append([]float64(nil), values...)
	sort.SliceStable(sorted, func(a, b int) bool { return sorted[a] < sorted[b] })
	out := []float64{}
	for _, v := range sorted {
		if len(out) == 0 || v-out[len(out)-1] > 0.01+1e-9 {
			out = append(out, v)
		}
	}
	return out
}

// nearestOf is the collapsed coordinate this one belongs to.
func nearestOf(grid []float64, v float64) float64 {
	best := grid[0]
	for _, g := range grid {
		if math.Abs(g-v) < math.Abs(best-v) {
			best = g
		}
	}
	return best
}

type box struct{ x0, y0, x1, y1 float64 }

type edge [4]float64

// unionLoops is the boundary of the union of axis-aligned rects, as closed rectilinear loops.
func unionLoops(rects []Rect) [][]Point {
	var snapped []box
	for _, r := range rects {
		b := box{x0: snapTo(r.X), y0: snapTo(r.Y), x1: snapTo(r.X + r.W), y1: snapTo(r.Y + r.H)}
		if b.x1 > b.x0 && b.y1 > b.y0 {
			snapped = append(snapped, b)
		}
	}
	if len(snapped) == 0 {
		return [][]Point{}
	}
	var xs, ys []float64
	for _, b := range snapped {
		xs = append(xs, b.x0, b.x1)
		ys = append(ys, b.y0, b.y1)
	}
	gx, gy := collapse(xs), collapse(ys)
	var boxes []box
	for _, b := range snapped {
		c := box{x0: nearestOf(gx, b.x0), x1: nearestOf(gx, b.x1), y0: nearestOf(gy, b.y0), y1: nearestOf(gy, b.y1)}
		if c.x1 > c.x0 && c.y1 > c.y0 {
			boxes = append(boxes, c)
		}
	}
	if len(boxes) == 0 {
		return [][]Point{}
	}
	filled := func(i, j int) bool {
		cx := (gx[i] + gx[i+1]) / 2
		cy := (gy[j] + gy[j+1]) / 2
		for _, b := range boxes {
			if cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1 {
				return true
			}
		}
		return false
	}

	// Each filled cell is emitted clockwise; an edge shared by two filled cells cancels. live keeps the insertion order of a map.
	type entry struct {
		key  string
		edge *edge
		gone bool
	}
	var order []*entry
	live := map[string]*entry{}
	add := func(ax, ay, bx, by float64) {
		back := vertexKey(bx, by) + "|" + vertexKey(ax, ay)
		if e, ok := live[back]; ok {
			e.gone = true
			delete(live, back)
			return
		}
		k := vertexKey(ax, ay) + "|" + vertexKey(bx, by)
		if e, ok := live[k]; ok {
			// Map.set on a key that is there replaces the value and keeps its place.
			e.edge = &edge{ax, ay, bx, by}
			return
		}
		e := &entry{key: k, edge: &edge{ax, ay, bx, by}}
		live[k] = e
		order = append(order, e)
	}
	for i := 0; i < len(gx)-1; i++ {
		for j := 0; j < len(gy)-1; j++ {
			if !filled(i, j) {
				continue
			}
			x0, x1, y0, y1 := gx[i], gx[i+1], gy[j], gy[j+1]
			add(x0, y0, x1, y0)
			add(x1, y0, x1, y1)
			add(x1, y1, x0, y1)
			add(x0, y1, x0, y0)
		}
	}
	var edges []*edge
	for _, e := range order {
		if !e.gone {
			edges = append(edges, e.edge)
		}
	}
	from := map[string][]*edge{}
	for _, e := range edges {
		k := vertexKey(e[0], e[1])
		from[k] = append(from[k], e)
	}
	used := map[*edge]bool{}
	loops := [][]Point{}
	for _, seed := range edges {
		if used[seed] {
			continue
		}
		var pts []Point
		e := seed
		for e != nil && !used[e] {
			used[e] = true
			pts = append(pts, Point{X: e[0], Y: e[1]})
			var next *edge
			for _, n := range from[vertexKey(e[2], e[3])] {
				if !used[n] {
					next = n
					break
				}
			}
			e = next
		}
		if len(pts) >= 4 {
			loops = append(loops, dropCollinear(pts))
		}
	}
	return loops
}

// insetLoop moves every edge of a rectilinear loop distance to its right, which is the inside of the region.
func insetLoop(loop []Point, distance float64) []Point {
	n := len(loop)
	normal := func(a, b Point) Point {
		length := math.Hypot(b.X-a.X, b.Y-a.Y)
		return Point{X: -(b.Y - a.Y) / length, Y: (b.X - a.X) / length}
	}
	out := make([]Point, n)
	for i, p := range loop {
		before := normal(loop[(i-1+n)%n], p)
		after := normal(p, loop[(i+1)%n])
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		out[i] = Point{X: p.X + float64((before.X+after.X)*distance), Y: p.Y + float64((before.Y+after.Y)*distance)}
	}
	return out
}

func dropCollinear(pts []Point) []Point {
	out := []Point{}
	for i, p := range pts {
		a := pts[(i-1+len(pts))%len(pts)]
		b := pts[(i+1)%len(pts)]
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		if math.Abs(float64((p.X-a.X)*(b.Y-p.Y))-float64((p.Y-a.Y)*(b.X-p.X))) > 1e-6 {
			out = append(out, p)
		}
	}
	return out
}

// roundedPath converts one closed loop to path steps, replacing each right angle with an arc. A corner with less than half a px left is
// drawn square and counted in sharp.
func roundedPath(loop []Point, radius float64) ([]PathStep, int, int) {
	n := len(loop)
	steps := make([]PathStep, 0, 2*n+1)
	sharp := 0
	for i := 0; i < n; i++ {
		p := loop[i]
		a := loop[(i-1+n)%n]
		b := loop[(i+1)%n]
		inX, inY := p.X-a.X, p.Y-a.Y
		outX, outY := b.X-p.X, b.Y-p.Y
		lenIn := math.Hypot(inX, inY)
		lenOut := math.Hypot(outX, outY)
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		turn := float64(inX*outY) - float64(inY*outX)
		r := math.Min(math.Min(radius, lenIn/2), lenOut/2)
		op := PathLine
		if i == 0 {
			op = PathMove
		}
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		steps = append(steps, PathStep{Op: op, X: p.X - float64((inX/lenIn)*r), Y: p.Y - float64((inY/lenIn)*r)})
		if r > 0.5 {
			// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
			steps = append(steps, PathStep{Op: PathArc, X: p.X + float64((outX/lenOut)*r), Y: p.Y + float64((outY/lenOut)*r), R: r, Sweep: turn > 0})
		} else {
			sharp++
		}
	}
	return append(steps, PathStep{Op: PathClose}), n, sharp
}

// pathData writes path steps as SVG path data.
func pathData(steps []PathStep) string {
	var d strings.Builder
	for _, step := range steps {
		switch step.Op {
		case PathMove, PathLine:
			d.WriteString(string(rune(step.Op)) + toFixed2(step.X) + " " + toFixed2(step.Y))
		case PathArc:
			sweep := "0"
			if step.Sweep {
				sweep = "1"
			}
			d.WriteString("A" + toFixed2(step.R) + " " + toFixed2(step.R) + " 0 0 " + sweep + " " + toFixed2(step.X) + " " + toFixed2(step.Y))
		case PathClose:
			d.WriteString("Z")
		}
	}
	return d.String()
}

// ComputeOutline is the outline binding a set of rects into one shape. With pad at half the corridor the rects meet exactly and the
// result is a single loop; below that they stay apart and the result is one loop each.
func ComputeOutline(rects []Rect, options OutlineOptions) Outline {
	pad := 0.0
	if options.Pad != nil {
		pad = *options.Pad
	}
	radius := pad
	if options.Radius != nil {
		radius = *options.Radius
	}
	grown := make([]Rect, len(rects))
	for i, r := range rects {
		// float64 rounds each product before it is added, as JavaScript does; without it Go may fuse them (number.go).
		grown[i] = Rect{X: r.X - pad, Y: r.Y - pad, W: r.W + float64(pad*2), H: r.H + float64(pad*2)}
	}
	inset := 0.0
	if options.Inset != nil {
		inset = *options.Inset
	}
	loops := unionLoops(grown)
	if inset != 0 {
		for i, loop := range loops {
			loops[i] = insetLoop(loop, inset)
		}
	}
	paths := make([]string, len(loops))
	out := Outline{Loops: loops}
	for i, loop := range loops {
		steps, corners, sharp := roundedPath(loop, radius)
		paths[i] = pathData(steps)
		out.Steps = append(out.Steps, steps...)
		out.Corners += corners
		out.Sharp += sharp
	}
	out.Path = strings.Join(paths, " ")
	return out
}
