// The invariants of the rule of sizes over generated layouts (docs/spec/cases/layout/invariants.json). The test of packages/soksak runs the
// same file with the same generator, so a seed makes the same operations in both languages.
package layout_test

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// sameSize is the difference in px under which two drawn sizes are one size, as the layout model judges an even cut.
const sameSize = 0.5

// keptRect is the difference in px under which a rectangle that an operation does not change is unchanged.
const keptRect = 1e-6

// mulberry32 is the generator of the numbers in [0, 1), the same in every language of the cases.
func mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := (a ^ a>>15) * (1 | a)
		t = (t + (t^t>>7)*(61|t)) ^ t
		return float64(t^t>>14) / 4294967296
	}
}

// span is the extent of a node in the fractions of the plane.
type span struct{ x0, x1, y0, y1 float64 }

// slicing is a node of the slicing tree that the test reads from the lines of a grid: a card by its id, or a cut along axis.
type slicing struct {
	id   string
	axis string
	kids []*slicing
	ids  []string
	at   span
}

func (s span) lo(axis string) float64 {
	if axis == "x" {
		return s.x0
	}
	return s.y0
}

func (s span) hi(axis string) float64 {
	if axis == "x" {
		return s.x1
	}
	return s.y1
}

// readTree is the slicing tree of the grid, the cut of prefer[0] taken first where the lines allow both, and the drawn extent of a node.
type readTree struct {
	root  *slicing
	rects map[string]layout.Rect
}

func treeOf(t *testing.T, grid *layout.Grid, prefer []string) readTree {
	t.Helper()
	state := grid.ToJSON()
	leaves := []*slicing{}
	for _, c := range state.Cards {
		leaves = append(leaves, &slicing{id: c.ID, ids: []string{c.ID}, at: span{state.Xs[c.C0], state.Xs[c.C1], state.Ys[c.R0], state.Ys[c.R1]}})
	}
	var build func(nodes []*slicing) *slicing
	build = func(nodes []*slicing) *slicing {
		if len(nodes) == 1 {
			return nodes[0]
		}
		for _, axis := range prefer {
			end, start := math.Inf(-1), math.Inf(1)
			for _, n := range nodes {
				end, start = math.Max(end, n.at.hi(axis)), math.Min(start, n.at.lo(axis))
			}
			at := []float64{}
			for _, n := range nodes {
				v := n.at.hi(axis)
				if v >= end || slices.Contains(at, v) {
					continue
				}
				crosses := false
				for _, m := range nodes {
					if m.at.hi(axis) > v && m.at.lo(axis) < v {
						crosses = true
					}
				}
				if !crosses {
					at = append(at, v)
				}
			}
			if len(at) == 0 {
				continue
			}
			sort.Float64s(at)
			bounds := append(append([]float64{start}, at...), end)
			cut := &slicing{axis: axis, at: span{math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)}}
			for i := 0; i+1 < len(bounds); i++ {
				part := []*slicing{}
				for _, n := range nodes {
					if n.at.lo(axis) >= bounds[i] && n.at.hi(axis) <= bounds[i+1] {
						part = append(part, n)
					}
				}
				kid := build(part)
				cut.kids = append(cut.kids, kid)
				cut.ids = append(cut.ids, kid.ids...)
				cut.at = span{math.Min(cut.at.x0, kid.at.x0), math.Max(cut.at.x1, kid.at.x1), math.Min(cut.at.y0, kid.at.y0), math.Max(cut.at.y1, kid.at.y1)}
			}
			return cut
		}
		t.Fatal("the grid is not a slicing arrangement")
		return nil
	}
	return readTree{root: build(leaves), rects: grid.Rects()}
}

// size is the drawn extent of a node on an axis.
func (r readTree) size(n *slicing, axis string) float64 {
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, id := range n.ids {
		rect := r.rects[id]
		if axis == "x" {
			lo, hi = math.Min(lo, rect.X), math.Max(hi, rect.X+rect.W)
		} else {
			lo, hi = math.Min(lo, rect.Y), math.Max(hi, rect.Y+rect.H)
		}
	}
	return hi - lo
}

func idsKey(ids []string) string {
	sorted := slices.Clone(ids)
	sort.Strings(sorted)
	return strings.Join(sorted, ",")
}

// holderOf is the cut that holds the node whose ids are ids, or nil.
func holderOf(n *slicing, ids []string) *slicing {
	for _, kid := range n.kids {
		if idsKey(kid.ids) == idsKey(ids) {
			return n
		}
		if found := holderOf(kid, ids); found != nil {
			return found
		}
	}
	return nil
}

func (r readTree) even(cut *slicing) bool {
	for _, kid := range cut.kids {
		if math.Abs(r.size(kid, cut.axis)-r.size(cut.kids[0], cut.axis)) >= sameSize {
			return false
		}
	}
	return true
}

