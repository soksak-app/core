package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
)

// The steps and the scope of the text size (docs/spec/text-size.md). The scope is the place the user pressed last: a press on a
// card makes it that card, and a press on the frame outside the plane makes it the frame. Before any press the focused card is
// the scope, and a window without a focused card has the frame as its scope.

// TextScope is a scope of the text size. Its form is the scope of the status core.text.
type TextScope struct {
	Kind string `json:"kind"`
	Card string `json:"card,omitempty"`
}

// FrameScope is the scope of the frame.
func FrameScope() TextScope { return TextScope{Kind: "frame"} }

// CardScope is the scope of card.
func CardScope(card string) TextScope { return TextScope{Kind: "card", Card: card} }

// NextTextSize moves value on the scale steps in direction: 1 is the next larger step, -1 the next smaller step and 0 is 1.
// Moving further from an end step leaves the value unchanged. A value that is not a step and any other direction are errors.
func NextTextSize(steps []float64, value float64, direction int) (float64, error) {
	if direction != 1 && direction != -1 && direction != 0 {
		return 0, fmt.Errorf("text size direction %d is invalid", direction)
	}
	index := slices.Index(steps, value)
	if index < 0 {
		return 0, fmt.Errorf("text size %v is not a step", value)
	}
	if direction == 0 {
		return 1, nil
	}
	return steps[min(len(steps)-1, max(0, index+direction))], nil
}

// TextPlace is the frame and the cards whose factors the text size reads and writes: the frame factor is the common setting
// textSize, and a card factor is the textSize of the layout data of the card.
type TextPlace interface {
	// FocusedCard is the id of the focused card, or "" when the window has none.
	FocusedCard() string
	FrameTextSize() float64
	SetFrameTextSize(size float64, actor string) error
	// CardTextSizes is the factor of each card of the layout.
	CardTextSizes() map[string]float64
	SetCardTextSize(card string, size float64) error
}

// TextStatus is the value of the status core.text.
type TextStatus struct {
	Scope TextScope          `json:"scope"`
	Frame float64            `json:"frame"`
	Cards map[string]float64 `json:"cards"`
}

// TextSize is the text size of a window: the place pressed last, over the factors of its place.
type TextSize struct {
	place   TextPlace
	steps   []float64
	pressed *TextScope
}

// NewTextSize makes the text size of place on the scale steps.
func NewTextSize(place TextPlace, steps []float64) *TextSize {
	return &TextSize{place: place, steps: steps}
}

// Press records a press on the place of scope.
func (s *TextSize) Press(scope TextScope) error {
	if scope.Kind == "card" && scope.Card == "" {
		return errors.New("a card text scope requires a card")
	}
	if scope.Kind != "card" && scope.Kind != "frame" {
		return fmt.Errorf("text scope %q is invalid", scope.Kind)
	}
	s.pressed = &scope
	return nil
}

// Scope is the scope in which the text size changes.
func (s *TextSize) Scope() TextScope {
	if s.pressed != nil {
		return *s.pressed
	}
	if card := s.place.FocusedCard(); card != "" {
		return CardScope(card)
	}
	return FrameScope()
}

// Frame is the frame factor, which the frame chrome uses.
func (s *TextSize) Frame() float64 { return s.place.FrameTextSize() }

// Effective is the factor of card: the frame factor multiplied by the card factor. A card that the layout does not hold has
// factor 1.
func (s *TextSize) Effective(card string) float64 {
	factor, ok := s.place.CardTextSizes()[card]
	if !ok {
		factor = 1
	}
	return s.Frame() * factor
}

// Change moves the factor of the scope in direction, as NextTextSize does. actor is the command that asks for it.
func (s *TextSize) Change(direction int, actor string) error {
	scope := s.Scope()
	if scope.Kind == "frame" {
		next, err := NextTextSize(s.steps, s.Frame(), direction)
		if err != nil {
			return err
		}
		return s.place.SetFrameTextSize(next, actor)
	}
	factor, ok := s.place.CardTextSizes()[scope.Card]
	if !ok {
		return fmt.Errorf("text size card %s is not in the layout", scope.Card)
	}
	next, err := NextTextSize(s.steps, factor, direction)
	if err != nil {
		return err
	}
	return s.place.SetCardTextSize(scope.Card, next)
}

// Register registers the status and the commands of the text size.
func (s *TextSize) Register(registry *Registry) {
	registry.Status("core.text", func() any { return s.Status() })
	change := func(name string, direction int) {
		registry.Command(name, func(json.RawMessage) (any, error) { return nil, s.Change(direction, name) })
	}
	change("core.text.larger", 1)
	change("core.text.smaller", -1)
	change("core.text.reset", 0)
}

// Status is the value of the status core.text.
func (s *TextSize) Status() TextStatus {
	return TextStatus{Scope: s.Scope(), Frame: s.Frame(), Cards: s.place.CardTextSizes()}
}
