package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The stage of a project: the cards of the plane with their head, tab strip, slot and status line, as packages/workbench/plane.js
// draws them.

// stageInset is the space around the plane: the half gap of the theme and the border of the stage.
func (s *Shell) stageInset() float32 { return s.palette.Gap + s.palette.BorderWidth }

// drawWork draws the spaces and the stage of the shown project.
func (s *Shell) drawWork(c *ui.Context, width, height float32) {
	s.surfaces.planeDrawn = true
	project := s.opened()
	DrawErrorBanner(c, s.errors)
	s.drawSpaces(c, project, width)
	stage := height - s.metrics.spaceTabH - s.metrics.tabsGap
	inset := s.stageInset()
	s.plane.Resize(float64(width-2*inset), float64(stage-2*inset))
	originX, originY := inset, s.chromeHeight()+s.metrics.spaceTabH+s.metrics.tabsGap+inset
	ui.Box(c).Size(width, stage).DrawOver(func(p *ui.Painter, r ui.Rect) { s.drawRail(p, r, inset) }).Children(func() {
		for _, card := range s.plane.Cards() {
			if s.fullscreen != "" && card.ID != s.fullscreen {
				continue
			}
			rect, ok := s.cardRect(card.ID)
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
		if s.fullscreen == "" {
			s.drawDividers(c, inset)
		}
	})
}

// placeNames are the status lines of the window sidebars.
var placeNames = map[string]string{"left": "왼쪽 창 사이드바", "right": "오른쪽 창 사이드바"}

// drawCard draws a card at its rectangle of the plane. originX and originY are the origin of the plane in the window.
func (s *Shell) drawCard(c *ui.Context, id string, data *layout.CardData, rect layout.Rect, inset, originX, originY float32) {
	sides, err := s.cardSides(id, data, rect)
	if err != nil {
		s.errors.Show(id, err.Error(), "")
		DrawError(c, s.errors, id)
		return
	}
	border := s.palette.Edge
	if id == s.focused && s.settings.Value("focusInd") != "corner" {
		border = s.palette.Focus
	}
	card := s.binder.Press(c, "core.card", "core.card.focus", id, cardParam{Card: id})
	card.Role(ui.RoleGroup).Label(id).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).
		Background(s.palette.Card).Border(s.palette.BorderWidth, border).Radius(s.palette.Radius).Clip().Column().Children(func() {
		// The border takes its width from every edge of the card, so the rows stand in what lies inside it.
		edge := s.palette.BorderWidth
		inner := float32(rect.W) - 2*edge
		s.drawHead(c, id, data, sides, inner)
		body := float32(rect.H) - 2*edge - s.metrics.headH
		width := inner - sides.extent("left") - sides.extent("right")
		slot := body - s.metrics.footH - sides.extent("top") - sides.extent("bottom")
		x, y := float32(rect.X)+originX+edge, float32(rect.Y)+originY+edge+s.metrics.headH
		// Left and right run from below the header to the edge of the card, and the content column lies between them.
		ui.Row(c).Size(inner, body).Children(func() {
			s.drawCardSide(c, id, sides, "left", x, y, sides.extent("left"), body)
			ui.Column(c).Size(width, body).Children(func() {
				s.drawCardSide(c, id, sides, "top", x+sides.extent("left"), y, width, sides.extent("top"))
				ui.Box(c).Size(width, slot).Children(func() {
					if active := data.ActiveTab(); active != nil {
						box := layout.Rect{X: float64(x + sides.extent("left")), Y: float64(y + sides.extent("top")), W: float64(width), H: float64(slot)}
						s.drawSeat(c, *active, box)
					}
				})
				s.drawCardSide(c, id, sides, "bottom", x+sides.extent("left"), y+sides.extent("top")+slot, width, sides.extent("bottom"))
				s.drawStatus(c, id, data, sides.fold)
			})
			s.drawCardSide(c, id, sides, "right", x+sides.extent("left")+width, y, sides.extent("right"), body)
		})
	})
}

