// The lines of the seam in the mygo workbench (docs/spec/groups.md#drawn-rectangles, docs/spec/groups.md#drawing): at gap 0 every
// boundary between two boxes, between a header and the box below it and at each edge of the plane is one line of the border width,
// whatever the number of group cards that end on it, and a mark of the focus colors that one line.
package workbench_test

import (
	"encoding/json"
	"fmt"
	"image/color"
	"math"
	"os"
	"strconv"
	"testing"

	"github.com/egoist/mygo/ui"
)

// seamShell is a layout shell at the seam whose group card card-7 holds card-6 and card-2, card-6 holds card-5 and card-4 below it, and
// card-5 holds card-1 and card-3 side by side; card-8 stands outside every group at the right. So the left edge of the plane ends three
// group cards beside card-1, the line between card-3 and card-2 ends two, the line between card-4 and card-2 and the line between
// card-2 and card-8 end one, and the headers of card-7, card-6 and card-5 stack under the space bar. The window sidebars are off, so
// card-7 stands at the left, top and bottom edges of the plane and card-8 at its right edge.
func seamShell(t *testing.T) *tabShell {
	t.Helper()
	space := treeSpace("spc-aaaaaa", cutNode("x",
		kidNode(0.75, boxNode("card-7", "그룹 3", "card-6", cutNode("x",
			kidNode(2./3, boxNode("card-6", "그룹 2", "card-5", cutNode("y",
				kidNode(0.5, boxNode("card-5", "그룹 1", "card-1", cutNode("x", kidNode(0.5, cardNode("card-1", tab("t1", "notes"))), kidNode(0.5, cardNode("card-3", tab("t3", "notes")))))),
				kidNode(0.5, cardNode("card-4", tab("t4", "notes")))))),
			kidNode(1./3, cardNode("card-2", tab("t2", "notes")))))),
		kidNode(0.25, cardNode("card-8", tab("t8", "notes")))))
	stored := space["layout"].(map[string]any)
	stored["leader"], stored["lastCard"] = "card-7", 8
	f := layoutShell(t, space)
	// The scale of a window of the measured defect: a line of 1 point is 2 device pixels, and a line between two boxes, which stands
	// half a point from each, covers whole device pixels.
	f.tester.SetScale(2)
	f.tester.SetSize(1400, 900)
	f.settle()
	f.run(t, "core.settings.change", `{"key": "gap", "value": 0, "scope": "common"}`)
	f.run(t, "core.settings.set", `{"patch": {"left": false, "right": false}}`)
	return f
}

// colorRun is a stretch of device pixels of one color along a scan.
type colorRun struct {
	Color color.RGBA
	N     int
}

