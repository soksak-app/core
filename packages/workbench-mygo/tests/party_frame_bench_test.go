// The cost of one frame of a window whose space holds parties.
package workbench_test

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// partyShell returns fullShell with two parties of four touching cards each, which together hold every card of the plane.
func partyShell(b testing.TB) *shellFixture {
	b.Helper()
	f := fullShell(b)
	cards := f.tabbedCards()
	free := slices.Clone(cards)
	for range 2 {
		first := free[0]
		party := ""
		for _, other := range free[1:] {
			reply, err := f.answer("core.party.create", map[string]any{"cards": []string{first, other}})
			if err == nil {
				view, _ := reply["party"].(map[string]any) // silent: a party without its identifier fails below.
				party, _ = view["id"].(string)
				free = slices.DeleteFunc(free, func(card string) bool { return card == first || card == other })
				break
			}
		}
		if party == "" {
			b.Fatalf("no party of %s forms among %v", first, free)
		}
		for size := 2; size < 4; {
			added := false
			for _, card := range free {
				if _, err := f.answer("core.party.add", map[string]any{"party": party, "card": card}); err == nil {
					free = slices.DeleteFunc(free, func(held string) bool { return held == card })
					size, added = size+1, true
					break
				}
			}
			if !added {
				b.Fatalf("party %s holds %d cards and no card of %v joins it", party, size, free)
			}
		}
	}
	f.settle()
	parties, err := f.shell.Registry().Read("core.parties")
	if err != nil {
		b.Fatal(err)
	}
	if records, _ := parties.([]layout.Record); len(records) != 2 { // silent: a value of another type fails here.
		b.Fatalf("core.parties is %+v", parties)
	}
	return f
}

// A frame that follows no change, in a window with two parties.
func BenchmarkAFrameOfAWindowWithParties(b *testing.B) {
	f := partyShell(b)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		f.tester.Frame()
		for len(f.pending) > 0 {
			(<-f.pending)()
		}
	}
}

// dragBoundary holds the first vertical divider of the window of f, at the size and scale of a large display, and moves it by
// six points back and forth for each of b.N frames, as a pointer drag of a card boundary does.
func dragBoundary(b *testing.B, f *shellFixture) {
	f.tester.SetSize(1800, 1100)
	f.tester.SetScale(2)
	f.settle()
	var grip *ui.ElementNode
	var walk func(nodes []ui.ElementNode)
	walk = func(nodes []ui.ElementNode) {
		for i, node := range nodes {
			if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == "core.divider" && node.Bounds.H > node.Bounds.W && grip == nil {
				grip = &nodes[i]
			}
			walk(node.Children)
		}
	}
	walk(f.tester.ElementTree())
	if grip == nil {
		b.Fatal("the window shows no vertical divider")
	}
	x, y := grip.Bounds.X+grip.Bounds.W/2, grip.Bounds.Y+grip.Bounds.H/2
	f.tester.Move(x, y)
	f.tester.Press(x, y)
	f.pending.drain(b)
	f.tester.Frame()
	f.pending.drain(b)
	b.ReportAllocs()
	b.ResetTimer()
	for i := range b.N {
		f.tester.Move(x+float32(6*(i%2)), y)
		f.pending.drain(b)
		f.tester.Frame()
		f.pending.drain(b)
	}
	b.StopTimer()
	f.tester.Release(x, y)
	f.settle()
}

// A drag step of a card boundary.
func BenchmarkADragStepOfABoundary(b *testing.B) { dragBoundary(b, fullShell(b)) }

// A drag step of a card boundary in a window with two parties.
func BenchmarkADragStepOfABoundaryWithParties(b *testing.B) { dragBoundary(b, partyShell(b)) }
