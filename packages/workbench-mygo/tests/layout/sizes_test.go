// The px sizes of the cards of the tree and the refusals of the two primitives, as the tests of packages/soksak hold them for the
// TypeScript library (packages/soksak/docs/layout.md#sizes).
package layout_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// sizesGrid builds a grid of a stored tree in JSON with the options.
func sizesGrid(t *testing.T, tree string, options layout.Options) *layout.Grid {
	t.Helper()
	var state layout.State
	if err := json.Unmarshal([]byte(tree), &state); err != nil {
		t.Fatal(err)
	}
	grid, err := layout.New(&state, options)
	if err != nil {
		t.Fatal(err)
	}
	return grid
}

func px(v float64) *float64 { return &v }

func TestAWithdrawThatLeavesOnlyFixedCardsInItsCutIsRefused(t *testing.T) {
	grid := sizesGrid(t, `{"root":{"cut":"y","kids":[
		{"share":0.5,"node":{"cut":"x","kids":[{"share":0.4,"node":{"card":"a"}},{"share":0.3,"node":{"card":"f1","fixed":true}},{"share":0.3,"node":{"card":"f2","fixed":true}}]}},
		{"share":0.5,"node":{"card":"b"}}]}}`, layout.Options{Width: px(1000), Height: px(600), Gap: px(24), MinSize: px(96)})
	before := grid.ToJSON()
	if _, err := grid.Withdraw("a"); err == nil || !strings.Contains(err.Error(), "card a leaves no card of its cut that takes its space") {
		t.Fatalf("the withdraw of a answered %v", err)
	}
	if after := grid.ToJSON(); !reflect.DeepEqual(after, before) {
		t.Fatalf("the refusal changed the state to %+v", after)
	}
}

func TestAResizeBelowADeclaredSizeKeepsTheDeclaration(t *testing.T) {
	grid := sizesGrid(t, `{"root":{"cut":"x","kids":[{"share":0.6,"node":{"card":"side","width":900}},{"share":0.4,"node":{"card":"main"}}]}}`,
		layout.Options{Width: px(1600), Height: px(800), Gap: px(24), MinSize: px(96)})
	grid.Resize(800, 800)
	// A change after the resize writes the cards back into the tree.
	if !grid.SetData("main", json.RawMessage(`{"n":1}`)) {
		t.Fatal("the data of main was refused")
	}
	if card, _ := grid.Card("side"); card.Width == nil || *card.Width != 900 {
		t.Fatalf("side declares %v after the resize, want 900", card.Width)
	}
	grid.Resize(1600, 800)
	if rect, _ := grid.Rect("side"); rect.W != 900 {
		t.Fatalf("side is drawn %v wide, want 900", rect.W)
	}
}

func TestAnInsertThatLeavesACardWithNoAreaIsRefusedWhereMinSizeIsZero(t *testing.T) {
	// With minSize 0 the minimum does not refuse a card drawn at no size, so the area check alone refuses this insert.
	grid, err := layout.New(nil, layout.Options{Width: px(386), Height: px(130), Gap: px(12), MinSize: px(0)})
	if err != nil {
		t.Fatal(err)
	}
	id := func(s string) *string { return &s }
	split := func(card string, axis layout.Axis, born string) {
		if _, err := grid.Split(card, axis, layout.SplitInit{ID: id(born)}); err != nil {
			t.Fatalf("the split of %s toward %s was refused: %v", card, axis, err)
		}
	}
	split("card", "x", "n0")
	if _, ok := grid.InsertAt("x", 2, layout.InsertInit{ID: id("i1"), Size: px(6)}); !ok {
		t.Fatal("the insert of i1 was refused")
	}
	grid.Close("n0")
	grid.Close("i1")
	split("card", "y", "n4")
	split("card", "y", "n5")
	split("card", "x", "n6")
	grid.SetSize("n6", "x", px(281))
	split("card", "x", "n8")
	split("n4", "y", "n9")
	split("n4", "x", "n10")
	before := grid.ToJSON()
	if born, ok := grid.InsertAt("x", 3, layout.InsertInit{ID: id("i11"), Size: px(118)}); ok {
		t.Fatalf("the insert issued %s", born)
	}
	if after := grid.ToJSON(); !reflect.DeepEqual(after, before) {
		t.Fatalf("the refusal changed the state to %+v", after)
	}
	for card, rect := range grid.Rects() {
		if rect.W <= 0 || rect.H <= 0 {
			t.Fatalf("%s is drawn %vx%v", card, rect.W, rect.H)
		}
	}
}

func TestAPxSizeIsKeptWhenALineOfAnotherCutFallsInsideItsCard(t *testing.T) {
	grid := sizesGrid(t, `{"root":{"cut":"x","kids":[{"share":0.25,"node":{"card":"side","width":400}},{"share":0.75,"node":{"cut":"y","kids":[{"share":0.5,"node":{"card":"a"}},{"share":0.5,"node":{"card":"b"}}]}}]}}`,
		layout.Options{Width: px(1600), Height: px(800), Gap: px(24), MinSize: px(96)})
	if _, err := grid.Split("a", "x", layout.SplitInit{}); err != nil {
		t.Fatalf("the split of a was refused: %v", err)
	}
	if !grid.SetSize("side", "y", px(300)) {
		t.Fatal("setSize of side was refused")
	}
	card, _ := grid.Card("side")
	if card.Width == nil || *card.Width != 400 || card.Height == nil || *card.Height != 300 {
		t.Fatalf("side declares %v x %v, want 400 x 300", card.Width, card.Height)
	}
	if rect, _ := grid.Rect("side"); rect.W != 400 {
		t.Fatalf("side is drawn %v wide, want 400", rect.W)
	}
}
