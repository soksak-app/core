package workbench

import (
	"fmt"
	"math"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// focusedSurface returns the active tab of the focused card, which a window sidebar of its plugin follows.
func (s *Shell) focusedSurface() FocusedSurface {
	card, ok := s.plane.Card(s.focused)
	if !ok {
		return FocusedSurface{}
	}
	// silent: a card whose data cannot be read shows its error in its place, and has no tab to follow.
	data, _ := s.readCard(card)
	if data == nil || data.ActiveTab() == nil {
		return FocusedSurface{}
	}
	active := data.ActiveTab()
	return FocusedSurface{Card: s.focused, Tab: active.ID, Plugin: active.Plugin}
}

// drawSidebarCard draws a fixed sidebar of the window at its rectangle of the plane. It has no head row: the sections start at the
// top, and the frame of the sidebar ends in the status line that describes the slot. originX and originY are the origin of the plane in the window.
func (s *Shell) drawSidebarCard(c *ui.Context, id string, rect layout.Rect, inset, originX, originY float32) {
	frame, err := s.sidebars.Frame(id, s.opened().ActiveSpaceID, s.focusedSurface())
	if err != nil {
		s.errors.Show(id, err.Error(), "")
		DrawError(c, s.errors, id)
		return
	}
	// The border takes its width from every edge of the card, so the set with its status line stands in what lies inside it.
	edge := float64(s.palette.BorderWidth)
	box := layout.Rect{X: rect.X + float64(originX) + edge, Y: rect.Y + float64(originY) + edge, W: rect.W - 2*edge, H: rect.H - 2*edge}
	ui.Box(s.binder.Name(c, "core.card", id)).Role(ui.RoleGroup).Label(id).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).
		Size(float32(rect.W), float32(rect.H)).Background(s.palette.Card).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.palette.Radius).
		ObserveInput(s.placeInput(CardScope(id))).Clip().Column().Children(func() {
		ui.Box(c).Size(float32(box.W), float32(box.H)).Children(func() { s.sidebars.Draw(c, frame, box) })
	})
}

// gripThreshold is the movement in points that tells a drag from a press.
const gripThreshold = 3

// panelShapes are the icons of the sides in the 16 point box of a picker item.
var panelShapes = map[layout.Side]string{
	"top":    `<rect width="12" height="12" x="2" y="2" rx="1.5"/><path d="M2 6h12"/>`,
	"bottom": `<rect width="12" height="12" x="2" y="2" rx="1.5"/><path d="M2 10h12"/>`,
	"left":   `<rect width="12" height="12" x="2" y="2" rx="1.5"/><path d="M6 2v12"/>`,
	"right":  `<rect width="12" height="12" x="2" y="2" rx="1.5"/><path d="M10 2v12"/>`,
}

// cardSideParam is the parameter of the card sidebar commands.
type cardSideParam struct {
	Card string  `json:"card"`
	Side string  `json:"side"`
	Set  string  `json:"set,omitempty"`
	Size float64 `json:"size,omitempty"`
}

// cardSide is a side that a card shows.
type cardSide struct {
	set   *SidebarSet
	shown layout.PresentedSidebar
}

// cardSides are the sides of a card in a build.
type cardSides struct {
	owner   FocusedSurface
	divider float32
	shown   map[layout.Side]cardSide
	// fold is the status line text of the sides folded for lack of space.
	fold string
}

// extent is what side takes of the card on its axis: its shown size, or the divider of a folded side.
func (sides cardSides) extent(side layout.Side) float32 {
	current, ok := sides.shown[side]
	switch {
	case !ok:
		return 0
	case current.shown.Collapsed || current.shown.ShownSize == nil:
		return sides.divider
	}
	// The side stands in a card on whole points, and the content beside it takes the rest of the card.
	return float32(math.Round(*current.shown.ShownSize))
}

// heldGrip is a press on the grip of a side, in window coordinates.
type heldGrip struct {
	item    string
	x, y    float64
	base    float64
	folded  bool
	dragged bool
}

