package workbench_test

import (
	"encoding/json"
	"maps"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// textPlace is the frame and the cards of a text size test.
type textPlace struct {
	focused string
	frame   float64
	cards   map[string]float64
}

func (p *textPlace) FocusedCard() string                 { return p.focused }
func (p *textPlace) FrameTextSize() float64              { return p.frame }
func (p *textPlace) CardTextSizes() map[string]float64   { return maps.Clone(p.cards) }
func (p *textPlace) SetFrameTextSize(size float64) error { p.frame = size; return nil }
func (p *textPlace) SetCardTextSize(card string, size float64) error {
	p.cards[card] = size
	return nil
}

// textView draws the frame row and one row of each card. A press on a row is the press of its place, and each row draws its
// text at 13 points multiplied by the factor of its place.
func textView(sizes *workbench.TextSize) func(c *ui.Context) {
	place := func(c *ui.Context, key, label string, scope workbench.TextScope, factor float64) {
		ui.Box(c.Key(key)).Size(200, 60).HandleInput(func(ev ui.InputEvent) bool {
			if ev.Kind == ui.InputPointerDown {
				sizes.Press(scope)
			}
			return true
		}).Children(func() {
			ui.Text(c, label).FontSize(float32(13 * factor))
		})
	}
	return func(c *ui.Context) {
		ui.Column(c).Children(func() {
			place(c, "frame", "frame", workbench.FrameScope(), sizes.Frame())
			place(c, "a", "card a", workbench.CardScope("a"), sizes.Effective("a"))
			place(c, "b", "card b", workbench.CardScope("b"), sizes.Effective("b"))
		})
	}
}

func height(t *testing.T, tester *ui.Tester, text string) float32 {
	t.Helper()
	box, ok := tester.Find(text)
	if !ok {
		t.Fatalf("no element shows %q; texts %q", text, tester.Texts())
	}
	return box.H
}

// The scope is the place pressed last: before a press it is the focused card, a press on a card makes it that card, and a
// press on the frame makes it the frame. A change moves only the factor of the scope.
func TestTextSizeChangesThePlacePressedLast(t *testing.T) {
	place := &textPlace{focused: "a", frame: 1, cards: map[string]float64{"a": 1, "b": 1}}
	sizes := workbench.NewTextSize(place, []float64{0.5, 1, 1.5, 2})
	tester := ui.NewTester(textView(sizes), 300, 300)
	tester.Frame()
	card, other := height(t, tester, "card a"), height(t, tester, "card b")

	if err := sizes.Change(1); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if place.cards["a"] != 1.5 || place.cards["b"] != 1 || place.frame != 1 {
		t.Fatalf("the change before a press moved frame %v cards %v, want the focused card a", place.frame, place.cards)
	}
	if got := height(t, tester, "card a"); got <= card {
		t.Fatalf("card a is %v high at factor 1.5 and was %v at factor 1", got, card)
	}
	if got := height(t, tester, "card b"); got != other {
		t.Fatalf("card b changed from %v to %v", other, got)
	}

	if err := tester.Click("card b"); err != nil {
		t.Fatal(err)
	}
	if err := sizes.Change(1); err != nil {
		t.Fatal(err)
	}
	if place.cards["b"] != 1.5 || place.cards["a"] != 1.5 {
		t.Fatalf("the change after a press on card b moved cards %v", place.cards)
	}

	if err := tester.Click("frame"); err != nil {
		t.Fatal(err)
	}
	if err := sizes.Change(1); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if place.frame != 1.5 || place.cards["a"] != 1.5 || place.cards["b"] != 1.5 {
		t.Fatalf("the change after a press on the frame moved frame %v cards %v", place.frame, place.cards)
	}
	// A card's effective factor is the frame factor multiplied by the card factor.
	if got := sizes.Effective("a"); got != 2.25 {
		t.Fatalf("the effective factor of card a is %v, want 2.25", got)
	}

	if err := sizes.Change(0); err != nil {
		t.Fatal(err)
	}
	if place.frame != 1 {
		t.Fatalf("the reset left the frame factor at %v", place.frame)
	}
}

// A window without a focused card has the frame as its scope.
func TestTextScopeWithoutAFocusedCardIsTheFrame(t *testing.T) {
	sizes := workbench.NewTextSize(&textPlace{frame: 1, cards: map[string]float64{}}, []float64{1, 2})
	if got := sizes.Scope(); got != workbench.FrameScope() {
		t.Fatalf("the scope is %+v, want the frame", got)
	}
}

// Moving further from an end step leaves the value, and a value that is not a step is an error.
func TestNextTextSizeStopsAtTheEnds(t *testing.T) {
	steps := []float64{0.5, 1, 3}
	for _, c := range []struct {
		value     float64
		direction int
		want      float64
	}{{3, 1, 3}, {0.5, -1, 0.5}, {3, 0, 1}, {1, 1, 3}, {1, -1, 0.5}} {
		got, err := workbench.NextTextSize(steps, c.value, c.direction)
		if err != nil || got != c.want {
			t.Fatalf("NextTextSize(%v, %d) = %v, %v, want %v", c.value, c.direction, got, err, c.want)
		}
	}
	for _, c := range []struct {
		value     float64
		direction int
		want      string
	}{{0.7, 1, "text size 0.7 is not a step"}, {1, 2, "text size direction 2 is invalid"}} {
		if _, err := workbench.NextTextSize(steps, c.value, c.direction); err == nil || err.Error() != c.want {
			t.Fatalf("NextTextSize(%v, %d) failed with %v, want %s", c.value, c.direction, err, c.want)
		}
	}
}

// The status reports the scope, the frame factor and each card factor in the form of core.text.
func TestTextStatusIsTheValueOfCoreText(t *testing.T) {
	place := &textPlace{focused: "a", frame: 1.5, cards: map[string]float64{"a": 2}}
	status, err := json.Marshal(workbench.NewTextSize(place, []float64{1, 1.5, 2}).Status())
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"scope":{"kind":"card","card":"a"},"frame":1.5,"cards":{"a":2}}`; string(status) != want {
		t.Fatalf("the status is %s, want %s", status, want)
	}
	framed, err := json.Marshal(workbench.FrameScope())
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"kind":"frame"}`; string(framed) != want {
		t.Fatalf("the frame scope is %s, want %s", framed, want)
	}
}

// A card scope needs a card.
func TestAPressOnACardWithoutAnIDFails(t *testing.T) {
	sizes := workbench.NewTextSize(&textPlace{frame: 1, cards: map[string]float64{}}, []float64{1})
	if err := sizes.Press(workbench.CardScope("")); err == nil || err.Error() != "a card text scope requires a card" {
		t.Fatalf("the press failed with %v", err)
	}
}

// The change of a card that the layout does not hold fails: it does not write a factor for it.
func TestTextChangeOfACardOutsideTheLayoutFails(t *testing.T) {
	place := &textPlace{frame: 1, cards: map[string]float64{"a": 1}}
	sizes := workbench.NewTextSize(place, []float64{1, 2})
	if err := sizes.Press(workbench.CardScope("gone")); err != nil {
		t.Fatal(err)
	}
	if err := sizes.Change(1); err == nil || err.Error() != "text size card gone is not in the layout" {
		t.Fatalf("the change failed with %v", err)
	}
	if len(place.cards) != 1 {
		t.Fatalf("the failed change wrote %v", place.cards)
	}
}