// innerLines is the coordinates at which the children of a cut meet.
func innerLines(cut *slicing) []float64 {
	out := []float64{}
	for _, kid := range cut.kids[1:] {
		out = append(out, kid.at.lo(cut.axis))
	}
	return out
}

// ambiguous tells whether the lines of the grid read as more than one slicing tree: two neighbouring children of a cut are cuts along the
// other axis whose children meet at one coordinate, so the line through both also divides the parent across, and the grid has lost which
// of the trees an operation made (docs/plans/layout-sizes.md#model).
func ambiguous(t *testing.T, grid *layout.Grid) bool {
	var visit func(n *slicing) bool
	visit = func(n *slicing) bool {
		for i := 0; i+1 < len(n.kids); i++ {
			p, q := n.kids[i], n.kids[i+1]
			if p.kids != nil && q.kids != nil && p.axis == q.axis {
				for _, v := range innerLines(p) {
					if slices.Contains(innerLines(q), v) {
						return true
					}
				}
			}
		}
		return slices.ContainsFunc(n.kids, visit)
	}
	return visit(treeOf(t, grid, []string{"x", "y"}).root) || visit(treeOf(t, grid, []string{"y", "x"}).root)
}

// tiles is the text of a cell of the grid that is not covered by exactly one card, or "".
func tiles(grid *layout.Grid) string {
	state := grid.ToJSON()
	count := map[[2]int]int{}
	for _, c := range state.Cards {
		for col := c.C0; col < c.C1; col++ {
			for row := c.R0; row < c.R1; row++ {
				count[[2]int{col, row}]++
			}
		}
	}
	for col := 0; col+1 < len(state.Xs); col++ {
		for row := 0; row+1 < len(state.Ys); row++ {
			if n := count[[2]int{col, row}]; n != 1 {
				return fmt.Sprintf("cell %d:%d is covered %d times", col, row, n)
			}
		}
	}
	return ""
}

func rectChanged(a, b layout.Rect, within float64) bool {
	return math.Abs(a.X-b.X) > within || math.Abs(a.Y-b.Y) > within || math.Abs(a.W-b.W) > within || math.Abs(a.H-b.H) > within
}

// movedCards is the cards outside keep, in the order of the grid, whose rectangle differs from before.
func movedCards(before map[string]layout.Rect, order []string, grid *layout.Grid, keep []string) []string {
	now := grid.Rects()
	out := []string{}
	for _, id := range order {
		r, there := now[id]
		if !slices.Contains(keep, id) && there && rectChanged(before[id], r, keptRect) {
			out = append(out, id)
		}
	}
	return out
}

type failure struct {
	text     string
	twoTrees bool
}

// invariantFile is docs/spec/cases/layout/invariants.json.
type invariantFile struct {
	Description string         `json:"description"`
	Options     layout.Options `json:"options"`
	Seeds       []uint32       `json:"seeds"`
	Steps       int            `json:"steps"`
	Checked     []string       `json:"checked"`
	Workbench   []string       `json:"workbench"`
}