// sidebarSizes returns the sizes of a card sidebar that the settings hold.
func (s *Shell) sidebarSizes() layout.SidebarDefaults {
	number := func(key string) float64 {
		value, _ := s.settings.Value(key).(float64) // silent: the store checks that each of these settings is a number.
		return value
	}
	return layout.SidebarDefaults{Size: number("sidebarWidth"), Min: number("sidebarMinWidth"), Max: number("sidebarMaxWidth")}
}

// presentCard returns the sides that the card shows in rect.
func (s *Shell) presentCard(id string, data *layout.CardData, rect layout.Rect) (map[layout.Side]layout.PresentedSidebar, error) {
	requested := map[layout.Side]layout.SidebarRequest{}
	for _, side := range layout.SidebarSides {
		current, err := layout.EffectiveSidebar(id, data, side, s.sidebarSizes(), s.linkedSide(data, side))
		if err != nil {
			return nil, err
		}
		if current != nil {
			requested[side] = layout.SidebarRequest{Set: &current.Set, Size: current.Size, Collapsed: current.Collapsed}
		}
	}
	sizes := s.sidebarSizes()
	return layout.PresentSidebars(requested, rect, layout.SidebarMetrics{Header: float64(s.metrics.headH), Footer: float64(s.metrics.footH),
		Border: float64(s.palette.BorderWidth), Divider: s.sidebars.divider, Minimum: s.plane.MinSize(), SidebarMinimum: sizes.Min},
		s.operated[id])
}

// linkedSide returns the set that the plugin of the active tab links to side.
func (s *Shell) linkedSide(data *layout.CardData, side layout.Side) *string {
	active := data.ActiveTab()
	if active == nil {
		return nil
	}
	return s.sidebars.linkedCard(side, active.Plugin)
}

// cardSides returns the sides of the card in rect.
func (s *Shell) cardSides(id string, data *layout.CardData, rect layout.Rect) (cardSides, error) {
	presented, err := s.presentCard(id, data, rect)
	if err != nil {
		return cardSides{}, err
	}
	sides := cardSides{owner: FocusedSurface{Card: id}, divider: float32(s.sidebars.divider), shown: map[layout.Side]cardSide{},
		fold: layout.SpaceFoldText(presented)}
	if active := data.ActiveTab(); active != nil {
		sides.owner.Tab, sides.owner.Plugin = active.ID, active.Plugin
	}
	for side, shown := range presented {
		set := s.sidebars.set(*shown.Set)
		if set == nil {
			return cardSides{}, fmt.Errorf("unknown sidebar set %s", *shown.Set)
		}
		sides.shown[side] = cardSide{set: set, shown: shown}
	}
	return sides, nil
}

// drawCardSide draws side at the box of width and height, whose top left stands at x and y of the window.
func (s *Shell) drawCardSide(c *ui.Context, id string, sides cardSides, side layout.Side, x, y, width, height float32) {
	current, ok := sides.shown[side]
	if !ok {
		return
	}
	frame := s.sidebars.CardFrame(current.set, s.opened().ActiveSpaceID, side, sides.owner)
	ui.Box(c).Size(width, height).Background(s.palette.Card).Children(func() {
		if current.shown.Collapsed {
			s.sidebars.Hide(c, frame)
		} else {
			s.sidebars.Draw(c, frame, layout.Rect{X: float64(x), Y: float64(y), W: float64(width), H: float64(height)})
		}
		s.drawGrip(c, id, side, current.shown, x, y, width, height, sides.extent(side))
	})
}

