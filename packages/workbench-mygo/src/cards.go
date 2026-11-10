package workbench

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The stage of a project: the cards of the plane with their head, tab strip, slot and status line, as packages/workbench/plane.js
// draws them.

// stageInset is the space around the plane: the half gap of the theme and the border of the stage.
func (s *Shell) stageInset() float32 { return s.palette.Gap + s.palette.BorderWidth }

// drawWork draws the spaces and the stage of the shown project.
func (s *Shell) drawWork(c *ui.Context, width, height float32) {
	s.surfaces.drawnPlane = s.plane
	project := s.opened()
	s.workBanner = s.drawWorkError(c, width)
	s.drawSpaces(c, project, width)
	stage := height - s.workBanner - s.spaceRowHeight()
	inset := s.stageInset()
	// The plane stands on the device pixel grid, so the stage holds it moved by the part of a device pixel that the rows above and
	// left of it leave.
	shiftX, shiftY := s.alignPlane(width, stage)
	s.plane.Resize(s.planeBox.W, s.planeBox.H)
	held := float32(s.planeBox.W) + 2*inset
	heldHeight := float32(s.planeBox.H) + 2*inset
	// A column takes its width from the plane, whose size only a frame knows, so a change of the columns waits for it.
	if s.columnsChanged {
		s.columnsChanged = false
		if changed, err := s.arrangeWindowSidebars(); err != nil {
			s.fail(err)
		} else if changed {
			s.keep()
		}
	}
	origin := s.planeOrigin()
	originX, originY := float32(origin.X), float32(origin.Y)
	rules := s.plane.Rules()
	var grips []dividerGrip
	ui.Box(c).Size(width, stage).Children(func() {
		ui.Box(c).Absolute().Left(shiftX).Top(shiftY).Size(held, heldHeight).Draw(func(p *ui.Painter, r ui.Rect) { s.drawRules(p, r, inset, rules, false) }).DrawOver(func(p *ui.Painter, r ui.Rect) {
			s.drawRail(p, r, inset)
			paintGrips(p, r, inset, grips)
			s.drawRules(p, r, inset, rules, true)
		}).Children(func() {
			// The line around the stage stands where the stage does, outside the box that holds the plane on the grid.
			s.drawStageEdge(c, -shiftX, -shiftY, width, stage)
			cards := s.plane.Cards()
			s.forgetCardReads(cards)
			for _, card := range cards {
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
				if s.fullscreen != "" && card.ID != s.fullscreen {
					s.drawAbsentCard(c, card.ID, data, rect)
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
			s.keepHiddenSidebars(c)
			if s.fullscreen == "" {
				grips = s.drawDividers(c, inset)
			}
			s.drawDropPreview(c, inset)
		})
	})
	s.forgetStrips()
}

// alignPlane puts the plane of the stage of width by height on the device pixel grid of the window, as alignPlane of
// packages/workbench/device-grid.js does: whatever lies above or left of the stage, the plane starts and ends on a grid line. It
// is the one place that sets planeBox. It returns how far the plane moved right and down from where the rows leave it. A window
// whose scale cannot be read shows that failure and keeps the plane where the rows leave it.
func (s *Shell) alignPlane(width, stage float32) (float32, float32) {
	inset := s.stageInset()
	area := layout.Rect{
		X: float64(s.projectColumnWidth() + inset), Y: float64(s.chromeHeight() + s.workBanner + s.spaceRowHeight() + inset),
		W: float64(width - 2*inset), H: float64(stage - 2*inset),
	}
	s.planeBox = area
	window, err := s.windowView()
	if err != nil {
		s.failWindowRead(err)
		return 0, 0
	}
	aligned, err := layout.GridPlane(area, window.Scale)
	if err != nil {
		s.fail(err)
		return 0, 0
	}
	s.planeBox = aligned
	return float32(aligned.X - area.X), float32(aligned.Y - area.Y)
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

// cardRows sizes the head and the foot of a card of the given inner height, as the grid of the page does: each row takes its height
// while the card has room for both, and a card too low shrinks them together, sharing the height equally up to the height of a row.
func cardRows(inner, head, foot float32) (float32, float32) {
	if inner >= head+foot {
		return head, foot
	}
	inner = max(0, inner)
	shrunkHead := min(head, inner/2)
	shrunkFoot := min(foot, inner-shrunkHead)
	return min(head, inner-shrunkFoot), shrunkFoot
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
	card.ObserveInput(s.placeInput(CardScope(id)))
	s.anchored("core.card/"+id, card)
	// .card: its border says which card has the focus, without an outline.
	card.FocusRing(false).Role(ui.RoleGroup).Label(id).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).
		Background(s.palette.Card).Border(s.palette.BorderWidth, border).Radius(s.palette.Radius).Clip().Column().Children(func() {
		// The border takes its width from every edge of the card, so the rows stand in what lies inside it.
		edge := s.palette.BorderWidth
		inner := max(0, float32(rect.W)-2*edge)
		head, foot := cardRows(float32(rect.H)-2*edge, s.metrics.headH, s.metrics.footH)
		s.drawHead(c, id, data, sides, inner, head)
		body := max(0, float32(rect.H)-2*edge-head)
		width := max(0, inner-sides.extent("left")-sides.extent("right"))
		slot := max(0, body-foot-sides.extent("top")-sides.extent("bottom"))
		x, y := float32(rect.X)+originX+edge, float32(rect.Y)+originY+edge+head
		// Left and right run from below the header to the edge of the card, and the content column lies between them: the slot, the
		// top and bottom sides and the status line under them. The sides follow the slot in the order of the page, top, bottom, left
		// and right (SIDEBAR_SIDES of packages/workbench/plane.js), so the index of a side element names the same side on each host.
		left, top, bottom := sides.extent("left"), sides.extent("top"), sides.extent("bottom")
		ui.Box(c).Size(inner, body).Children(func() {
			ui.Box(c).Absolute().Left(left).Top(top).Size(width, slot).Children(func() {
				if active := data.ActiveTab(); active != nil {
					box := layout.Rect{X: float64(x + left), Y: float64(y + top), W: float64(width), H: float64(slot)}
					s.drawSeat(c, *active, box)
				}
			})
			places := map[layout.Side]layout.Rect{
				"top": {X: float64(left), W: float64(width), H: float64(top)}, "bottom": {X: float64(left), Y: float64(top + slot), W: float64(width), H: float64(bottom)},
				"left": {W: float64(left), H: float64(body)}, "right": {X: float64(left + width), W: float64(sides.extent("right")), H: float64(body)},
			}
			for _, side := range layout.SidebarSides {
				s.drawCardSide(c, id, sides, side, x, y, places[side])
			}
			ui.Column(c).Absolute().Left(left).Top(top+slot+bottom).Size(width, foot).Children(func() {
				s.drawStatus(c, id, data, sides.fold, foot)
			})
		})
	})
}

// tabCloseMark is the mark of the close button of a tab, as the page draws it.
const tabCloseMark = "✕"

// cardToolTotal is the count of the tools of a card head: add, split x, split y, full screen and close.
const cardToolTotal = 5

// drawHead draws the head of a card: its tab list button, its tabs and its tools in one group, folded as the width of the head allows
// (.chrome of packages/workbench/app.css).
func (s *Shell) drawHead(c *ui.Context, id string, data *layout.CardData, sides cardSides, width, height float32) {
	m := s.metrics
	tabs := data.TabList()
	active := data.ActiveTab()
	size, family := s.tabText()
	mark := spanWidth(c, ui.Span{Text: tabCloseMark, Size: size, Font: family})
	chrome := 2*m.tabPadX + m.tabGap + mark + 2*m.tabXPad
	widths := make([]float64, len(tabs))
	activeWidth, activeLeft, left := 0.0, 0.0, 0.0
	for i, tab := range tabs {
		measured := spanWidth(c, ui.Span{Text: s.tabName(tab), Size: size, Font: family})
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
	ui.Row(s.binder.Name(c, "core.card.header", id)).Size(width, height).PaddingX(m.cardHeadPad).AlignItems(ui.Center).Gap(m.cardHeadGap).Clip().
		Role(ui.RoleGroup).Label("core.card.header").BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.cardLine()).Children(func() {
		// What the head does not show stands out of the flow, where the gap of the head does not reach it. The tree holds what stands
		// out of the flow after what stands in it, which keeps the order of each name, as each card holds these once.
		ui.Box(c).Absolute().Size(0, 0).Children(func() {
			if s.fullscreen == id {
				s.binder.Absent(c, "core.card.tab-list", "core.card.tab-list", id, cardParam{Card: id})
			} else {
				s.binder.Absent(c, "core.card.space-apps", "core.space.apps", id, cardParam{Card: id})
			}
			if fit.Tools == "bar" {
				s.binder.Absent(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id})
			} else {
				s.drawAbsentTools(c, id, sides)
			}
		})
		if s.fullscreen == id {
			s.drawSpaceApps(c, id)
		} else {
			s.drawTabList(c, id, tabs, fit)
		}
		if fit.Fit == "ham" {
			ui.Row(c).Grow(1).Children(func() { s.drawAbsentTabs(c, tabs) })
		} else {
			state := s.stripState(id, active, activeLeft, activeWidth, left-float64(m.cardTabsGap), float64(strip), fit.Fit)
			ui.ScrollHorizontal(c.Key("strip-"+id)).Size(strip, height).Scrollbars(false).TrackScroll(state).Children(func() {
				// The tabs that the head does not show stand in the flow, which keeps their order, so a head of one tab has no gap.
				gap := m.cardTabsGap
				if fit.Fit != "strip" {
					gap = 0
				}
				ui.Row(c).FillHeight().AlignItems(ui.Center).Gap(gap).Children(func() {
					for _, tab := range tabs {
						on := active != nil && tab.ID == active.ID
						if fit.Fit == "strip" || on {
							s.drawTab(c, id, tab, on, size, min(m.tabMaxW, strip)-chrome)
						} else {
							s.drawAbsentTabs(c, []layout.Tab{tab})
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
		s.headButton(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id}, "카드 도구", s.headIcon("card-more", true), true, false)
	})
}

// cardLine is the color of the lines below the head of a card and above its foot: the rule of the plane when the cards share one line
// (.chrome and .status of packages/workbench/app.css).
func (s *Shell) cardLine() ui.Color {
	if s.palette.Gap == 0 {
		return s.palette.Rule
	}
	return s.palette.Edge
}

// drawAbsentTabs draws the elements of tabs that the head does not show.
func (s *Shell) drawAbsentTabs(c *ui.Context, tabs []layout.Tab) {
	for _, tab := range tabs {
		s.binder.Absent(c, "core.card.tab", "core.tab.select", tab.ID, tabParam{tab.ID})
		s.binder.Absent(c, "core.card.tab-close", "core.tab.close", tab.ID, tabParam{tab.ID})
	}
}

// drawAbsentTools draws the elements of the tools of a card that the head does not show.
func (s *Shell) drawAbsentTools(c *ui.Context, id string, sides cardSides) {
	for _, side := range layout.SidebarSides {
		if _, shown := sides.shown[side]; shown {
			s.binder.Absent(c, "core.card.sidebar.fold", "core.card.sidebar.toggle", id+":"+side, cardSideParam{Card: id, Side: side})
		}
	}
	for _, tool := range s.headTools(id) {
		s.binder.Absent(c, tool.Name, tool.Command, id, tool.Params).Disabled(!tool.Enabled)
	}
}

// drawAbsentCard draws the elements of a card that a full screen card hides, so each keeps its index among those of its name.
func (s *Shell) drawAbsentCard(c *ui.Context, id string, data *layout.CardData, rect layout.Rect) {
	if data == nil && !s.sidebars.Holds(id) {
		return
	}
	ui.Box(c).Absolute().Size(0, 0).Children(func() {
		s.binder.Absent(c, "core.card", "core.card.focus", id, cardParam{Card: id})
		if data == nil {
			return
		}
		sides, err := s.cardSides(id, data, rect)
		if err != nil {
			s.errors.Show(id, err.Error(), "")
			DrawError(c, s.errors, id)
			return
		}
		for _, name := range []string{"core.card.header", "core.card.status"} {
			ui.Box(s.binder.Name(c, name, id)).Size(0, 0).Role(ui.RoleGroup)
		}
		s.binder.Absent(c, "core.card.tab-list", "core.card.tab-list", id, cardParam{Card: id})
		s.binder.Absent(c, "core.card.space-apps", "core.space.apps", id, cardParam{Card: id})
		s.drawAbsentTabs(c, data.TabList())
		s.drawAbsentTools(c, id, sides)
		s.binder.Absent(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id})
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
	place.drawn = true
	if s.dragging != nil {
		return place.state // The strip holds still under a press and centres its tab after the release.
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

// radiusMiddle is --r-sm of packages/workbench/app.css, the radius of a card of a dialog.
func (s *Shell) radiusMiddle() float32 {
	return float32(math.Round(float64(s.palette.Radius * s.metrics.radiusMiddleRatio)))
}

// radiusSmall is the radius of a tab, of the group of tools and of a control inside it, --r-xs of packages/workbench/app.css.
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
func (s *Shell) drawTab(c *ui.Context, card string, tab layout.Tab, on bool, size, width float32) {
	m := s.metrics
	name := s.tabName(tab)
	line := size * m.lineHeight
	family := s.fontFamily()
	mark := spanWidth(c, ui.Span{Text: tabCloseMark, Size: size, Font: family})
	holder := ui.Box(c.Key("tab-" + tab.ID)).Shrink(0)
	color := s.palette.Muted
	if on || holder.Hovered() {
		color = s.palette.Fg
	}
	if s.dragging != nil && s.dragging.tab == tab.ID {
		holder.Opacity(m.tabDraggingOpacity)
	}
	holder.Children(func() {
		// The whole tab is the button, so a press on its padding shows the tab. A press leaves the keyboard focus where it is, and the Tab
		// key still stops here. A control does not hold a control, so the notice and the close button stand over the room it keeps for them.
		pill := s.binder.Press(c, "core.card.tab", "core.tab.select", tab.ID, tabParam{tab.ID})
		pill.KeepFocus()
		pill.AlignItems(ui.Center).Radius(s.radiusSmall()).PaddingY(m.tabPadY).Label(name).Tooltip(name)
		if on {
			pill.Background(faded(s.palette.Fg, m.chipSelMix))
		}
		s.tabContextMenu(pill, tab.ID)
		pill.HandleInput(s.tabInput(card, tab.ID, pill.Bounds()))
		s.anchored("core.card.tab/"+tab.ID, pill)
		noticed := s.tabNoticeText(tab.ID) != ""
		start := m.tabPadX
		if noticed {
			start += m.noticeDot + m.tabGap
		}
		pill.Children(func() {
			ui.Row(c).Padding(0, m.tabGap+mark+2*m.tabXPad+m.tabPadX, 0, start).Children(func() {
				ui.Text(c, name).SingleLine().Ellipsis("…").LineHeight(m.lineHeight).FontSize(size).MaxWidth(width).TextColor(color)
			})
		})
		if noticed {
			ui.Box(c).Absolute().Left(m.tabPadX).Top(m.tabPadY + (line-m.noticeDot)/2).Children(func() { s.noticeMark(c, tab.ID) })
		}
		closing := s.binder.Press(c, "core.card.tab-close", "core.tab.close", tab.ID, tabParam{tab.ID})
		closing.Absolute().Top(m.tabPadY + (line-size*m.lineHeightTight)/2).Right(m.tabPadX).PaddingX(m.tabXPad).Radius(s.radiusSmall()).Label("닫기").Tooltip("닫기")
		if closing.Hovered() {
			closing.Background(faded(s.palette.No, m.tabXHoverMix))
		} else {
			closing.Opacity(m.tabXOpacity)
		}
		closing.Children(func() {
			ui.Text(c, tabCloseMark).SingleLine().LineHeight(m.lineHeightTight).FontSize(size).TextColor(color)
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
	// The names and the refusals are those of workbench.json, which the page reads as well (docs/spec/example-model.md#card-tools).
	names := s.options.Declared.CardTools
	changes := func(tool headTool, can bool) headTool {
		tool.Enabled = !fullscreen && can
		if fullscreen {
			tool.Title = names["layout-held"]
		}
		return tool
	}
	closing := headTool{Do: "close", Status: "close", Name: "core.card.close", Command: "core.card.close", Params: cardParam{Card: id},
		Title: names["close"], Icon: "card-close"}
	canClose := s.plane.CanClose(id)
	if !canClose {
		closing.Title = names["close-refused"]
	}
	whole := headTool{Do: "fullscreen", Status: "fullscreen", Name: "core.card.fullscreen", Command: "core.card.fullscreen", Params: cardParam{Card: id},
		Title: names["fullscreen"], Icon: "card-expand", Enabled: true, Pressed: fullscreen}
	if fullscreen {
		whole.Title, whole.Icon = names["restore"], "card-restore"
	}
	return []headTool{
		changes(headTool{Do: "add", Status: "add", Name: "core.card.add", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "add"},
			Title: names["add"], Icon: "card-add"}, true),
		changes(headTool{Do: "x", Status: "split-x", Name: "core.card.split-x", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-x"},
			Title: names["split-x"], Icon: "card-split-x"}, s.plane.CanSplit(id, "x")),
		changes(headTool{Do: "y", Status: "split-y", Name: "core.card.split-y", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-y"},
			Title: names["split-y"], Icon: "card-split-y"}, s.plane.CanSplit(id, "y")),
		whole,
		changes(closing, canClose),
	}
}

// drawTools draws the tools of a card.
func (s *Shell) drawTools(c *ui.Context, id string) {
	for _, tool := range s.headTools(id) {
		button := s.headButton(c, tool.Name, tool.Command, id, tool.Params, tool.Title, s.headIcon(tool.Icon, false), tool.Enabled, tool.Pressed)
		if tool.Do == "fullscreen" {
			button.Checked(tool.Pressed)
		}
	}
}

// headButton draws a button of a card head with an icon. A pressed switch is drawn in the focus color, also under the pointer
// (.chrome__act[aria-pressed=true] of packages/workbench/app.css).
func (s *Shell) headButton(c *ui.Context, name, command, item string, params any, title string, icon *ui.SVG, enabled, pressed bool) ui.Element {
	button := s.binder.Press(c, name, command, item, params)
	s.anchored(name+"/"+item, button)
	s.dressHeadButton(button, title, !enabled)
	color := s.headIconColor(button)
	if pressed {
		color = s.palette.Focus
	}
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

// drawSurfaceStatus draws the state of the surface of the active tab at the start of the status row of the card, as setSurfaceStatus of
// packages/workbench/surface-status.js: a turning ring and the loading text of setSurfaceStatus while its view loads, a dot and the
// error through the error display once its view stopped, which records `surface status <card> <tab>: ` with the error text of
// setSurfaceStatus and the reason when it appears, and nothing once it is ready.
// A tab without a surface, the placeholder of a plugin that is not loaded, is ready.
func (s *Shell) drawSurfaceStatus(c *ui.Context, card, tab string) {
	where := "surface status " + card + " " + tab
	phase := "ready"
	reason, stopped := s.surfaces.stopped(tab)
	switch {
	case stopped:
		phase = "error"
	case s.surfaces.held[tab] != nil && s.surfaces.views[tab] == nil:
		phase = "loading"
	}
	if phase != "error" {
		s.errors.Hide(where)
	}
	if phase == "ready" {
		return
	}
	m := s.metrics
	color, text := s.palette.Muted, "불러오는 중"
	if phase == "error" {
		color, text = s.palette.No, "표면 오류 · "+reason
		s.errors.Show(where, text, "")
	}
	ui.Row(c).Shrink(0).AlignItems(ui.Center).Gap(m.surfaceStatusGap).Margin(0, m.surfaceStatusMargin, 0, 0).Children(func() {
		size, border, turn := m.spinner, m.spinnerBorder, m.spinnerTurn
		ui.Box(c).Size(size, size).Shrink(0).Draw(func(p *ui.Painter, r ui.Rect) {
			cx, cy, radius := r.X+r.W/2, r.Y+r.H/2, r.W/2
			if phase == "error" {
				var dot ui.Path
				p.FillPath(dot.Circle(cx, cy, radius), color)
				return
			}
			// The ring has its top quarter clear (border-top-color: transparent) and turns once in spinner-turn.
			at := float64(p.Now().UnixNano()%int64(turn)) / float64(turn) * 2 * math.Pi
			p.After(time.Second / 60)
			var ring ui.Path
			const steps = 24
			for i := 0; i <= steps; i++ {
				angle := at + math.Pi/4 + float64(i)/steps*1.5*math.Pi - math.Pi/2
				x, y := cx+float32(math.Cos(angle))*(radius-border/2), cy+float32(math.Sin(angle))*(radius-border/2)
				if i == 0 {
					ring.MoveTo(x, y)
				} else {
					ring.LineTo(x, y)
				}
			}
			p.StrokePath(&ring, border, color)
		})
		ui.Text(c, text).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).FontSize(s.textCaption()).TextColor(color).Label(text)
	})
}

// drawStatus draws the status line of a card at height, with the text of the sides folded for lack of space when there is one.
func (s *Shell) drawStatus(c *ui.Context, id string, data *layout.CardData, fold string, height float32) {
	ui.Row(s.binder.Name(c, "core.card.status", id)).FillWidth().Height(height).Clip().PaddingX(s.metrics.chromeGap).AlignItems(ui.Center).BorderWidth(s.palette.BorderWidth, 0, 0, 0).BorderColor(s.cardLine()).
		Role(ui.RoleStatus).Label("core.card.status").Children(func() {
		if active := data.ActiveTab(); active != nil {
			s.drawSurfaceStatus(c, id, active.ID)
		}
		text := s.cardStatusText(data)
		if fold != "" {
			text = fold
		}
		if text != "" {
			ui.Text(c, text).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).FontSize(s.textCaption()).TextColor(s.palette.Muted)
		}
		// The operation error of the active tab is shown through the error display, which records it when it appears
		// (docs/spec/plugins.md#tab-reports), as showTabError of packages/workbench/plane.js does.
		if active := data.ActiveTab(); active != nil {
			where := "tab error " + active.ID
			if report := s.surfaces.reports[active.ID]; report != nil && report.Error != "" {
				s.errors.Show(where, report.Error, "")
				ui.Text(c, report.Error).FontSize(s.textCaption()).TextColor(s.palette.No)
			} else {
				s.errors.Hide(where)
			}
		}
	})
}
