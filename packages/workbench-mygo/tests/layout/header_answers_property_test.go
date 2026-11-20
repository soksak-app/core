package layout_test

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// headerAnswers are the answers that a draw of the card heads asks of a group tree, CanSplit and CanGroup toward each side and CanClose
// of every card, as text in the order of the cards, or the text of the panic that asking them raised. With trial, each answer is the
// result of its trial operation run by Probe, which keeps no answer, in place of the answer that the tree kept.
func headerAnswers(tree *layout.GroupTree, trial bool) (answers string) {
	defer func() {
		if failure := recover(); failure != nil {
			answers = fmt.Sprintf("panic: %v", failure)
		}
	}()
	ask := func(kept func() bool, change func() error) bool {
		if trial {
			return tree.Probe(change) == nil
		}
		return kept()
	}
	var b strings.Builder
	for _, id := range tree.Cards() {
		fmt.Fprintf(&b, "%s:", id)
		for _, side := range []layout.Side{"left", "right", "top", "bottom"} {
			split := ask(func() bool { return tree.CanSplit(id, side) }, func() error { _, err := tree.Split(id, side, nil); return err })
			group := ask(func() bool { return tree.CanGroup(id, side) },
				func() error { _, _, err := tree.CreateGroup(id, side, nil); return err })
			fmt.Fprintf(&b, " split %s %t group %s %t", side, split, side, group)
		}
		closes := ask(func() bool { return tree.CanClose(id) }, func() error { _, err := tree.Close(id); return err })
		fmt.Fprintf(&b, " close %t\n", closes)
	}
	return b.String()
}

// TestTheKeptHeaderAnswersEqualTheirTrialOperations runs seeded random sequences of the layout operations of a space with groups, as
// the commands, the drops, the drags and the settings of the workbench call them: splits, moves to cards and to the members of cuts,
// group creation and dissolution, closes, boundary moves, resizes, seams, gaps and minimum sizes. After every operation the answers
// that the tree kept for its header (F937-10-1) equal the results of their trial operations run by Probe, which keeps no answer, so
// every change that an answer reads gives the tree a new layout token.
func TestTheKeptHeaderAnswersEqualTheirTrialOperations(t *testing.T) {
	sides := []layout.Side{"left", "right", "top", "bottom"}
	for seed := uint64(1); seed <= 100; seed++ {
		gap, minimum, width, height := 12.0, 96.0, 1400.0, 900.0
		grid, err := layout.New(nil, layout.Options{Gap: &gap, MinSize: &minimum, Width: &width, Height: &height})
		if err != nil {
			t.Fatal(err)
		}
		tree, err := layout.ReadTree(layout.State{Root: &layout.Node{Card: "card-1"}}, nil, json.RawMessage(`"card-1"`),
			json.RawMessage(`1`), layout.GroupOptions{Head: 32}, grid)
		if err != nil {
			t.Fatal(err)
		}
		seam := false
		random := rand.New(rand.NewPCG(seed, 11))
		pick := func() string { cards := tree.Cards(); return cards[random.IntN(len(cards))] }
		steps := []string{}
		headerAnswers(tree, false)
		for step := range 32 {
			side := sides[random.IntN(4)]
			var operation string
			switch random.IntN(13) {
			case 0, 1:
				id := pick()
				_, err := tree.Split(id, side, nil)
				operation = fmt.Sprintf("split %s %s: %v", id, side, err)
			case 2:
				id := pick()
				_, _, err := tree.CreateGroup(id, side, nil)
				operation = fmt.Sprintf("create %s %s: %v", id, side, err)
			case 3:
				id := pick()
				operation = fmt.Sprintf("dissolve %s: %v", id, tree.Dissolve(id))
			case 4, 5:
				id, target := pick(), pick()
				err := tree.Move(id, layout.Target{target}, side)
				operation = fmt.Sprintf("move %s %s %s: %v", id, target, side, err)
			case 6:
				// A drop names a cut by its members, the moving card among them when the cut holds it.
				id, first, second := pick(), pick(), pick()
				err := tree.Move(id, layout.Target{first, second}, side)
				operation = fmt.Sprintf("move %s [%s %s] %s: %v", id, first, second, side, err)
			case 7:
				id := pick()
				_, err := tree.Close(id)
				operation = fmt.Sprintf("close %s: %v", id, err)
			case 8:
				axis := layout.Axis([]string{"x", "y"}[random.IntN(2)])
				if lines := grid.Lines(axis); len(lines) > 2 {
					line := 1 + random.IntN(len(lines)-2)
					px := random.Float64() * map[layout.Axis]float64{"x": grid.Width(), "y": grid.Height()}[axis]
					operation = fmt.Sprintf("boundary %s %d %.1f: %.1f", axis, line, px, tree.MoveBoundary(axis, line, px, true))
				}
			case 9:
				w, h := 600+random.Float64()*1000, 400+random.Float64()*700
				grid.Resize(w, h)
				operation = fmt.Sprintf("resize %.1f %.1f", w, h)
			case 10:
				seam = !seam
				tree.SetSeam(seam)
				operation = fmt.Sprintf("seam %t", seam)
			case 11:
				// The settings give the plane its gap and the group tree its seam together, which lays the heads with the new gap.
				px := float64(random.IntN(4) * 8)
				grid.SetGap(px)
				tree.SetSeam(seam)
				operation = fmt.Sprintf("gap %.0f", px)
			case 12:
				px := float64(48 + random.IntN(8)*24)
				grid.SetMinSize(px)
				operation = fmt.Sprintf("minimum %.0f", px)
			}
			if operation == "" {
				continue
			}
			steps = append(steps, operation)
			kept, fresh := headerAnswers(tree, false), headerAnswers(tree, true)
			if kept != fresh || strings.HasPrefix(kept, "panic: ") {
				t.Fatalf("seed %d step %d %s: the kept header answers\n%s differ from the results of their trial operations\n%s\nafter the operations\n%s\nthe layout is %s",
					seed, step, operation, kept, fresh, strings.Join(steps, "\n"), describeTree(tree))
			}
		}
	}
}