// drawGrip draws the grip on the inner edge of a side: a drag sizes the side and a press folds or opens it.
func (s *Shell) drawGrip(c *ui.Context, id string, side layout.Side, shown layout.PresentedSidebar, x, y, width, height, extent float32) {
	divider := float32(s.sidebars.divider)
	border := s.palette.BorderWidth
	left, top, w, h, cursor := float32(0), float32(0), width, height, ui.CursorResizeEW
	var edges [4]float32
	switch side {
	case "left":
		left, w, edges = width-divider, divider, [4]float32{0, border, 0, 0}
	case "right":
		w, edges = divider, [4]float32{0, 0, 0, border}
	case "top":
		top, h, cursor, edges = height-divider, divider, ui.CursorResizeNS, [4]float32{0, 0, border, 0}
	case "bottom":
		h, cursor, edges = divider, ui.CursorResizeNS, [4]float32{border, 0, 0, 0}
	}
	if shown.Collapsed {
		cursor = ui.CursorPointer
	}
	name := layout.SideName(side)
	title := "끌어 크기 바꾸기 · 눌러 " + name + " 사이드바 접기"
	switch {
	case shown.AutoCollapsed:
		title = "공간 부족으로 " + name + " 사이드바 자동 접힘"
	case shown.Collapsed:
		title = "눌러 " + name + " 사이드바 펼치기"
	}
	run := s.binder.Control(c, "core.card.sidebar.grip", "core.card.sidebar.size", id+":"+side)
	box := ui.Box(c).Role(ui.RoleSplitter).Label(title).Tooltip(title).Absolute().Left(left).Top(top).Size(w, h).Cursor(cursor).
		BorderWidth(edges[0], edges[1], edges[2], edges[3]).BorderColor(s.palette.Edge).
		HandleInput(s.gripInput(id, side, float64(x+left), float64(y+top), float64(extent), shown.Collapsed, run))
	if shown.Collapsed {
		s.drawGripDots(box, side)
	}
}

// drawGripDots draws the three dots of a folded side at the center of its grip.
func (s *Shell) drawGripDots(box ui.Element, side layout.Side) {
	m := s.metrics
	color := faded(s.palette.Muted, m.gripMix)
	if box.Hovered() || box.Pressed() {
		color = s.palette.Focus
	}
	color = box.AnimateColor("dots", color, ui.Animation{Duration: m.gripTransition})
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		dx, dy := m.gripDotSpacing, float32(0)
		if side == "left" || side == "right" {
			dx, dy = 0, m.gripDotSpacing
		}
		for at := float32(-1); at <= 1; at++ {
			p.Fill(ui.Rect{X: r.X + (r.W-m.gripDot)/2 + at*dx, Y: r.Y + (r.H-m.gripDot)/2 + at*dy, W: m.gripDot, H: m.gripDot}, color, m.gripDot/2)
		}
	})
}

// gripInput handles the pointer on the grip of a side that stands at x and y of the window. The position of an event is relative to
// the element, which the size of the side moves in the next frame, so adding them gives the window coordinate.
func (s *Shell) gripInput(id string, side layout.Side, x, y, base float64, folded bool, size func(any)) func(ui.InputEvent) bool {
	item := id + ":" + side
	return func(event ui.InputEvent) bool {
		atX, atY := float64(event.X)+x, float64(event.Y)+y
		held := s.grip
		switch event.Kind {
		case ui.InputPointerDown:
			if event.Button != 0 {
				return false
			}
			s.grip = &heldGrip{item: item, x: atX, y: atY, base: base, folded: folded}
			return true
		case ui.InputPointerMove:
			if held == nil || held.item != item {
				return false
			}
			if !held.dragged && math.Hypot(atX-held.x, atY-held.y) < gripThreshold {
				return true
			}
			held.dragged = true
			delta := map[layout.Side]float64{"left": atX - held.x, "right": held.x - atX, "top": atY - held.y, "bottom": held.y - atY}[side]
			limits := s.sidebarSizes()
			// A folded side opens when the pointer reaches the minimum size, so the boundary does not run ahead of the pointer.
			if held.folded && held.base+delta < limits.Min {
				return true
			}
			size(cardSideParam{Card: id, Side: side, Size: min(limits.Max, max(limits.Min, held.base+delta))})
			return true
		case ui.InputPointerUp:
			if held == nil || held.item != item {
				return false
			}
			s.grip = nil
			if !held.dragged {
				s.binder.run("core.card.sidebar.toggle", cardSideParam{Card: id, Side: side})
			}
			return true
		}
		return false
	}
}

