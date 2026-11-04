package workbench

import (
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
	data, _ := layout.DecodeCardData(card.Data)
	if data == nil || data.ActiveTab() == nil {
		return FocusedSurface{}
	}
	active := data.ActiveTab()
	return FocusedSurface{Card: s.focused, Tab: active.ID, Plugin: active.Plugin}
}

// drawSidebarCard draws a fixed sidebar of the window at its rectangle of the plane. It has no head row: the sections start at the
// top, and the status line describes the slot. originX and originY are the origin of the plane in the window.
func (s *Shell) drawSidebarCard(c *ui.Context, id string, rect layout.Rect, inset, originX, originY float32) {
	frame, err := s.sidebars.Frame(id, s.opened().ActiveSpaceID, s.focusedSurface())
	if err != nil {
		s.errors.Show(id, err.Error(), "")
		DrawError(c, s.errors, id)
		return
	}
	box := layout.Rect{X: rect.X + float64(originX), Y: rect.Y + float64(originY), W: rect.W, H: rect.H}
	ui.Box(s.binder.Name(c, "core.card", id)).Role(ui.RoleGroup).Label(id).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).
		Size(float32(rect.W), float32(rect.H)).Background(s.palette.Card).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.palette.Radius).Clip().
		Children(func() { s.sidebars.Draw(c, frame, box) })
}
