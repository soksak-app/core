package workbench

import (
	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The stage of a project: the cards of the plane with their head, tab strip, slot and status line, as packages/workbench/plane.js
// draws them.

// stageInset is the space around the plane.
func (s *Shell) stageInset() float32 { return s.palette.Gap }

// drawWork draws the spaces and the stage of the shown project.
func (s *Shell) drawWork(c *ui.Context, width, height float32) {
	project := s.opened()
	DrawErrorBanner(c, s.errors)
	s.drawSpaces(c, project, width)
	stage := height - s.metrics.spaceTabH - s.metrics.tabsGap
	inset := s.stageInset()
	s.plane.Resize(float64(width-2*inset), float64(stage-2*inset))
	originX, originY := inset, s.metrics.chromeH+s.metrics.spaceTabH+s.metrics.tabsGap+inset
	ui.Box(c).Size(width, stage).Children(func() {
		for _, card := range s.plane.Cards() {
			rect, ok := s.plane.Rect(card.ID)
			if !ok {
				continue
			}
			data, err := layout.DecodeCardData(card.Data)
			if err != nil {
				s.errors.Show(card.ID, err.Error(), "")
				DrawError(c, s.errors, card.ID)
				continue
			}
			if data == nil {
				if s.sidebars.Holds(card.ID) {
					s.drawSidebarCard(c, card.ID, rect, inset, originX, originY)
				}
				continue
			}
			s.drawCard(c, card.ID, data, rect, inset, originX, originY)
		}
		s.drawDividers(c, inset)
	})
}

// drawCard draws a card at its rectangle of the plane. originX and originY are the origin of the plane in the window.
func (s *Shell) drawCard(c *ui.Context, id string, data *layout.CardData, rect layout.Rect, inset, originX, originY float32) {
	border := s.palette.Edge
	if id == s.focused {
		border = s.palette.Focus
	}
	card := s.binder.Press(c, "core.card", "core.card.focus", id, cardParam{Card: id})
	card.Role(ui.RoleGroup).Label(id).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).
		Background(s.palette.Card).Border(s.palette.BorderWidth, border).Radius(s.palette.Radius).Clip().Column().Children(func() {
		s.drawHead(c, id, data, float32(rect.W))
		slot := float32(rect.H) - s.metrics.headH - s.metrics.footH
		ui.Box(c).Size(float32(rect.W), slot).Children(func() {
			if active := data.ActiveTab(); active != nil && s.options.Seat != nil {
				s.options.Seat(c, id, *active, layout.Rect{X: rect.X + float64(originX), Y: rect.Y + float64(originY) + float64(s.metrics.headH),
					W: rect.W, H: float64(slot)})
			}
		})
		s.drawStatus(c, id)
	})
}

// drawHead draws the head of a card: its tabs and its tools, folded as the width of the head allows.
func (s *Shell) drawHead(c *ui.Context, id string, data *layout.CardData, width float32) {
	tabs := data.TabList()
	active := data.ActiveTab()
	widths := make([]float64, len(tabs))
	activeWidth := 0.0
	for i, tab := range tabs {
		name := layout.TabName(tab, nil, false)
		measured, _ := c.MeasureText(0, ui.Span{Text: name, Size: 12})
		widths[i] = float64(measured + 2*s.metrics.barTabGap + s.metrics.actW)
		if active != nil && tab.ID == active.ID {
			activeWidth = widths[i]
		}
	}
	const tools = 5 // The tools of a full card head: add, split x, split y, full screen and close.
	fit := layout.FitHead(layout.Head{Width: float64(width), PaddingLeft: float64(s.metrics.tabsPad), PaddingRight: float64(s.metrics.tabsPad),
		Lead: 0, Gap: float64(s.metrics.tabsGap), ToolsWidth: float64(tools * s.metrics.actW), MoreWidth: float64(s.metrics.actW),
		TabWidths: widths, TabGap: float64(s.metrics.tabsGap), ActiveWidth: activeWidth, Peek: float64(s.metrics.tabPeekW), MinTab: float64(s.metrics.tabMinW)})
	ui.Row(c).Size(width, s.metrics.headH).PaddingX(s.metrics.tabsPad).AlignItems(ui.Center).Gap(s.metrics.tabsGap).Clip().
		Role(ui.RoleGroup).Label("core.card.header").BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Rule).Children(func() {
		ui.Row(c).Grow(1).Gap(s.metrics.tabsGap).AlignItems(ui.Center).Clip().Children(func() {
			for _, tab := range tabs {
				on := active != nil && tab.ID == active.ID
				if fit.Fit == "ham" || (fit.Fit == "one" && !on) {
					continue
				}
				s.drawTab(c, tab, on)
			}
		})
		if fit.Tools == "bar" {
			s.drawTools(c, id)
		}
	})
}

func (s *Shell) drawTab(c *ui.Context, tab layout.Tab, on bool) {
	name := layout.TabName(tab, nil, false)
	ui.Row(c.Key("tab-" + tab.ID)).AlignItems(ui.Center).Children(func() {
		s.barText(c, s.binder.Press(c, "core.card.tab", "core.tab.select", tab.ID, tabParam{tab.ID}), name, on)
		s.barText(c, s.binder.Press(c, "core.card.tab-close", "core.tab.close", tab.ID, tabParam{tab.ID}), "✕", false)
	})
}

// drawTools draws the tools of a card.
func (s *Shell) drawTools(c *ui.Context, id string) {
	tool := func(name, command, label string, params any) {
		button := s.binder.Press(c, name, command, id, params)
		button.Size(s.metrics.actW, s.metrics.actH).Center().Label(label).Children(func() {
			ui.Text(c, label).FontSize(12).TextColor(s.palette.Muted)
		})
	}
	tool("core.card.add", "core.card.add-tab", "+", cardParam{Card: id})
	tool("core.card.split-x", "core.card.split", "┃", cardParam{Card: id, Side: "right"})
	tool("core.card.split-y", "core.card.split", "━", cardParam{Card: id, Side: "bottom"})
	tool("core.card.close", "core.card.close", "✕", cardParam{Card: id})
}

// drawStatus draws the status line of a card.
func (s *Shell) drawStatus(c *ui.Context, id string) {
	ui.Row(c).FillWidth().Height(s.metrics.footH).PaddingX(s.metrics.tabsPad).AlignItems(ui.Center).BorderWidth(s.palette.BorderWidth, 0, 0, 0).BorderColor(s.palette.Rule).
		Role(ui.RoleStatus).Label("core.card.status").Children(func() {
		ui.Text(c, id).FontSize(10).TextColor(s.palette.Muted)
	})
}
