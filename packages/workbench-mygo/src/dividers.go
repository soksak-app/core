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

// dividerGrip is the bar that a divider shows at its center, in the coordinates of the plane.
type dividerGrip struct {
	rect  ui.Rect
	color ui.Color
}

// drawDividers draws the grab area of each boundary over the cards and returns the grips to paint over the rail. inset is the origin
// of the plane in its parent.
func (s *Shell) drawDividers(c *ui.Context, inset float32) []dividerGrip {
	dividers := s.plane.Dividers()
	items := s.items(dividers)
	grips := make([]dividerGrip, 0, len(dividers))
	m := s.metrics
	for i, divider := range dividers {
		s.binder.Control(c, "core.divider", "core.boundary.move", items[i])
		cursor, across, along := ui.CursorResizeEW, m.gripThickness, m.gripLength
		if divider.Axis == "y" {
			cursor, across, along = ui.CursorResizeNS, m.gripLength, m.gripThickness
		}
		// The focus stays where it is under a press, as a press on the element of a boundary is a drag and not a move of the keys.
		box := ui.Box(c).Role(ui.RoleSplitter).Absolute().Left(float32(divider.X)+inset).Top(float32(divider.Y)+inset).
			Size(float32(divider.W), float32(divider.H)).Cursor(cursor).Focusable().KeepFocus().FocusRing(false).
			HandleInput(s.dividerInput(divider, items[i]))
		color := faded(s.palette.Muted, m.gripMix)
		if box.Hovered() || box.FocusVisible() || (s.held != nil && s.held.item == items[i]) {
			color = s.palette.Focus
		}
		grips = append(grips, dividerGrip{
			rect:  ui.Rect{X: float32(divider.X) + (float32(divider.W)-across)/2, Y: float32(divider.Y) + (float32(divider.H)-along)/2, W: across, H: along},
			color: box.AnimateColor("grip", color, ui.Animation{Duration: m.gripTransition}),
		})
	}
	return grips
}

// paintGrips paints the grips of the dividers. The grips lie over the rail, whose outline runs along the boundaries.
func paintGrips(p *ui.Painter, stage ui.Rect, inset float32, grips []dividerGrip) {
	for _, grip := range grips {
		rect := grip.rect
		rect.X += stage.X + inset
		rect.Y += stage.Y + inset
		p.Fill(rect, grip.color, min(rect.W, rect.H)/2)
	}
}

// drawStageEdge draws the line around the stage, under the cards. Its corners are those of the rail, and a stage without a padding has
// square corners.
func (s *Shell) drawStageEdge(c *ui.Context, width, height float32) {
	border, radius := s.palette.BorderWidth, s.palette.Radius+s.palette.Gap
	if s.palette.Gap == 0 {
		radius = 0
	}
	ui.Box(c).Absolute().Left(0).Top(0).Size(width, height).BorderWidth(border, border, border, border).BorderColor(s.palette.Rule).Radius(radius).PassThrough()
}

// ruleEdge is how near the edge of the plane a rule stands to be at that edge.
const ruleEdge = 0.5

// ruleRect is where a rule of the plane stands in the stage, whose margin around the plane is inset. A rule at the edge of the plane
// goes on across the padding of the stage, bleed, to the line around the stage.
func ruleRect(rule layout.Rule, width, height float64, stage ui.Rect, inset, padding float32) ui.Rect {
	bleed := float64(padding)
	x, y, w, h := rule.X, rule.Y, rule.W, rule.H
	if rule.Axis == "x" {
		if rule.Y <= ruleEdge {
			y, h = y-bleed, h+bleed
		}
		if rule.Y+rule.H >= height-ruleEdge {
			h += bleed
		}
	} else {
		if rule.X <= ruleEdge {
			x, w = x-bleed, w+bleed
		}
		if rule.X+rule.W >= width-ruleEdge {
			w += bleed
		}
	}
	return ui.Rect{X: stage.X + inset + float32(x), Y: stage.Y + inset + float32(y), W: float32(w), H: float32(h)}
}

// drawRules paints the boundary lines. The solid stretches lie under the cards. The rest of a line, where a card crosses it, follows the
// fullRule setting: it lies under the cards, over them and their surfaces, or is not drawn. over tells which of the two layers this is.
func (s *Shell) drawRules(p *ui.Painter, stage ui.Rect, inset float32, rules []layout.Rule, over bool) {
	place, _ := s.settings.Value("fullRule").(string) // silent: the settings store checks the type of the value.
	for _, rule := range rules {
		color := s.palette.Rule
		if rule.Virtual {
			if place == "none" || (place == "over") != over {
				continue
			}
			color = faded(color, s.metrics.lineCrossingMix)
		} else if over {
			continue
		}
		p.Fill(ruleRect(rule, s.plane.Width(), s.plane.Height(), stage, inset, s.palette.Gap), color, 0)
	}
}

// dividerInput handles the pointer on divider. The position of an event is relative to the element, which stands at divider until
// the next frame, so adding them gives the plane coordinate.
func (s *Shell) dividerInput(divider layout.Divider, item string) func(ui.InputEvent) bool {
	return func(event ui.InputEvent) bool {
		if !s.drawnPlaneShown() {
			return false
		}
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
		case ui.InputKeyDown:
			return s.dividerKey(divider, event.Key)
		}
		return false
	}
}

// dividerKeyStep is how far an arrow key moves a boundary.
const dividerKeyStep = 8

// dividerKey handles a key on the focused divider: an arrow moves the boundary, and Enter or Space centers it.
func (s *Shell) dividerKey(divider layout.Divider, key ui.Key) bool {
	step := 0.0
	switch key {
	case ui.KeyEnter, ui.KeySpace:
		s.plane.CenterBoundary(divider.Axis, divider.Line)
		s.settle()
		return true
	case ui.KeyLeft, ui.KeyUp:
		step = -dividerKeyStep
	case ui.KeyRight, ui.KeyDown:
		step = dividerKeyStep
	default:
		return false
	}
	s.plane.MoveBoundary(divider.Axis, divider.Line, s.plane.BoundaryPos(divider.Axis, divider.Line)+step, true)
	s.settle()
	return true
}
