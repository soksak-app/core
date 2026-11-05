package workbench

import (
	"fmt"
	"math"
	"strings"

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
	s.workBanner = s.drawWorkError(c, width)
	s.drawSpaces(c, project, width)
	stage := height - s.workBanner - s.spaceRowHeight()
	inset := s.stageInset()
	sized := s.plane.Width() > 0
	s.plane.Resize(float64(width-2*inset), float64(stage-2*inset))
	if !sized {
		if _, err := s.arrangeWindowSidebars(); err != nil {
			s.fail(err)
		}
	}
	origin := s.planeOrigin()
	originX, originY := float32(origin.X), float32(origin.Y)
	ui.Box(c).Size(width, stage).DrawOver(func(p *ui.Painter, r ui.Rect) { s.drawRail(p, r, inset) }).Children(func() {
		cards := s.plane.Cards()
		s.forgetCardReads(cards)
		for _, card := range cards {
			if s.fullscreen != "" && card.ID != s.fullscreen {
				continue
			}
			rect, ok := s.cardRect(card.ID)
			if !ok {
				continue
			}
			data, err := s.readCard(card)
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
	s.forgetStrips()
}

// drawWorkError draws the error line above the spaces, as #applicationError of packages/workbench/app.css, and returns its height, which
// the plane gives up.
func (s *Shell) drawWorkError(c *ui.Context, width float32) float32 {
	text, ok := s.errors.Text(workbenchErrorPlace)
	if !ok {
		return 0
	}
	m := s.metrics
	_, lines := c.MeasureText(width-2*m.errorPadX, ui.Span{Text: text})
	height := lines + 2*m.errorPadY + m.errorBorder
	ui.Column(c).Size(width, height).Padding(m.errorPadY, m.errorPadX).Background(s.palette.Bg).
		BorderWidth(0, 0, m.errorBorder, 0).BorderColor(s.palette.Edge).Children(func() {
		DrawErrorBanner(c, s.errors)
	})
	return height
}

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
	s.anchored("core.card/"+id, card)
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

// tabCloseMark is the mark of the close button of a tab, as the page draws it.
const tabCloseMark = "✕"

// cardToolTotal is the count of the tools of a card head: add, split x, split y, full screen and close.
const cardToolTotal = 5

// drawHead draws the head of a card: its tab list button, its tabs and its tools in one group, folded as the width of the head allows
// (.chrome of packages/workbench/app.css).
func (s *Shell) drawHead(c *ui.Context, id string, data *layout.CardData, sides cardSides, width float32) {
	m := s.metrics
	tabs := data.TabList()
	active := data.ActiveTab()
	size, family := s.tabText()
	mark, _ := c.MeasureText(0, ui.Span{Text: tabCloseMark, Size: size, Font: family})
	chrome := 2*m.tabPadX + m.tabGap + mark + 2*m.tabXPad
	widths := make([]float64, len(tabs))
	activeWidth, activeLeft, left := 0.0, 0.0, 0.0
	for i, tab := range tabs {
		measured, _ := c.MeasureText(0, ui.Span{Text: s.tabName(tab), Size: size, Font: family})
		spare := chrome
		if s.tabNoticeText(tab.ID) != "" {
			spare += m.noticeDot + m.tabGap
		}
		widths[i] = float64(min(measured+spare, m.tabMaxW))
		if active != nil && tab.ID == active.ID {
			activeWidth, activeLeft = widths[i], left
		}
		left += widths[i] + float64(m.cardTabsGap)
	}
	buttons := float32(cardToolTotal + len(sides.shown))
	group := buttons*m.cardButton + (buttons-1)*m.cardActsGap + 2*m.cardActsPad + 2*s.palette.BorderWidth
	fit := layout.FitHead(layout.Head{Width: float64(width), PaddingLeft: float64(m.cardHeadPad), PaddingRight: float64(m.cardHeadPad),
		Lead: float64(m.cardButton), Gap: float64(m.cardHeadGap), ToolsWidth: float64(group), MoreWidth: float64(m.cardButton),
		TabWidths: widths, TabGap: float64(m.cardTabsGap), ActiveWidth: activeWidth, Peek: float64(m.tabPeekW), MinTab: float64(m.tabMinW)})
	s.heads[id] = fit
	tools := m.cardButton
	if fit.Tools == "bar" {
		tools = group
	}
	strip := width - 2*m.cardHeadPad - m.cardButton - 2*m.cardHeadGap - tools
	ui.Row(s.binder.Name(c, "core.card.header", id)).Size(width, m.headH).PaddingX(m.cardHeadPad).AlignItems(ui.Center).Gap(m.cardHeadGap).Clip().
		Role(ui.RoleGroup).Label("core.card.header").BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.palette.Edge).Children(func() {
		if s.fullscreen == id {
			s.drawSpaceApps(c, id)
		} else {
			s.drawTabList(c, id, tabs, fit)
		}
		if fit.Fit == "ham" {
			ui.Spacer(c).Grow(1)
		} else {
			state := s.stripState(id, active, activeLeft, activeWidth, left-float64(m.cardTabsGap), float64(strip), fit.Fit)
			ui.ScrollHorizontal(c.Key("strip-"+id)).Size(strip, m.headH).Scrollbars(false).TrackScroll(state).Children(func() {
				ui.Row(c).FillHeight().AlignItems(ui.Center).Gap(m.cardTabsGap).Children(func() {
					for _, tab := range tabs {
						on := active != nil && tab.ID == active.ID
						if fit.Fit == "strip" || on {
							s.drawTab(c, tab, on, size, min(m.tabMaxW, strip)-chrome)
						}
					}
				})
			})
		}
		if fit.Tools == "bar" {
			ui.Row(c).Gap(m.cardActsGap).Padding(m.cardActsPad).Radius(s.radiusSmall()).Border(s.palette.BorderWidth, s.palette.Edge).Shrink(0).Children(func() {
				s.drawSideToggles(c, id, sides)
				s.drawTools(c, id)
			})
			return
		}
		s.headButton(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id}, "카드 도구", s.headIcon("card-more", true), true)
	})
}

// drawSpaceApps draws the button at the start of the head of a fullscreen card, which lists the tabs of the space.
func (s *Shell) drawSpaceApps(c *ui.Context, id string) {
	m := s.metrics
	apps := s.binder.Press(c, "core.card.space-apps", "core.space.apps", id, cardParam{Card: id})
	s.anchored("core.card.space-apps/"+id, apps)
	s.dressHeadButton(apps, "스페이스 앱", false)
	color := s.headIconColor(apps)
	apps.Label("스페이스 앱").Children(func() {
		ui.Icon(c, s.headIcon("card-tabs", false)).Size(m.cardIcon, m.cardIcon).TextColor(color)
	})
}

// drawTabList draws the button at the start of a head, which lists the tabs of the card, with the marks of the tabs that the head
// does not show.
func (s *Shell) drawTabList(c *ui.Context, id string, tabs []layout.Tab, fit layout.HeadFit) {
	m := s.metrics
	list := s.binder.Press(c, "core.card.tab-list", "core.card.tab-list", id, cardParam{Card: id})
	s.anchored("core.card.tab-list/"+id, list)
	s.dressHeadButton(list, "탭 목록", false)
	color := s.headIconColor(list)
	list.Label(fmt.Sprintf("탭 %d개", len(tabs))).Children(func() {
		ui.Icon(c, s.headIcon("card-tabs", false)).Size(m.cardIcon, m.cardIcon).TextColor(color)
		if fit.Fit != "ham" {
			return
		}
		ui.Box(c).Absolute().Top(m.noticeDotInset).Right(m.noticeDotInset).Children(func() {
			for _, tab := range tabs {
				s.noticeMark(c, tab.ID)
			}
		})
	})
}

// stripState returns the scroll of the tab strip of a card. It centres the active tab when the tab or the place of its centre changes,
// and otherwise leaves the strip where the wheel put it.
func (s *Shell) stripState(id string, active *layout.Tab, left, width, whole, strip float64, fit string) *ui.ScrollState {
	place, known := s.strips[id]
	if !known {
		place = &stripPlace{state: &ui.ScrollState{}}
		s.strips[id] = place
	}
	target := stripTarget{}
	if active != nil && fit == "strip" {
		target = stripTarget{tab: active.ID, to: max(0, min(left+width/2-strip/2, whole-strip))}
	}
	to := float32(target.to)
	switch {
	case place.target == target:
		if place.aim {
			// The last frame laid out the content that this tab needs, so the glide can reach it now.
			place.aim = false
			place.state.ScrollTo(to, 0, ui.Smooth)
		}
	case known && place.target.tab != target.tab && target.tab != "":
		// A chosen tab: the strip glides there. A new tab lengthens the content in this frame, so the glide takes its place again in the next.
		place.state.ScrollTo(to, 0, ui.Smooth)
		if place.aim = place.state.MaxX < to; place.aim {
			s.options.Invalidate()
		}
	case place.state.Scrolling():
		place.state.ScrollTo(to, 0, ui.Smooth)
	default:
		place.state.X = to
	}
	place.target = target
	place.drawn = true
	return place.state
}

// forgetStrips drops the scroll of the cards that this frame did not draw.
func (s *Shell) forgetStrips() {
	for id, place := range s.strips {
		if !place.drawn {
			delete(s.strips, id)
		}
		place.drawn = false
	}
}

// tabText is the size and the font of the text of a tab.
func (s *Shell) tabText() (float32, string) {
	return s.textSmall(), s.fontFamily()
}

// radiusSmall is the radius of a tab, of the group of tools and of a control inside it.
func (s *Shell) radiusSmall() float32 {
	return float32(math.Round(float64(s.palette.Radius * s.metrics.radiusSmallRatio)))
}

// tabName is the name that the head shows for a tab: the title its view reported, with the mark of a modified tab.
func (s *Shell) tabName(tab layout.Tab) string {
	report := s.surfaces.reports[tab.ID]
	if report == nil {
		return layout.TabName(tab, nil, false)
	}
	return layout.TabName(tab, optionalText(report.Title), report.Modified)
}

// drawTab draws a tab: a pill, filled only on the active tab, with its name cut to width and its close button.
func (s *Shell) drawTab(c *ui.Context, tab layout.Tab, on bool, size, width float32) {
	m := s.metrics
	name := s.tabName(tab)
	pill := ui.Row(c.Key("tab-" + tab.ID)).AlignItems(ui.Center).Radius(s.radiusSmall()).Shrink(0).PaddingY(m.tabPadY)
	color := s.palette.Muted
	if on || pill.Hovered() {
		color = s.palette.Fg
	}
	if on {
		pill.Background(faded(s.palette.Fg, m.chipSelMix))
	}
	pill.Children(func() {
		start := m.tabPadX
		if s.tabNoticeText(tab.ID) != "" {
			ui.Spacer(c).Width(m.tabPadX)
			s.noticeMark(c, tab.ID)
			start = m.tabGap
		}
		button := s.binder.Press(c, "core.card.tab", "core.tab.select", tab.ID, tabParam{tab.ID})
		s.anchored("core.card.tab/"+tab.ID, button)
		button.Padding(0, m.tabGap, 0, start).AlignItems(ui.Center).Label(name).Tooltip(name).Children(func() {
			ui.Text(c, name).SingleLine().Ellipsis("…").FontSize(size).MaxWidth(width).TextColor(color)
		})
		s.tabContextMenu(button, tab.ID)
		closing := s.binder.Press(c, "core.card.tab-close", "core.tab.close", tab.ID, tabParam{tab.ID})
		closing.PaddingX(m.tabXPad).Margin(0, m.tabPadX, 0, 0).Radius(s.radiusSmall()).Label("닫기").Tooltip("닫기")
		if closing.Hovered() {
			closing.Background(faded(s.palette.No, m.tabXHoverMix))
		} else {
			closing.Opacity(m.tabXOpacity)
		}
		closing.Children(func() {
			ui.Text(c, tabCloseMark).SingleLine().FontSize(size).TextColor(color)
		})
	})
}

// headTool is a tool of a card head with its state, as updateCardTools of the page sets it. Do is its key in the tool menu, Status its key
// in core.grid, and Name its element.
type headTool struct {
	Do, Status, Name, Command string
	Params                    any
	Title, Icon               string
	Enabled, Pressed          bool
}

// headTools returns the tools of the card id in the order of the page. A full screen card keeps the layout, so the tools that change it
// wait for the restore.
func (s *Shell) headTools(id string) []headTool {
	fullscreen := s.fullscreen == id
	const held = "전체 화면에서는 배치를 바꾸지 않는다 — 먼저 카드 배치를 복원한다"
	changes := func(tool headTool, can bool) headTool {
		tool.Enabled = !fullscreen && can
		if fullscreen {
			tool.Title = held
		}
		return tool
	}
	closing := headTool{Do: "close", Status: "close", Name: "core.card.close", Command: "core.card.close", Params: cardParam{Card: id},
		Title: "이 카드를 닫는다 — 안의 탭이 몇 개든 함께 간다", Icon: "card-close"}
	canClose := s.plane.CanClose(id)
	if !canClose {
		closing.Title = "닫을 수 없다 — 어느 이웃도 이 위치를 빈틈없이 못 메운다"
	}
	whole := headTool{Do: "fullscreen", Status: "fullscreen", Name: "core.card.fullscreen", Command: "core.card.fullscreen", Params: cardParam{Card: id},
		Title: "카드 전체 화면", Icon: "card-expand", Enabled: true, Pressed: fullscreen}
	if fullscreen {
		whole.Title, whole.Icon = "카드 배치 복원", "card-restore"
	}
	return []headTool{
		changes(headTool{Do: "add", Status: "add", Name: "core.card.add", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "add"},
			Title: "이 카드에 탭 추가 — 무엇을 띄울지 묻는다", Icon: "card-add"}, true),
		changes(headTool{Do: "x", Status: "split-x", Name: "core.card.split-x", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-x"},
			Title: "세로선으로 쪼개기 — 좌우로 나뉜다", Icon: "card-split-x"}, s.plane.CanSplit(id, "x")),
		changes(headTool{Do: "y", Status: "split-y", Name: "core.card.split-y", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-y"},
			Title: "가로선으로 쪼개기 — 위아래로 나뉜다", Icon: "card-split-y"}, s.plane.CanSplit(id, "y")),
		whole,
		changes(closing, canClose),
	}
}

