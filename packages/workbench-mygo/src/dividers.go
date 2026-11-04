package workbench

import (
	"math"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The grab areas of the boundaries of the plane, as packages/soksak/src/dom.ts handles them: a press holds a boundary, a move moves
// it with the snap of the plane, the release merges the lines that now coincide and stores the layout, and a double press centers
// it.

// heldDivider is the boundary that a press holds. The press belongs to one element, so item stays the element of the hold while the
// plane drops lines and renumbers line, and from and base read the pointer in plane coordinates.
type heldDivider struct {
	item       string
	axis       layout.Axis
	line       int
	from, base float64
	span       layout.Divider
}

// across is how far two dividers of one axis overlap along it.
func across(a, b layout.Divider, axis layout.Axis) float64 {
	if axis == "x" {
		return min(a.Y+a.H, b.Y+b.H) - max(a.Y, b.Y)
	}
	return min(a.X+a.W, b.X+b.W) - max(a.X, b.X)
}

// carry runs change, which moves the held boundary and returns where it stands, and keeps the hold on that boundary when change
// dropped a line.
func (s *Shell) carry(change func() float64) float64 {
	held := s.held
	at := change()
	line, near := held.line, math.Inf(1)
	for k := min(held.line, len(s.plane.Lines(held.axis))-2); k >= 1; k-- {
		if off := math.Abs(s.plane.BoundaryPos(held.axis, k) - at); off < near {
			line, near = k, off
		}
	}
	held.line = line
	return at
}

// items returns the element of each divider: the key of the divider, except that the divider of the held boundary keeps the element
// of the press. A hold whose boundary has no divider any more ends.
func (s *Shell) items(dividers []layout.Divider) []string {
	out := make([]string, len(dividers))
	seat := -1
	if held := s.held; held != nil {
		best := 0.0
		for i, divider := range dividers {
			if over := across(divider, held.span, held.axis); divider.Axis == held.axis && divider.Line == held.line && over > best {
				seat, best = i, over
			}
		}
		if seat < 0 {
			s.held = nil
		}
	}
	for i, divider := range dividers {
		out[i] = divider.Key
		if i == seat {
			out[i] = s.held.item
			s.held.span = divider
		} else if s.held != nil && divider.Key == s.held.item {
			// The held element moved to another line, so the divider that took its old key must not repeat the key of the press.
			out[i] = divider.Key + ":beside"
		}
	}
	return out
}

// drawDividers draws the grab area of each boundary over the cards. inset is the origin of the plane in its parent.
func (s *Shell) drawDividers(c *ui.Context, inset float32) {
	dividers := s.plane.Dividers()
	items := s.items(dividers)
	for i, divider := range dividers {
		s.binder.Control(c, "core.divider", "core.boundary.move", items[i])
		cursor := ui.CursorResizeEW
		if divider.Axis == "y" {
			cursor = ui.CursorResizeNS
		}
		ui.Box(c).Role(ui.RoleSplitter).Absolute().Left(float32(divider.X)+inset).Top(float32(divider.Y)+inset).
			Size(float32(divider.W), float32(divider.H)).Cursor(cursor).HandleInput(s.dividerInput(divider, items[i]))
	}
}

// dividerInput handles the pointer on divider. The position of an event is relative to the element, which stands at divider until
// the next frame, so adding them gives the plane coordinate.
func (s *Shell) dividerInput(divider layout.Divider, item string) func(ui.InputEvent) bool {
	return func(event ui.InputEvent) bool {
		at := float64(event.X) + divider.X
		if divider.Axis == "y" {
			at = float64(event.Y) + divider.Y
		}
		switch event.Kind {
		case ui.InputPointerDown:
			if event.Button != 0 {
				return false
			}
			if event.Clicks == 2 {
				s.held = nil
				s.plane.CenterBoundary(divider.Axis, divider.Line)
				s.settle()
				return true
			}
			s.held = &heldDivider{item: item, axis: divider.Axis, line: divider.Line, from: at,
				base: s.plane.BoundaryPos(divider.Axis, divider.Line), span: divider}
			return true
		case ui.InputPointerMove:
			held := s.held
			if held == nil || held.item != item {
				return false
			}
			s.carry(func() float64 { return s.plane.MoveBoundary(held.axis, held.line, held.base+at-held.from, true) })
			s.options.Invalidate()
			return true
		case ui.InputPointerUp:
			held := s.held
			if held == nil || held.item != item {
				return false
			}
			s.plane.MergeCoincident(held.axis, held.line)
			s.settle()
			return true
		}
		return false
	}
}