// drawSideToggles draws the header control of each side that the card shows, in the order of the sides.
func (s *Shell) drawSideToggles(c *ui.Context, id string, sides cardSides) {
	for _, side := range layout.SidebarSides {
		current, ok := sides.shown[side]
		if !ok {
			continue
		}
		open := !current.shown.Collapsed
		title := sideTitle(side, open)
		button := s.binder.Press(c, "core.card.sidebar.fold", "core.card.sidebar.toggle", id+":"+side, cardSideParam{Card: id, Side: side})
		s.dressHeadButton(button, title, false)
		color := s.headIconColor(button)
		if open {
			color = s.palette.Focus
		}
		button.Checked(open).Children(func() {
			ui.Icon(c, s.panelIcon(side)).Size(s.metrics.cardIcon, s.metrics.cardIcon).TextColor(color)
		})
	}
}

// sideTitle is the title of the header control of side.
func sideTitle(side layout.Side, open bool) string {
	if open {
		return layout.SideName(side) + " 사이드바 접기"
	}
	return layout.SideName(side) + " 사이드바 펼치기"
}

// sideItems are the items of the tool menu of a card for the sides that it shows.
func (s *Shell) sideItems(card string) ([]pickerItem, error) {
	data, err := s.cardData(card)
	if err != nil {
		return nil, err
	}
	rect, _ := s.cardRect(card) // silent: paneCard found the card.
	presented, err := s.presentCard(card, data, rect)
	if err != nil {
		return nil, err
	}
	var items []pickerItem
	for _, side := range layout.SidebarSides {
		if shown, ok := presented[side]; ok {
			items = append(items, pickerItem{Key: "side-" + side, Name: sideTitle(side, !shown.Collapsed), Icon: panelShapes[side], Active: !shown.Collapsed})
		}
	}
	return items, nil
}

// operate records side as the side of its axis that was operated last on the card.
func (s *Shell) operate(id string, side layout.Side) {
	axis := "height"
	if side == "left" || side == "right" {
		axis = "width"
	}
	if s.operated[id] == nil {
		s.operated[id] = map[string]layout.Side{}
	}
	s.operated[id][axis] = side
}

// registerCardSidebars registers the commands of the card sidebars.
func (s *Shell) registerCardSidebars() {
	change := func(name string, run func(id string, data *layout.CardData, value cardSideParam) error) {
		act(s, name, func(value cardSideParam) error {
			if err := s.paneCard(value.Card); err != nil {
				return err
			}
			data, err := s.cardData(value.Card)
			if err != nil {
				return err
			}
			if err := run(value.Card, data, value); err != nil {
				return err
			}
			if err := s.storeCard(value.Card, data); err != nil {
				return err
			}
			s.settle()
			return nil
		})
	}
	change("core.card.sidebar.set", func(id string, data *layout.CardData, value cardSideParam) error {
		sets, err := s.sidebars.setDocuments()
		if err != nil {
			return err
		}
		return layout.SetSidebar(id, data, value.Side, value.Set, sets)
	})
	change("core.card.sidebar.toggle", func(id string, data *layout.CardData, value cardSideParam) error {
		rect, _ := s.cardRect(id) // silent: paneCard found the card.
		presented, err := s.presentCard(id, data, rect)
		if err != nil {
			return err
		}
		shown, ok := presented[value.Side]
		if !ok {
			return fmt.Errorf("card %s has no %s sidebar", id, value.Side)
		}
		s.operate(id, value.Side)
		return layout.ToggleSidebar(id, data, value.Side, s.sidebarSizes(), s.linkedSide(data, value.Side), shown.Collapsed)
	})
	change("core.card.sidebar.size", func(id string, data *layout.CardData, value cardSideParam) error {
		s.operate(id, value.Side)
		return layout.SizeSidebar(id, data, value.Side, value.Size, s.sidebarSizes(), s.linkedSide(data, value.Side))
	})
}