// drawTools draws the tools of a card.
func (s *Shell) drawTools(c *ui.Context, id string) {
	for _, tool := range s.headTools(id) {
		button := s.headButton(c, tool.Name, tool.Command, id, tool.Params, tool.Title, s.headIcon(tool.Icon, false), tool.Enabled)
		if tool.Do == "fullscreen" {
			button.Checked(tool.Pressed)
		}
	}
}

// headButton draws a button of a card head with an icon.
func (s *Shell) headButton(c *ui.Context, name, command, item string, params any, title string, icon *ui.SVG, enabled bool) ui.Element {
	button := s.binder.Press(c, name, command, item, params)
	s.anchored(name+"/"+item, button)
	s.dressHeadButton(button, title, !enabled)
	color := s.headIconColor(button)
	button.Children(func() {
		ui.Icon(c, icon).Size(s.metrics.cardIcon, s.metrics.cardIcon).TextColor(color)
	})
	return button
}

// dressHeadButton gives a button its size, its title and its hover, or the look of a button that waits.
func (s *Shell) dressHeadButton(button ui.Element, title string, disabled bool) {
	button.Size(s.metrics.cardButton, s.metrics.cardButton).Center().Radius(s.radiusSmall()).Label(title).Tooltip(title)
	if disabled {
		button.Disabled(true).Opacity(s.metrics.disabledOpacity)
		return
	}
	if button.Hovered() {
		button.Background(faded(s.palette.Fg, s.metrics.insetMix))
	}
}

