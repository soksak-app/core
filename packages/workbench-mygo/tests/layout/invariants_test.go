// The invariants of the rule of sizes over generated layouts, judged on the stored slicing tree of the grid (docs/spec/cases/layout/invariants.json). The test of packages/soksak runs the
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

// sameSize is the difference in px under which two drawn sizes are one size.
const sameSize = 0.5

// ulp is the relative difference under which two fractions are one fraction. The rules of sizes work on the fractions of the stored
// tree (packages/soksak/docs/layout.md#add-and-remove): a drawn size is a fraction of what a level holds after its corridors, and a
// corridor of a deeper level is drawn inside one kid, so equal fractions are not equal drawn sizes on every level, and ratios of drawn
// sizes are not the ratios that the rules keep.
const ulp = 1e-9

// near tells whether two fractions are one fraction.
func near(a, b float64) bool {
	return math.Abs(a-b) <= ulp*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

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

// slicing is a node of the stored slicing tree of a grid: a card by its id, or a cut along axis, with the ids of its cards and its extent.
type slicing struct {
	id    string
	axis  string
	kids  []*slicing
	ids   []string
	at    span
	share float64
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

// readTree is the stored slicing tree of the grid, with the extent of each node in the fractions of the plane, and the drawn rectangles.
type readTree struct {
	root  *slicing
	rects map[string]layout.Rect
}

func treeOf(grid *layout.Grid) readTree {
	var build func(n *layout.Node, at span) *slicing
	build = func(n *layout.Node, at span) *slicing {
		switch {
		case n.Cut != "":
			cut := &slicing{axis: n.Cut, at: at}
			from := at.lo(n.Cut)
			extent := at.hi(n.Cut) - from
			for _, kid := range n.Kids {
				part := at
				if n.Cut == "x" {
					part.x0, part.x1 = from, from+kid.Share*extent
				} else {
					part.y0, part.y1 = from, from+kid.Share*extent
				}
				from += kid.Share * extent
				node := build(kid.Node, part)
				node.share = kid.Share
				cut.kids = append(cut.kids, node)
				cut.ids = append(cut.ids, node.ids...)
			}
			return cut
		case n.Inner != nil:
			return build(n.Inner, at)
		}
		return &slicing{id: n.Card, ids: []string{n.Card}, at: at}
	}
	return readTree{root: build(grid.ToJSON().Root, span{0, 1, 0, 1}), rects: grid.Rects()}
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

// even tells whether a cut is even: its kids have one fraction. The generated cards have no px size, so every kid takes a fraction.
func (r readTree) even(cut *slicing) bool {
	for _, kid := range cut.kids {
		if !near(kid.share, cut.kids[0].share) {
			return false
		}
	}
	return true
}

// sameTree tells whether two stored trees have the same nodes in the same order and the same fractions.
func sameTree(a, b *layout.Node) bool {
	if a.Cut == "" || b.Cut == "" {
		if a.Inner != nil || b.Inner != nil {
			return a.Box == b.Box && a.Inner != nil && b.Inner != nil && sameTree(a.Inner, b.Inner)
		}
		return a.Cut == b.Cut && a.Card == b.Card
	}
	if a.Cut != b.Cut || len(a.Kids) != len(b.Kids) {
		return false
	}
	for i, kid := range a.Kids {
		if !near(kid.Share, b.Kids[i].Share) || !sameTree(kid.Node, b.Kids[i].Node) {
			return false
		}
	}
	return true
}

// tiles is the text of a cell of the grid that is not covered by exactly one card, or "".
func tiles(grid *layout.Grid) string {
	xs, ys := grid.Lines("x"), grid.Lines("y")
	count := map[[2]int]int{}
	for _, c := range grid.Cards() {
		for col := c.C0; col < c.C1; col++ {
			for row := c.R0; row < c.R1; row++ {
				count[[2]int{col, row}]++
			}
		}
	}
	for col := 0; col+1 < len(xs); col++ {
		for row := 0; row+1 < len(ys); row++ {
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
	text string
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
	grid := newGrid(layout.State{Root: &layout.Node{Card: "c1"}})
	failures := map[string][]failure{}
	for _, name := range file.Checked {
		failures[name] = []failure{}
	}
	next := 2
	fail := func(name string, step int, text string) {
		failures[name] = append(failures[name], failure{fmt.Sprintf("seed %d step %d: %s", seed, step, text)})
	}
	order := func(g *layout.Grid) []string {
		ids := []string{}
		for _, c := range g.Cards() {
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
		if err := change(); err != nil {
			if stateText(grid) != was {
				fail("I2", step, fmt.Sprintf("the refusal %s changed the layout", err))
			}
			return false
		}
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
			if math.IsNaN(f) || !near(f, factors[0]) {
				return true
			}
		}
		return false
	}
	inserted := func(step int, id, target, to string) func(layout.State, map[string]layout.Rect) {
		return func(state layout.State, rects map[string]layout.Rect) {
			axis := "y"
			if to == "left" || to == "right" {
				axis = "x"
			}
			beforeOrder := []string{}
			for _, c := range newGrid(state).Cards() {
				beforeOrder = append(beforeOrder, c.ID)
			}
			before := treeOf(newGrid(state))
			after := treeOf(grid)
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
							f = kid.share / prior.share
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
						if !slices.Contains(kid.ids, target) && (!ok || !near(kid.share, prior.share)) {
							changed = append(changed, idsKey(kid.ids))
						}
					}
					if len(changed) > 0 {
						fail("I7", step, fmt.Sprintf("the add of %s beside %s in an uneven cut changed %v", id, target, changed))
					}
					pair := []float64{}
					for _, kid := range now.kids {
						if slices.Contains(kid.ids, target) || slices.Contains(kid.ids, id) {
							pair = append(pair, kid.share)
						}
					}
					paid := old[idsKey([]string{target})].share
					if len(pair) != 2 || !near(pair[0], pair[1]) || !near(pair[0]+pair[1], paid) {
						fail("I7", step, fmt.Sprintf("the add of %s does not take half of %s: %v of %v", id, target, pair, paid))
					}
				}
				if outside := movedCards(rects, beforeOrder, grid, now.ids); len(outside) > 0 {
					fail("I8", step, fmt.Sprintf("the add of %s moved %v outside its cut", id, outside))
				}
			} else {
				pair := []float64{}
				for _, kid := range now.kids {
					pair = append(pair, kid.share)
				}
				if len(now.kids) != 2 || !near(pair[0], pair[1]) {
					fail("I7", step, fmt.Sprintf("the wrap of %s is not two halves: %v", target, pair))
				}
				if outside := movedCards(rects, beforeOrder, grid, now.ids); len(outside) > 0 {
					fail("I8", step, fmt.Sprintf("the wrap of %s moved %v", target, outside))
				}
			}
			// I10: the withdraw of the card just added restores the stored tree of an even cut and of a wrap, and with it the rectangles.
			if !along || before.even(was) {
				copied := newGrid(grid.ToJSON())
				if _, err := copied.Withdraw(id); err != nil {
					fail("I10", step, fmt.Sprintf("the withdraw of %s is refused: %s", id, err))
				} else if !sameTree(copied.ToJSON().Root, state.Root) {
					fail("I10", step, fmt.Sprintf("the withdraw of %s does not restore the tree", id))
				} else if back := movedCards(rects, beforeOrder, copied, nil); len(back) > 0 {
					fail("I10", step, fmt.Sprintf("the withdraw of %s does not restore %v", id, back))
				}
			}
		}
	}
	withdrawn := func(step int, id string) func(layout.State, map[string]layout.Rect) {
		return func(state layout.State, rects map[string]layout.Rect) {
			beforeOrder := []string{}
			for _, c := range newGrid(state).Cards() {
				beforeOrder = append(beforeOrder, c.ID)
			}
			before := treeOf(newGrid(state))
			after := treeOf(grid)
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
								f = k.share / kid.share
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
		count := len(grid.Cards())
		switch {
		case u < 0.45:
			target := pick()
			to := side()
			id := fmt.Sprintf("c%d", next)
			next++
			judge(step, func() error {
				_, err := grid.Insert(layout.Target{target}, to, &layout.Node{Card: id})
				return err
			}, inserted(step, id, target, to))
		case u < 0.7:
			id := pick()
			if count > 1 {
				judge(step, func() error {
					_, err := grid.Withdraw(id)
					return err
				}, withdrawn(step, id))
			}
		case u < 0.9:
			id := pick()
			target := pick()
			to := side()
			if count > 1 && target != id {
				var left *layout.Node
				start := grid.ToJSON()
				if judge(step, func() error {
					var err error
					left, err = grid.Withdraw(id)
					return err
				}, withdrawn(step, id)) {
					// A move is one change: a refused landing leaves the layout as it was before the withdraw.
					if !judge(step, func() error {
						_, err := grid.Insert(layout.Target{target}, to, left)
						return err
					}, inserted(step, id, target, to)) {
						if err := grid.Replace(start); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
		default:
			judge(step, func() error { return grid.Even() }, func(layout.State, map[string]layout.Rect) {
				after := treeOf(grid)
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
	counts := []string{}
	for _, name := range file.Checked {
		counts = append(counts, fmt.Sprintf("%s %d", name, len(total[name])))
	}
	t.Logf("failures per invariant: %s", strings.Join(counts, ", "))
	for _, name := range file.Checked {
		for _, f := range total[name] {
			t.Logf("%s %s", name, f.text)
		}
	}
	for _, name := range file.Checked {
		if n := len(total[name]); n > 0 {
			t.Errorf("%s: %d failures, the first %s", name, n, total[name][0].text)
		}
	}
}