// drawHead draws the head of a card: its tabs and its tools, folded as the width of the head allows.
func (s *Shell) drawHead(c *ui.Context, id string, data *layout.CardData, sides cardSides, width float32) {
	tabs := data.TabList()
	active := data.ActiveTab()
	widths := make([]float64, len(tabs))
	activeWidth := 0.0
	for i, tab := range tabs {
		measured, _ := c.MeasureText(0, ui.Span{Text: s.tabName(tab), Size: 12})
		widths[i] = float64(min(measured+s.tabChrome(), s.metrics.tabMaxW))
		if active != nil && tab.ID == active.ID {
			activeWidth = widths[i]
		}
	}
	const tools = 5 // The tools of a full card head: add, split x, split y, full screen and close.
	fit := layout.FitHead(layout.Head{Width: float64(width), PaddingLeft: float64(s.metrics.tabsPad), PaddingRight: float64(s.metrics.tabsPad),
		Lead: float64(s.metrics.actW), Gap: float64(s.metrics.tabsGap), ToolsWidth: float64(tools+len(sides.shown)) * float64(s.metrics.actW), MoreWidth: float64(s.metrics.actW),
		TabWidths: widths, TabGap: float64(s.metrics.tabsGap), ActiveWidth: activeWidth, Peek: float64(s.metrics.tabPeekW), MinTab: float64(s.metrics.tabMinW)})
	s.heads[id] = fit
	ui.Row(s.binder.Name(c, "core.card.header", id)).Size(width, s.metrics.headH).PaddingX(s.metrics.tabsPad).AlignItems(ui.Center).Gap(s.metrics.tabsGap).Clip().
		Role(ui.RoleGroup).Label("core.card.header").BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Rule).Children(func() {
		if fit.Fit == "ham" {
			list := s.binder.Press(c, "core.card.tab-list", "core.card.tab-list", id, cardParam{Card: id})
			s.anchored("core.card.tab-list/"+id, list)
			list.Size(s.metrics.actW, s.metrics.actH).Center().Label(fmt.Sprintf("탭 %d개", len(tabs))).Children(func() {
				ui.Text(c, "≡").FontSize(12).TextColor(s.palette.Muted)
				for _, tab := range tabs {
					s.noticeMark(c, tab.ID)
				}
			})
		}
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
			s.drawSideToggles(c, id, sides)
		}
		s.drawTools(c, id, fit.Tools != "bar")
	})
}

// tabChrome is the width of a tab outside its name: the padding of the name and the close button.
func (s *Shell) tabChrome() float32 { return 2*s.metrics.barTabGap + s.metrics.actW }

// tabName is the name that the head shows for a tab: the title its view reported, with the mark of a modified tab.
func (s *Shell) tabName(tab layout.Tab) string {
	report := s.surfaces.reports[tab.ID]
	if report == nil {
		return layout.TabName(tab, nil, false)
	}
	return layout.TabName(tab, optionalText(report.Title), report.Modified)
}

func (s *Shell) drawTab(c *ui.Context, tab layout.Tab, on bool) {
	ui.Row(c.Key("tab-" + tab.ID)).AlignItems(ui.Center).Children(func() {
		button := s.binder.Press(c, "core.card.tab", "core.tab.select", tab.ID, tabParam{tab.ID})
		s.noticeMark(c, tab.ID)
		s.barTextWithin(c, button, s.tabName(tab), on, s.metrics.tabMaxW-s.tabChrome())
		s.tabContextMenu(button, tab.ID)
		s.barText(c, s.binder.Press(c, "core.card.tab-close", "core.tab.close", tab.ID, tabParam{tab.ID}), "✕", false)
	})
}

// drawTools draws the tools of a card.
func (s *Shell) drawTools(c *ui.Context, id string, folded bool) {
	tool := func(name, command, label string, params any) {
		button := s.binder.Press(c, name, command, id, params)
		s.anchored(name+"/"+id, button)
		button.Size(s.metrics.actW, s.metrics.actH).Center().Label(label).Children(func() {
			ui.Text(c, label).FontSize(12).TextColor(s.palette.Muted)
		})
	}
	if !folded {
		tool("core.card.add", "core.card.menu", "+", menuParam{Card: id, Menu: "add"})
		tool("core.card.split-x", "core.card.menu", "┃", menuParam{Card: id, Menu: "split-x"})
		tool("core.card.split-y", "core.card.menu", "━", menuParam{Card: id, Menu: "split-y"})
		tool("core.card.fullscreen", "core.card.fullscreen", "⤢", cardParam{Card: id})
		tool("core.card.close", "core.card.close", "✕", cardParam{Card: id})
		return
	}
	tool("core.card.tools", "core.card.tools", "⋯", cardParam{Card: id})
}

// drawStatus draws the status line of a card, with the text of the sides folded for lack of space when there is one.
func (s *Shell) drawStatus(c *ui.Context, id string, data *layout.CardData, fold string) {
	ui.Row(s.binder.Name(c, "core.card.status", id)).FillWidth().Height(s.metrics.footH).PaddingX(s.metrics.tabsPad).AlignItems(ui.Center).BorderWidth(s.palette.BorderWidth, 0, 0, 0).BorderColor(s.palette.Rule).
		Role(ui.RoleStatus).Label("core.card.status").Children(func() {
		text := s.cardStatusText(data)
		if fold != "" {
			text = fold
		}
		if text != "" {
			ui.Text(c, text).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).FontSize(10).TextColor(s.palette.Muted)
		}
		if active := data.ActiveTab(); active != nil {
			if report := s.surfaces.reports[active.ID]; report != nil && report.Error != "" {
				ui.Text(c, report.Error).FontSize(10).TextColor(s.palette.No)
			}
		}
	})
}