// runs are the stretches of one color of the device pixels from the point (x0, y0) to the point (x1, y1), in points, along one axis.
func (f *tabShell) runs(x0, y0, x1, y1 float32) []colorRun {
	f.t.Helper()
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	px := func(v float32) int { return int(math.Floor(float64(v * scale))) }
	ax, ay, bx, by := px(x0), px(y0), px(x1), px(y1)
	steps := max(abs(bx-ax), abs(by-ay))
	out := []colorRun{}
	for k := 0; k <= steps; k++ {
		x, y := ax, ay
		if bx != ax {
			x = ax + k*sign(bx-ax)
		}
		if by != ay {
			y = ay + k*sign(by-ay)
		}
		c := image.RGBAAt(x, y)
		if n := len(out); n > 0 && near(out[n-1].Color, c) {
			out[n-1].N++
			continue
		}
		out = append(out, colorRun{Color: c, N: 1})
	}
	return out
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func sign(v int) int {
	if v < 0 {
		return -1
	}
	return 1
}

// deviceLine is the border width in device pixels.
func (f *tabShell) deviceLine() int {
	f.t.Helper()
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	return int(math.Round(float64(f.palette().BorderWidth * scale)))
}

// seamLine checks that the scan from inside one box to inside the next crosses one line of the border width between them: the colour
// of the first box, one run of the border width and the colour of the second box, and that run of the colour want unless want is nil.
// A scan from the edge of the window, edge, starts on the line.
func (f *tabShell) seamLine(t *testing.T, where string, got []colorRun, edge bool, want *color.RGBA) {
	t.Helper()
	line := f.deviceLine()
	count := 3
	middle := 1
	if edge {
		count, middle = 2, 0
	}
	if len(got) != count || got[middle].N != line {
		t.Errorf("%s: the seam is %v, want one line of %d device pixels between the two boxes", where, got, line)
		return
	}
	if want != nil && !near(got[middle].Color, *want) {
		t.Errorf("%s: the seam line is %v, want %v", where, got[middle].Color, *want)
	}
}

// seamLines are the scans across every line of seamShell, each from inside one box to inside the next.
func (f *tabShell) seamLines() map[string][]colorRun {
	f.tester.Frame()
	tree := f.tester.ElementTree()
	cards, frames, heads := exposedAll(tree, "core.card"), exposedAll(tree, "core.group"), exposedAll(tree, "core.group.header")
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / tree[0].Bounds.W
	window := ui.Rect{W: float32(image.Bounds().Dx()) / scale, H: float32(image.Bounds().Dy()) / scale}
	in := float32(6)
	mid := func(r ui.Rect) (float32, float32) { return r.X + r.W/2, r.Y + r.H/2 }
	_, y1 := mid(cards["card-1"])
	_, y4 := mid(cards["card-4"])
	x4, _ := mid(cards["card-4"])
	// The scans across the lines of card-2 and card-8 stand a quarter down, away from the grip in the middle of their dividers.
	x2, _ := mid(cards["card-2"])
	y2 := cards["card-2"].Y + cards["card-2"].H/4
	x8, _ := mid(cards["card-8"])
	y8 := y2
	x3, _ := mid(cards["card-3"])
	top := frames["card-7"].Y
	return map[string][]colorRun{
		"left of card-1, where three group cards end":    f.runs(0, y1, cards["card-1"].X+in, y1),
		"left of card-4, where two group cards end":      f.runs(0, y4, cards["card-4"].X+in, y4),
		"between card-3 and card-2, two group cards end": f.runs(cards["card-3"].X+cards["card-3"].W-in, y1, cards["card-2"].X+in, y1),
		"between card-4 and card-2, one group card ends": f.runs(cards["card-4"].X+cards["card-4"].W-in, y4, cards["card-2"].X+in, y4),
		"between card-2 and card-8, one group card ends": f.runs(cards["card-2"].X+cards["card-2"].W-in, y2, cards["card-8"].X+in, y2),
		"between card-1 and card-4, one group card ends": f.runs(x4-cards["card-4"].W/4, cards["card-1"].Y+cards["card-1"].H-in, x4-cards["card-4"].W/4, cards["card-4"].Y+in),
		// The scan below card-3 crosses the header of card-4, whose tool row with the frame of the group split buttons starts less than 3
		// points below the top of the card, so it ends 1 point inside card-4, as the scans into a header do.
		"between card-3 and card-4, one group card ends": f.runs(x3, cards["card-3"].Y+cards["card-3"].H-in, x3, cards["card-4"].Y+1),
		"right of card-8, the edge of the plane":         f.runs(window.W-0.01, y8, cards["card-8"].X+cards["card-8"].W-in, y8),
		"below card-4, where two group cards end":        f.runs(x4, window.H-0.01, x4, cards["card-4"].Y+cards["card-4"].H-in),
		"below card-2, where one group card ends":        f.runs(x2, window.H-0.01, x2, cards["card-2"].Y+cards["card-2"].H-in),
		"under the space bar above card-2":               f.runs(x2, top-in, x2, heads["card-7"].Y+1),
		"under the space bar above card-8":               f.runs(x8, top-in, x8, cards["card-8"].Y+1),
		"under the header of card-7 above card-2":        f.runs(x2, heads["card-7"].Y+heads["card-7"].H-in, x2, cards["card-2"].Y+1),
		"under the header of card-7 above card-6":        f.runs(x3, heads["card-7"].Y+heads["card-7"].H-in, x3, heads["card-6"].Y+1),
		"under the header of card-6 above card-5":        f.runs(x3, heads["card-6"].Y+heads["card-6"].H-in, x3, heads["card-5"].Y+1),
		"under the header of card-5 above card-3":        f.runs(x3, heads["card-5"].Y+heads["card-5"].H-in, x3, cards["card-3"].Y+1),
	}
}

// At the seam every line between two boxes, under a header, under the space bar and at each edge of the plane is one line of the border
// width, however many group cards end on it (docs/spec/groups.md#drawn-rectangles).
func TestEverySeamLineIsOneLineHoweverManyGroupCardsEndOnIt(t *testing.T) {
	f := seamShell(t)
	f.run(t, "core.card.focus", `{"card": "card-8"}`)
	// The bottom edge of the plane lies above the status bar, so its lines are lines between two boxes, not lines at the window edge.
	edges := map[string]bool{"left of card-1, where three group cards end": true, "left of card-4, where two group cards end": true,
		"right of card-8, the edge of the plane": true}
	for where, got := range f.seamLines() {
		f.seamLine(t, where, got, edges[where], nil)
	}
}

// With the project tabs at the left, the left edge of the plane is one line between the project column and the plane.
func TestTheLeftEdgeOfThePlaneIsOneLineBesideTheProjectColumn(t *testing.T) {
	f := seamShell(t)
	f.run(t, "core.settings.set", `{"patch": {"projectTabs": "left"}}`)
	f.run(t, "core.card.focus", `{"card": "card-8"}`)
	f.tester.Frame()
	tree := f.tester.ElementTree()
	cards, column := exposedAll(tree, "core.card"), exposedAll(tree, "core.projects.column")[""]
	y := cards["card-1"].Y + cards["card-1"].H/2
	f.seamLine(t, "between the project column and card-1", f.runs(column.X+column.W-6, y, cards["card-1"].X+6, y), false, nil)
}

// At the seam the focus ring of the focused card and the mark of each group card that holds it color the one line outside the box, and
// on a line where several of them end the innermost owns it (docs/spec/groups.md#drawing).
func TestTheInnermostMarkOwnsASeamLine(t *testing.T) {
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	fade, err := strconv.ParseFloat(declared.Chrome["group-focus-fade"], 64)
	if err != nil {
		t.Fatal(err)
	}
	f := seamShell(t)
	palette := f.palette()
	marked := func(d int) *color.RGBA {
		share := math.Pow(fade, float64(d))
		mix := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*share + float64(b)*(1-share))) }
		c := color.RGBA{mix(palette.Focus.R, palette.Edge.R), mix(palette.Focus.G, palette.Edge.G), mix(palette.Focus.B, palette.Edge.B), 255}
		return &c
	}
	focus := opaque(palette.Focus)
	f.run(t, "core.card.focus", `{"card": "card-1"}`)
	lines := f.seamLines()
	for where, want := range map[string]*color.RGBA{
		"left of card-1, where three group cards end":    &focus,
		"between card-1 and card-4, one group card ends": &focus,
		"between card-3 and card-2, two group cards end": marked(1),
		"between card-3 and card-4, one group card ends": marked(1),
		"left of card-4, where two group cards end":      marked(2),
		"between card-4 and card-2, one group card ends": marked(2),
		"below card-4, where two group cards end":        marked(2),
		"between card-2 and card-8, one group card ends": marked(3),
		"below card-2, where one group card ends":        marked(3),
		"under the space bar above card-2":               marked(3),
	} {
		edge := where == "left of card-1, where three group cards end" || where == "left of card-4, where two group cards end"
		f.seamLine(t, fmt.Sprintf("card-1 focused, %s", where), lines[where], edge, want)
	}
}