// headIconColor is the color of the icon of a button of a head.
func (s *Shell) headIconColor(button ui.Element) ui.Color {
	if button.Hovered() {
		return s.palette.Fg
	}
	return s.palette.Muted
}

// headIcon returns the declared icon name of a 16 point viewBox, drawn in strokes or, with filled, in the text color.
func (s *Shell) headIcon(name string, filled bool) *ui.SVG {
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, s.metrics.iconStroke)
	if filled {
		paint = `fill="currentColor" stroke="none"`
	}
	return s.declaredIcon("0 0 16 16", paint, s.headIconElements(name))
}

// headIconElements returns the SVG elements of the declared icon name. The half of a split icon is a filled part of its strokes.
func (s *Shell) headIconElements(name string) string {
	half := fmt.Sprintf(`fill="currentColor" stroke="none" opacity="%g"`, s.metrics.cardActHalfOpacity)
	return strings.ReplaceAll(s.options.Declared.Icons[name], `class="half"`, half)
}

// panelIcon returns the declared icon of a side of a card, on the 24 point viewBox of the icon table of the page.
func (s *Shell) panelIcon(side layout.Side) *ui.SVG {
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, s.metrics.iconStroke)
	return s.declaredIcon("0 0 24 24", paint, s.options.Declared.Icons["panel-"+string(side)])
}

// declaredIcon parses the SVG elements of a declared icon once.
func (s *Shell) declaredIcon(box, paint, elements string) *ui.SVG {
	key := box + paint + elements
	if icon, ok := s.icons[key]; ok {
		return icon
	}
	icon, err := ui.ParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="` + box + `" ` + paint + ` stroke-linecap="round" stroke-linejoin="round">` + elements + `</svg>`))
	if err != nil {
		s.fail(fmt.Errorf("icon %s: %w", elements, err))
	}
	s.icons[key] = icon
	return icon
}

// faded is color at share of its opacity, as color-mix with transparent.
func faded(color ui.Color, share float32) ui.Color {
	color.A = uint8(math.Round(float64(color.A) * float64(share)))
	return color
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