// runSeed runs the operations of one seed and returns the failures of each invariant.
func runSeed(t *testing.T, file invariantFile, seed uint32) map[string][]failure {
	random := mulberry32(seed)
	minSize := 96.0
	var options map[string]any
	raw, err := json.Marshal(file.Options)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &options); err != nil {
		t.Fatal(err)
	}
	if v, ok := options["minSize"].(float64); ok {
		minSize = v
	}
	newGrid := func(state layout.State) *layout.Grid {
		grid, err := layout.New(&state, file.Options)
		if err != nil {
			t.Fatal(err)
		}
		return grid
	}
	grid := newGrid(layout.State{Xs: []float64{0, 1}, Ys: []float64{0, 1}, Cards: []layout.Card{{ID: "c1", C0: 0, C1: 1, R0: 0, R1: 1}}})
	failures := map[string][]failure{}
	for _, name := range file.Checked {
		failures[name] = []failure{}
	}
	next := 2
	twoTrees := false
	fail := func(name string, step int, text string) {
		failures[name] = append(failures[name], failure{fmt.Sprintf("seed %d step %d: %s", seed, step, text), twoTrees})
	}
	order := func(g *layout.Grid) []string {
		ids := []string{}
		for _, c := range g.ToJSON().Cards {
			ids = append(ids, c.ID)
		}
		return ids
	}
	pick := func() string {
		ids := order(grid)
		return ids[int(math.Floor(random()*float64(len(ids))))]
	}
	sides := []string{"left", "right", "top", "bottom"}
	side := func() string { return sides[int(math.Floor(random()*4))] }
	stateText := func(g *layout.Grid) string {
		text, err := json.Marshal(g.ToJSON())
		if err != nil {
			t.Fatal(err)
		}
		return string(text)
	}
	judge := func(step int, change func() error, check func(state layout.State, rects map[string]layout.Rect)) bool {
		state := grid.ToJSON()
		was := stateText(grid)
		rects := grid.Rects()
		twoTrees = ambiguous(t, grid)
		if err := change(); err != nil {
			if stateText(grid) != was {
				fail("I2", step, fmt.Sprintf("the refusal %s changed the layout", err))
			}
			return false
		}
		twoTrees = twoTrees || ambiguous(t, grid)
		if broken := tiles(grid); broken != "" {
			fail("I1", step, broken)
		}
		now := grid.Rects()
		for _, id := range order(grid) {
			r := now[id]
			before, there := rects[id]
			if (!there || rectChanged(before, r, keptRect)) && (r.W < minSize-sameSize || r.H < minSize-sameSize) {
				fail("I2", step, fmt.Sprintf("card %s is drawn %vx%v", id, r.W, r.H))
			}
		}
		check(state, rects)
		return true
	}
	ratiosDiffer := func(factors []float64) bool {
		for _, f := range factors {
			if math.IsNaN(f) || math.Abs(f-factors[0]) > 1e-6 {
				return true
			}
		}
		return false
	}
	inserted := func(step int, id, target, to string) func(layout.State, map[string]layout.Rect) {
		return func(state layout.State, rects map[string]layout.Rect) {
			axis, prefer := "y", []string{"x", "y"}
			if to == "left" || to == "right" {
				axis, prefer = "x", []string{"y", "x"}
			}
			beforeOrder := []string{}
			for _, c := range state.Cards {
				beforeOrder = append(beforeOrder, c.ID)
			}
			before := treeOf(t, newGrid(state), prefer)
			after := treeOf(t, grid, prefer)
			was := holderOf(before.root, []string{target})
			along := was != nil && was.axis == axis
			now := holderOf(after.root, []string{id})
			if now == nil {
				fail("I7", step, fmt.Sprintf("card %s is in no cut", id))
				return
			}
			if along {
				old := map[string]*slicing{}
				for _, kid := range was.kids {
					old[idsKey(kid.ids)] = kid
				}
				kept := []*slicing{}
				for _, kid := range now.kids {
					if !slices.Contains(kid.ids, id) {
						kept = append(kept, kid)
					}
				}
				if before.even(was) {
					factors := []float64{}
					for _, kid := range kept {
						f := math.NaN()
						if prior, ok := old[idsKey(kid.ids)]; ok {
							f = after.size(kid, axis) / before.size(prior, axis)
						}
						factors = append(factors, f)
					}
					if ratiosDiffer(factors) {
						fail("I7", step, fmt.Sprintf("the even cut of %s changed its ratios: %v", target, factors))
					}
					if !after.even(now) {
						fail("I7", step, fmt.Sprintf("the even cut of %s is not even after the add of %s", target, id))
					}
				} else {
					changed := []string{}
					for _, kid := range kept {
						prior, ok := old[idsKey(kid.ids)]
						if !slices.Contains(kid.ids, target) && (!ok || math.Abs(after.size(kid, axis)-before.size(prior, axis)) > sameSize) {
							changed = append(changed, idsKey(kid.ids))
						}
					}
					if len(changed) > 0 {
						fail("I7", step, fmt.Sprintf("the add of %s beside %s in an uneven cut changed %v", id, target, changed))
					}
				}
				if outside := movedCards(rects, beforeOrder, grid, now.ids); len(outside) > 0 {
					fail("I8", step, fmt.Sprintf("the add of %s moved %v outside its cut", id, outside))
				}
			} else {
				pair := []float64{}
				for _, kid := range now.kids {
					pair = append(pair, after.size(kid, axis))
				}
				if len(now.kids) != 2 || math.Abs(pair[0]-pair[1]) > sameSize {
					fail("I7", step, fmt.Sprintf("the wrap of %s is not two halves: %v", target, pair))
				}
				if outside := movedCards(rects, beforeOrder, grid, now.ids); len(outside) > 0 {
					fail("I8", step, fmt.Sprintf("the wrap of %s moved %v", target, outside))
				}
			}
			// I10: the withdraw of the card just added restores the layout of an even cut and of a wrap.
			if !along || before.even(was) {
				copied := newGrid(grid.ToJSON())
				if _, err := copied.Withdraw(nil, id); err != nil {
					fail("I10", step, fmt.Sprintf("the withdraw of %s is refused: %s", id, err))
				} else if back := movedCards(rects, beforeOrder, copied, nil); len(back) > 0 {
					fail("I10", step, fmt.Sprintf("the withdraw of %s does not restore %v", id, back))
				}
			}
		}
	}
	withdrawn := func(step int, id string) func(layout.State, map[string]layout.Rect) {
		return func(state layout.State, rects map[string]layout.Rect) {
			prefer := []string{"y", "x"}
			if grid.FillOrder() == "v" {
				prefer = []string{"x", "y"}
			}
			beforeOrder := []string{}
			for _, c := range state.Cards {
				beforeOrder = append(beforeOrder, c.ID)
			}
			before := treeOf(t, newGrid(state), prefer)
			after := treeOf(t, grid, prefer)
			was := holderOf(before.root, []string{id})
			if was == nil {
				return
			}
			rest := []*slicing{}
			for _, kid := range was.kids {
				if !slices.Contains(kid.ids, id) {
					rest = append(rest, kid)
				}
			}
			if len(rest) > 1 {
				factors := []float64{}
				for _, kid := range rest {
					f := math.NaN()
					if holder := holderOf(after.root, kid.ids); holder != nil {
						for _, k := range holder.kids {
							if idsKey(k.ids) == idsKey(kid.ids) {
								f = after.size(k, was.axis) / before.size(kid, was.axis)
							}
						}
					}
					factors = append(factors, f)
				}
				if ratiosDiffer(factors) {
					fail("I7", step, fmt.Sprintf("the withdraw of %s changed the ratios of its cut: %v", id, factors))
				}
			}
			if outside := movedCards(rects, beforeOrder, grid, was.ids); len(outside) > 0 {
				fail("I8", step, fmt.Sprintf("the withdraw of %s moved %v outside its cut", id, outside))
			}
		}
	}
	for step := 1; step <= file.Steps; step++ {
		u := random()
		count := len(grid.ToJSON().Cards)
		switch {
		case u < 0.45:
			target := pick()
			to := side()
			id := fmt.Sprintf("c%d", next)
			next++
			judge(step, func() error {
				_, err := grid.Insert(nil, layout.Target{target}, to, layout.Piece{ID: id})
				return err
			}, inserted(step, id, target, to))
		case u < 0.7:
			id := pick()
			if count > 1 {
				judge(step, func() error {
					_, err := grid.Withdraw(nil, id)
					return err
				}, withdrawn(step, id))
			}
		case u < 0.9:
			id := pick()
			target := pick()
			to := side()
			if count > 1 && target != id {
				var left layout.Piece
				start := grid.ToJSON()
				if judge(step, func() error {
					var err error
					left, err = grid.Withdraw(nil, id)
					return err
				}, withdrawn(step, id)) {
					// A move is one change: a refused landing leaves the layout as it was before the withdraw.
					if !judge(step, func() error {
						_, err := grid.Insert(nil, layout.Target{target}, to, left)
						return err
					}, inserted(step, id, target, to)) {
						if err := grid.Replace(start); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
		default:
			judge(step, func() error { return grid.Even(nil) }, func(layout.State, map[string]layout.Rect) {
				after := treeOf(t, grid, []string{"x", "y"})
				uneven := []string{}
				var visit func(n *slicing)
				visit = func(n *slicing) {
					if n.kids == nil {
						return
					}
					if !after.even(n) {
						uneven = append(uneven, idsKey(n.ids))
					}
					for _, kid := range n.kids {
						visit(kid)
					}
				}
				visit(after.root)
				if len(uneven) > 0 {
					fail("I7", step, fmt.Sprintf("even left the cuts %s uneven", strings.Join(uneven, " | ")))
				}
			})
		}
	}
	return failures
}

func TestLayoutInvariants(t *testing.T) {
	var file invariantFile
	caseFile(t, "invariants.json", &file)
	total := map[string][]failure{}
	for _, seed := range file.Seeds {
		for name, list := range runSeed(t, file, seed) {
			total[name] = append(total[name], list...)
		}
	}
	counts, oneTree := []string{}, []string{}
	for _, name := range file.Checked {
		single := 0
		for _, f := range total[name] {
			if !f.twoTrees {
				single++
			}
		}
		counts = append(counts, fmt.Sprintf("%s %d", name, len(total[name])))
		oneTree = append(oneTree, fmt.Sprintf("%s %d", name, single))
	}
	t.Logf("failures per invariant: %s; on layouts whose lines read as one tree: %s", strings.Join(counts, ", "), strings.Join(oneTree, ", "))
	for _, name := range file.Checked {
		for _, f := range total[name] {
			two := ""
			if f.twoTrees {
				two = " two trees"
			}
			t.Logf("%s%s %s", name, two, f.text)
		}
	}
	for _, name := range file.Checked {
		if n := len(total[name]); n > 0 {
			t.Errorf("%s: %d failures, the first %s", name, n, total[name][0].text)
		}
	}
}
