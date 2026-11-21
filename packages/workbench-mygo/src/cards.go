package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The stage of a project: the cards of the plane with their head, tab strip, slot and status line, as packages/workbench/plane.js
// draws them.

// stageInset is the space around the plane: the margin of the stage, half the gap, and the border of the stage.
func (s *Shell) stageInset() float32 { return s.palette.StagePad() + s.palette.BorderWidth }

// stageShare is how far the stage reaches over the bottom line of the space bar above it and over the right line of the project column
// at its left: at the seam the stage shares those lines and draws its own line on them, so the edge of the plane is one line on each
// side (docs/spec/settings.md#values); with a gap the stage stands beside the bars.
func (s *Shell) stageShare() (left, top float32) {
	if !s.palette.Seam() {
		return 0, 0
	}
	if s.projectColumnWidth() > 0 {
		left = s.palette.BorderWidth
	}
	return left, s.palette.BorderWidth
}

// drawWork draws the spaces and the stage of the shown project.
func (s *Shell) drawWork(c *ui.Context, width, height float32) {
	s.surfaces.drawnPlane = s.plane
	project := s.opened()
	s.drawSpaces(c, project, width)
	stage := height - s.spaceRowHeight()
	inset := s.stageInset()
	// The plane stands on the device pixel grid, so the stage holds it moved by the part of a device pixel that the rows above and
	// left of it leave.
	shiftX, shiftY := s.alignPlane(width, stage)
	shareLeft, shareTop := s.stageShare()
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
	rules := s.planeRules()
	var grips []dividerGrip
	// The stage around the plane is the frame: a press there makes the frame the scope of the text size, and a press inside the plane
	// leaves it to the cards (docs/spec/text-size.md#scope).
	planeX, planeY := shiftX-shareLeft+inset, shiftY-shareTop+inset
	ui.Box(c).Size(width, stage).ObserveInput(func(ev ui.InputEvent) {
		inside := ev.X >= planeX && ev.X < planeX+float32(s.planeBox.W) && ev.Y >= planeY && ev.Y < planeY+float32(s.planeBox.H)
		if ev.Kind == ui.InputPointerDown && !inside {
			s.pressPlace(FrameScope())
		}
	}).Children(func() {
		// A left press on the plane that lands on no card and on no header of a group card, such as on the frame or the body of a group
		// card, a gap, a seam or a divider, clears the focus (docs/spec/groups.md#focus); the name of a group header clears it by its own
		// binding, and a press on a card, a window sidebar included, keeps it. The margin of the stage around the plane is no part of the
		// plane, as on the page, where it is the padding of the stage.
		var blur func(params any)
		ui.Box(c).Absolute().Left(shiftX-shareLeft).Top(shiftY-shareTop).Size(held, heldHeight).ObserveInput(func(ev ui.InputEvent) {
			x, y := float64(ev.X-inset), float64(ev.Y-inset)
			onPlane := x >= 0 && x < s.planeBox.W && y >= 0 && y < s.planeBox.H
			// A press that reaches the plane of a frame drawn before its project closed finds no plane and changes nothing.
			if ev.Kind == ui.InputPointerDown && ev.Button == 0 && onPlane && s.requirePlane() == nil && !s.onCardOrHeader(x, y) {
				blur(focusParam{})
			}
		}).Draw(func(p *ui.Painter, r ui.Rect) { s.drawRules(p, r, inset, rules, false) }).DrawOver(func(p *ui.Painter, r ui.Rect) {
			s.drawRail(p, r, inset)
			paintGrips(p, r, inset, grips)
			s.drawRules(p, r, inset, rules, true)
		}).Children(func() {
			// The line around the stage stands where the stage does, outside the box that holds the plane on the grid, and at the seam over
			// the lines of the bars that it shares.
			s.drawStageEdge(c, -shiftX, -shiftY, width+shareLeft, stage+shareTop)
			// The plane is the element core.plane below every card. The element tree holds only an element with a role, so the role group
			// shows it there and in the window snapshot.
			blur = s.binder.Control(c, "core.plane", "core.card.focus", "")
			ui.Box(c).Absolute().Left(inset).Top(inset).Size(float32(s.planeBox.W), float32(s.planeBox.H)).Role(ui.RoleGroup).Label("core.plane")
			// Every card of every level in workbench order: a group card stands before the cards inside it, which lie over its rectangle.
			cards := s.allCards()
			s.forgetCardReads(cards)
			for _, card := range cards {
				rect, ok := s.cardRect(card.ID)
				if !ok {
					continue
				}
				if s.isGroup(card.ID) {
					if !s.shownFullscreen(card.ID) {
						ui.Box(c).Absolute().Size(0, 0).Children(func() { s.binder.Absent(c, "core.group", "core.card.focus", card.ID, focusParam{}) })
						continue
					}
					s.drawGroupCard(c, card.ID, rect, inset)
					continue
				}
				data, err := s.readCard(card)
				if err != nil {
					s.errors.Show(card.ID, err.Error(), "")
					DrawError(c, s.errors, card.ID)
					continue
				}
				if !s.shownFullscreen(card.ID) {
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
// is the one place that sets planeBox. At the seam the stage starts on the lines of the bars that it shares (stageShare). It returns
// how far the plane moved right and down from where the rows and the shared lines leave it. A window whose scale cannot be read shows
// that failure and keeps the plane where the rows leave it.
func (s *Shell) alignPlane(width, stage float32) (float32, float32) {
	inset := s.stageInset()
	left, top := s.stageShare()
	area := layout.Rect{
		X: float64(s.projectColumnWidth() + inset - left), Y: float64(s.chromeHeight() + s.spaceRowHeight() + inset - top),
		W: float64(width - 2*inset + left), H: float64(stage - 2*inset + top),
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
	focusBorder := id == s.focused && s.settings.Value("focusInd") != "corner"
	if focusBorder {
		border = s.palette.Focus
	}
	card := s.binder.Press(c, "core.card", "core.card.focus", id, cardParam{Card: id})
	card.ObserveInput(s.placeInput(CardScope(id)))
	s.anchored("core.card/"+id, card)
	// .card: its border says which card has the focus, without an outline. At the seam the card has no border of its own, and the
	// focus paints the shared line around it (the seam rules of packages/workbench/app.css).
	if focusBorder && s.palette.Seam() {
		line := s.palette.BorderWidth
		ui.Box(c).Absolute().Left(float32(rect.X)+inset-line).Top(float32(rect.Y)+inset-line).Size(float32(rect.W)+2*line, float32(rect.H)+2*line).
			Border(line, s.palette.Focus).PassThrough()
	}
	card.FocusRing(false).Role(ui.RoleGroup).Label(id).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).
		Background(s.palette.Card).Border(s.palette.CardBorder(), border).Radius(s.palette.CardRadius()).Clip().Column().Children(func() {
		// The border takes its width from every edge of the card, so the rows stand in what lies inside it.
		edge := s.palette.CardBorder()
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
	// silent: shownActivities gives the activities of the tabs, the group cards, the projects and the spaces; the tab widths read only those of the tabs.
	tabActivities, _, _, _ := s.shownActivities()
	activeWidth, activeLeft, left := 0.0, 0.0, 0.0
	for i, tab := range tabs {
		measured := spanWidth(c, ui.Span{Text: s.tabName(tab), Size: size, Font: family})
		spare := chrome
		if s.tabNoticeText(tab.ID) != "" {
			spare += m.noticeDot + m.tabGap
		}
		if tabActivities[tab.ID] != "" {
			spare += m.activityIcon + m.tabGap
		}
		widths[i] = float64(min(measured+spare, m.tabMaxW))
		if active != nil && tab.ID == active.ID {
			activeWidth, activeLeft = widths[i], left
		}
		left += widths[i] + float64(m.cardTabsGap)
	}
	buttons := float32(len(s.headTools(id)) + len(sides.shown))
	group := buttons*m.cardButton + (buttons-1)*m.cardActsGap + 2*m.cardActsPad + 2*s.palette.BorderWidth + s.pairWidth(s.headTools(id))
	kept := keptTools(s.headTools(id))
	fit := layout.FitHead(layout.Head{Width: float64(width), PaddingLeft: float64(m.cardHeadPad), PaddingRight: float64(m.cardHeadPad),
		Lead: float64(m.cardButton), Gap: float64(m.cardHeadGap), ToolsWidth: float64(group), MoreWidth: float64(m.cardButton),
		KeptWidth: float64(s.keptWidth(kept)), TabWidths: widths, TabGap: float64(m.cardTabsGap), Peek: float64(m.tabPeekW),
		MinTab: float64(m.tabMinW), Grab: float64(m.tabGrabW)})
	s.heads[id] = fit
	kept = shownKept(fit, kept)
	tools := s.moreWidth(kept)
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
				s.drawAbsentTools(c, id, sides, kept)
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
		s.drawKeptTools(c, id, kept)
		s.headButton(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id}, "카드 도구", s.headIcon("card-more", true), true, false)
	})
}

// keptTools are the tools that a header keeps beside its tool menu when the other tools fold into it, in the order of tools: the leader
// button while it is pressed, the leader mark (docs/spec/groups.md#headers), and the fullscreen toggle
// (docs/spec/example-model.md#card-tools).
func keptTools(tools []headTool) []headTool {
	var kept []headTool
	for _, tool := range tools {
		if tool.Do == "fullscreen" || (tool.Do == "leader" && tool.Pressed) {
			kept = append(kept, tool)
		}
	}
	return kept
}

// shownKept are the kept tools that a head of the stage fit shows beside its tool menu: all of kept in the stage menu, and none in the
// stage all, where the menu holds them so that a part of the tab stays (docs/spec/example-model.md#card-tabs).
func shownKept(fit layout.HeadFit, kept []headTool) []headTool {
	if fit.Tools == "menu" {
		return kept
	}
	return nil
}

// keeps tells whether kept holds the tool that do names.
func keeps(kept []headTool, do string) bool {
	for _, tool := range kept {
		if tool.Do == do {
			return true
		}
	}
	return false
}

// moreWidth is the width that a header gives its tools in the menu stage: the menu button and before it the kept tools.
func (s *Shell) moreWidth(kept []headTool) float32 {
	return s.metrics.cardButton + s.keptWidth(kept)
}

// keptWidth is the width of the kept tools beside the menu button, each with the gap of the head.
func (s *Shell) keptWidth(kept []headTool) float32 {
	return float32(len(kept)) * (s.metrics.cardButton + s.metrics.cardHeadGap)
}

// drawKeptTools draws the kept tools of the header of id before its tool menu button, while the other tools stand in the menu.
func (s *Shell) drawKeptTools(c *ui.Context, id string, kept []headTool) {
	for _, tool := range kept {
		s.headButton(c, tool.Name, tool.Command, id, tool.Params, tool.Title, s.headIcon(tool.Icon, false), tool.Enabled, tool.Pressed).Checked(tool.Pressed)
	}
}

// cardLine is the color of the lines below the head of a card and above its foot: the rule of the plane when the cards share one line
// (.chrome and .status of packages/workbench/app.css).
func (s *Shell) cardLine() ui.Color {
	if s.palette.Seam() {
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
func (s *Shell) drawAbsentTools(c *ui.Context, id string, sides cardSides, kept []headTool) {
	for _, side := range layout.SidebarSides {
		if _, shown := sides.shown[side]; shown {
			s.binder.Absent(c, "core.card.sidebar.fold", "core.card.sidebar.toggle", id+":"+side, cardSideParam{Card: id, Side: side})
		}
	}
	for _, tool := range s.headTools(id) {
		if keeps(kept, tool.Do) {
			continue
		}
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
		s.drawAbsentTools(c, id, sides, nil)
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

// tabName is the name that the head shows for a tab: the title its view reported, or the mark of its plugin and its stored name,
// with the mark of a modified tab.
func (s *Shell) tabName(tab layout.Tab) string {
	report := s.surfaces.reports[tab.ID]
	if report == nil {
		return layout.TabName(s.markedTab(tab), nil, false)
	}
	return layout.TabName(s.markedTab(tab), optionalText(report.Title), report.Modified)
}

// markedTab returns the tab with the mark of its plugin before its stored name, which the layout stores without the mark
// (docs/spec/example-model.md#card-tabs); an unknown plugin has the mark "?".
func (s *Shell) markedTab(tab layout.Tab) layout.Tab {
	mark := "?"
	if plugin := s.loadedPlugin(tab.Plugin); plugin != nil {
		mark = plugin.Mark
	}
	tab.Title = mark + " " + tab.Title
	return tab
}

// drawTab draws a tab: a pill, filled only on the active tab, with its name cut to width and its close button.
func (s *Shell) drawTab(c *ui.Context, card string, tab layout.Tab, on bool, size, width float32) {
	m := s.metrics
	name := s.tabName(tab)
	line := lineBox(size, m.lineHeight)
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
		pill.HandleInput(s.tabInput(card, tab.ID))
		s.tabBoxes[tab.ID] = pill.Bounds()
		s.anchored("core.card.tab/"+tab.ID, pill)
		noticed := s.tabNoticeText(tab.ID) != ""
		start := m.tabPadX
		if noticed {
			start += m.noticeDot + m.tabGap
		}
		// The icon of the activity of the tab stands after the notice and before the name (docs/spec/activity.md#drawing).
		// silent: shownActivities gives the activities of the tabs, the group cards, the projects and the spaces; a tab reads only those of the tabs.
		tabs, _, _, _ := s.shownActivities()
		activity, iconAt := tabs[tab.ID], start
		if activity != "" {
			start += m.activityIcon + m.tabGap
		}
		pill.Children(func() {
			ui.Row(c).Padding(0, m.tabGap+mark+2*m.tabXPad+m.tabPadX, 0, start).Children(func() {
				drawCutText(c, name, size, m.lineHeight, family, color, width)
			})
		})
		if noticed {
			ui.Box(c).Absolute().Left(m.tabPadX).Top(m.tabPadY + (line-m.noticeDot)/2).Children(func() { s.noticeMark(c, tab.ID) })
		}
		if activity != "" {
			ui.Box(c).Absolute().Left(iconAt).Top(m.tabPadY + (line-m.activityIcon)/2).Children(func() {
				s.drawActivity(c, "core.activity.tab", tab.ID, activity, m.activityIcon)
			})
		}
		closing := s.binder.Press(c, "core.card.tab-close", "core.tab.close", tab.ID, tabParam{tab.ID})
		closing.Absolute().Top(m.tabPadY + (line-lineBox(size, m.lineHeightTight))/2).Right(m.tabPadX).PaddingX(m.tabXPad).Radius(s.radiusSmall()).Label("닫기").Tooltip("닫기")
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
	canClose := s.planes.CanClose(id)
	if !canClose {
		closing.Title = names["close-refused"]
	}
	whole := headTool{Do: "fullscreen", Status: "fullscreen", Name: "core.card.fullscreen", Command: "core.card.fullscreen", Params: cardParam{Card: id},
		Title: names["fullscreen"], Icon: "card-expand", Enabled: true, Pressed: fullscreen}
	if fullscreen {
		whole.Title, whole.Icon = names["restore"], "card-restore"
	}
	tools := []headTool{
		changes(headTool{Do: "add", Status: "add", Name: "core.card.add", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "add"},
			Title: names["add"], Icon: "card-add"}, true),
		changes(headTool{Do: "x", Status: "split-x", Name: "core.card.split-x", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-x"},
			Title: names["split-x"], Icon: "card-split-x"}, s.planes.CanSplit(id, "right")),
		changes(headTool{Do: "y", Status: "split-y", Name: "core.card.split-y", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-y"},
			Title: names["split-y"], Icon: "card-split-y"}, s.planes.CanSplit(id, "bottom")),
	}
	tools = append(tools, s.groupTools(id, "core.card", changes)...)
	return append(tools, whole, changes(closing, canClose))
}

// groupTools are the group split buttons of the card id toward right and toward bottom, enabled while the group of it toward that side
// would succeed, and its leader button, shown in a plane of two or more cards and pressed on the leader (docs/spec/groups.md#headers).
// header is the prefix of the elements of its kind of header, core.card or core.group.
func (s *Shell) groupTools(id, header string, changes func(tool headTool, can bool) headTool) []headTool {
	names := s.options.Declared.CardTools
	tools := []headTool{
		changes(headTool{Do: "gx", Status: "group-x", Name: header + ".group-x", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "group-x"},
			Title: names["group-x"], Icon: "card-split-x"}, s.planes.CanGroup(id, "right")),
		changes(headTool{Do: "gy", Status: "group-y", Name: header + ".group-y", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "group-y"},
			Title: names["group-y"], Icon: "card-split-y"}, s.planes.CanGroup(id, "bottom")),
	}
	key := s.planes.Parent(id)
	if s.planes.LeadCount(key) >= 2 {
		leader, _ := s.planes.Leader(key) // silent: a level of two cards that can lead has a leader.
		tools = append(tools, changes(headTool{Do: "leader", Status: "leader", Name: "core.card.leader", Command: "core.group.leader", Params: cardParam{Card: id},
			Title: names["leader"], Icon: "card-leader", Pressed: leader == id}, true))
	}
	return tools
}

// drawTools draws the tools of a card.
func (s *Shell) drawTools(c *ui.Context, id string) {
	s.drawToolRow(c, id, s.headTools(id))
}

// drawToolRow draws the head buttons tools of the card or group card id in their order, the two group split buttons inside one frame.
func (s *Shell) drawToolRow(c *ui.Context, id string, tools []headTool) {
	draw := func(tool headTool) {
		button := s.headButton(c, tool.Name, tool.Command, id, tool.Params, tool.Title, s.headIcon(tool.Icon, false), tool.Enabled, tool.Pressed)
		if tool.Do == "fullscreen" || tool.Do == "leader" {
			button.Checked(tool.Pressed)
		}
	}
	for k := 0; k < len(tools); k++ {
		if tools[k].Do == "gx" && k+1 < len(tools) && tools[k+1].Do == "gy" {
			pair := tools[k : k+2]
			s.drawPair(c, func() {
				for _, tool := range pair {
					draw(tool)
				}
			})
			k++
			continue
		}
		draw(tools[k])
	}
}

// drawPair draws the rounded frame that encloses the two group split buttons, with the padding card-group-frame-pad between the frame
// and the buttons (docs/spec/groups.md#headers).
// The frame is a group of the element tree named by the names of its two buttons.
func (s *Shell) drawPair(c *ui.Context, buttons func()) {
	m := s.metrics
	names := s.options.Declared.CardTools
	ui.Row(c).Role(ui.RoleGroup).Label(names["group-x"]+", "+names["group-y"]).Gap(m.cardActsGap).Padding(m.groupFramePad).
		Radius(m.groupFrameRadius).Border(s.palette.BorderWidth, s.palette.Edge).Shrink(0).Children(buttons)
}

// pairWidth is what the frame of the group split buttons adds to the width of the tool row tools: its border and its padding on each
// side, or nothing for a row without the pair.
func (s *Shell) pairWidth(tools []headTool) float32 {
	for k := 0; k+1 < len(tools); k++ {
		if tools[k].Do == "gx" && tools[k+1].Do == "gy" {
			return 2 * (s.metrics.groupFramePad + s.palette.BorderWidth)
		}
	}
	return 0
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
		button.Disabled(true).Opacity(s.metrics.disabledOpacity).Cursor(ui.CursorNotAllowed)
		return
	}
	button.Cursor(ui.CursorPointer)
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

// HeadToolIcon returns the SVG elements that the head button status of the card or group card id draws, so that a test reads the icon of
// a button that the element tree names but does not describe.
func (s *Shell) HeadToolIcon(id, status string) (string, error) {
	tools := s.headTools(id)
	if s.isGroup(id) {
		tools = s.groupHeadTools(id)
	}
	for _, tool := range tools {
		if tool.Status == status {
			return s.headIconElements(tool.Icon), nil
		}
	}
	return "", fmt.Errorf("card %s has no head button %s", id, status)
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
	// The state shrinks with the status row and cuts its text with an ellipsis, so an error stays on the one line of the row; its whole
	// text is the label and the tooltip of the text.
	ui.Row(c).Shrink(1).MinWidth(0).AlignItems(ui.Center).Gap(m.surfaceStatusGap).Margin(0, m.surfaceStatusMargin, 0, 0).Children(func() {
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
			// The ring turns at each refresh of the display that shows the window, whatever its rate, as the CSS animation of the
			// JavaScript workbench does.
			p.AnimationFrame()
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
		ui.Text(c, text).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).FontSize(s.textCaption()).TextColor(color).Label(text).Tooltip(text)
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
				// The error stays on the one line of the row, cut with an ellipsis; its whole text is the label and the tooltip.
				ui.Text(c, report.Error).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).FontSize(s.textCaption()).TextColor(s.palette.No).
					Label(report.Error).Tooltip(report.Error)
			} else {
				s.errors.Hide(where)
			}
		}
	})
}

// LayoutDescription is the member layout of the window snapshot: the active space, the focused card and the tree of the content cards
// (docs/spec/exposure.md#window-snapshot).
type LayoutDescription struct {
	Space   string        `json:"space"`
	Focused *string       `json:"focused"`
	Root    *LayoutNode   `json:"root"`
	Groups  []LayoutGroup `json:"groups"`
}

// LayoutNode is a split, {direction, size, frame, children}, or a card, {card, size, frame, tabs}, of the tree of a layout description;
// the frame of a split is the smallest rectangle that holds the frames of its children.
type LayoutNode struct {
	Direction string
	Size      float64
	Children  []LayoutNode
	Card      string
	Frame     LayoutFrame
	Tabs      []LayoutTab
	// Leader tells that the card is the leader of its level, and Parent is the group card that holds it, or ""
	// (docs/spec/groups.md#status-and-queries).
	Leader bool
	Parent string
	// Group is the group of a group card node, with the tree of its members, and nil for a content card.
	Group *LayoutGroupNode
}

// LayoutGroupNode is the group of a group card node of a layout description: its name, the level and the leader of its members, and
// Root, the tree of its members inside its rectangle.
type LayoutGroupNode struct {
	Name   string      `json:"name"`
	Level  int         `json:"level"`
	Leader string      `json:"leader"`
	Root   *LayoutNode `json:"root"`
}

// LayoutGroup is a group card of the list of the group cards of a layout description: its id, name, frame, the level and the leader of
// its members, and the identifiers of its members. Leading tells that the group card leads its own level.
type LayoutGroup struct {
	Card    string      `json:"card"`
	Name    string      `json:"name"`
	Level   int         `json:"level"`
	Leader  string      `json:"leader"`
	Leading bool        `json:"leading"`
	Frame   LayoutFrame `json:"frame"`
	Members []string    `json:"members"`
}

// LayoutFrame is the frame of a card in window points.
type LayoutFrame struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// LayoutTab is a tab of a card of a layout description; Params are the stored parameters of the tab, null without them.
type LayoutTab struct {
	Tab    string          `json:"tab"`
	Plugin string          `json:"plugin"`
	Title  string          `json:"title"`
	Active bool            `json:"active"`
	Params json.RawMessage `json:"params"`
}

// MarshalJSON writes a split as {direction, size, frame, children}, a group card as {card, size, frame, leader, group} and a content
// card as {card, size, frame, tabs} with parent inside a group card and leader on the member that leads its level
// (docs/spec/exposure.md#window-snapshot).
func (n LayoutNode) MarshalJSON() ([]byte, error) {
	if n.Direction != "" {
		return json.Marshal(struct {
			Direction string       `json:"direction"`
			Size      float64      `json:"size"`
			Frame     LayoutFrame  `json:"frame"`
			Children  []LayoutNode `json:"children"`
		}{n.Direction, n.Size, n.Frame, n.Children})
	}
	if n.Group != nil {
		return json.Marshal(struct {
			Card   string           `json:"card"`
			Size   float64          `json:"size"`
			Frame  LayoutFrame      `json:"frame"`
			Leader bool             `json:"leader"`
			Group  *LayoutGroupNode `json:"group"`
		}{n.Card, n.Size, n.Frame, n.Leader, n.Group})
	}
	tabs := n.Tabs
	if tabs == nil {
		tabs = []LayoutTab{}
	}
	return json.Marshal(struct {
		Card   string      `json:"card"`
		Size   float64     `json:"size"`
		Frame  LayoutFrame `json:"frame"`
		Leader bool        `json:"leader,omitempty"`
		Parent string      `json:"parent,omitempty"`
		Tabs   []LayoutTab `json:"tabs"`
	}{n.Card, n.Size, n.Frame, n.Leader, n.Parent, tabs})
}

// LayoutDescription describes the layout of the shown space, and nil while the window shows no project. The tree comes from the lines
// and the cards of the plane (layout.Tree), and a frame is the rectangle of a card in the window, as the frame drew it.
func (s *Shell) LayoutDescription() (*LayoutDescription, error) {
	project := s.opened()
	if project == nil || s.plane == nil || s.browsing {
		return nil, nil
	}
	description := &LayoutDescription{Space: project.ActiveSpaceID}
	if _, ok := s.findCard(s.focused); ok && !isPlace(s.focused) {
		focused := s.focused
		description.Focused = &focused
	}
	root, err := s.describeLevel("")
	if err != nil {
		return nil, fmt.Errorf("the layout of space %s: %w", project.ActiveSpaceID, err)
	}
	description.Root = root
	description.Groups = s.describeGroups("", []LayoutGroup{})
	return description, nil
}

// describeLevel is the tree of the members of the level key, content cards and group cards, from the stored tree of the grid: the root
// node for the root level and the inner node of the box of a group card (layout.Grid.LevelTree), and nil for a level without a card.
func (s *Shell) describeLevel(key string) (*LayoutNode, error) {
	tree, err := s.plane.LevelTree(key)
	if err != nil || tree == nil {
		return nil, err
	}
	node, err := s.describeNode(*tree)
	if err != nil {
		return nil, err
	}
	return &node, nil
}

// describeGroups appends to out the group cards of the level key and of the levels inside them in workbench order, each with its
// frame and the identifiers of its members.
func (s *Shell) describeGroups(key string, out []LayoutGroup) []LayoutGroup {
	origin := s.planeOrigin()
	lead, _ := s.planes.Leader(key) // silent: a level without a leader has no member that carries the mark.
	for _, id := range s.planes.Members(key) {
		record, ok := s.planes.Group(id)
		if !ok {
			continue
		}
		rect, _ := s.cardRect(id) // silent: a group card has a rectangle.
		out = append(out, LayoutGroup{Card: id, Name: record.Name, Level: record.Level, Leader: record.Leader, Leading: lead == id,
			Frame: LayoutFrame{X: origin.X + rect.X, Y: origin.Y + rect.Y, Width: rect.W, Height: rect.H}, Members: s.planes.Members(id)})
		out = s.describeGroups(id, out)
	}
	return out
}

// frameAround is the smallest rectangle that holds the frames of nodes.
func frameAround(nodes []LayoutNode) LayoutFrame {
	left, top, right, bottom := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, node := range nodes {
		left, top = min(left, node.Frame.X), min(top, node.Frame.Y)
		right, bottom = max(right, node.Frame.X+node.Frame.Width), max(bottom, node.Frame.Y+node.Frame.Height)
	}
	return LayoutFrame{X: left, Y: top, Width: right - left, Height: bottom - top}
}

// describeNode is the node of the description of a node of the tree.
func (s *Shell) describeNode(node layout.TreeNode) (LayoutNode, error) {
	if node.Direction != "" {
		described := LayoutNode{Direction: node.Direction, Size: node.Size}
		for _, child := range node.Children {
			part, err := s.describeNode(child)
			if err != nil {
				return LayoutNode{}, err
			}
			described.Children = append(described.Children, part)
		}
		described.Frame = frameAround(described.Children)
		return described, nil
	}
	rect, _ := s.cardRect(node.Card) // silent: the tree holds only cards of the plane, which have a rectangle.
	origin := s.planeOrigin()
	parent := s.planes.Parent(node.Card)
	leader, _ := s.planes.Leader(parent) // silent: a level without a leader has no card that carries the mark.
	described := LayoutNode{Card: node.Card, Size: node.Size, Frame: LayoutFrame{X: origin.X + rect.X, Y: origin.Y + rect.Y, Width: rect.W, Height: rect.H},
		Leader: leader == node.Card, Parent: parent}
	if record, ok := s.planes.Group(node.Card); ok {
		inside, err := s.describeLevel(node.Card)
		if err != nil {
			return LayoutNode{}, err
		}
		described.Group = &LayoutGroupNode{Name: record.Name, Level: record.Level, Leader: record.Leader, Root: inside}
		return described, nil
	}
	data, err := s.cardData(node.Card)
	if err != nil {
		return LayoutNode{}, err
	}
	active := data.ActiveTab()
	for _, tab := range data.TabList() {
		params := tab.Rest["params"]
		if params == nil {
			params = json.RawMessage("null")
		}
		var reported *string
		if report := s.surfaces.reports[tab.ID]; report != nil {
			reported = optionalText(report.Title)
		}
		described.Tabs = append(described.Tabs, LayoutTab{Tab: tab.ID, Plugin: tab.Plugin, Title: layout.TabName(tab, reported, false),
			Active: active != nil && active.ID == tab.ID, Params: params})
	}
	return described, nil
}

// The layout operations core.layout.open, core.layout.select, core.layout.move and core.layout.close (docs/spec/cli.md#acting-on-a-layout). Each runs in
// one step of the main thread, which decides and changes the layout, so the window applies them one at a time.

// currentTarget is the name of the focused card, or of the active tab of the focused card, in a layout operation.
const currentTarget = "current"

type layoutOpenParam struct {
	Card   string          `json:"card"`
	Plugin *string         `json:"plugin"`
	Path   *string         `json:"path"`
	Params json.RawMessage `json:"params"`
	Side   *string         `json:"side"`
}

// registerLayout registers the layout operations.
func (s *Shell) registerLayout() {
	s.registerLayoutPlan()
	command(s, "core.layout.open", func(value layoutOpenParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		return s.openLayoutTab(value)
	})
	command(s, "core.layout.select", func(value tabParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		card, tab, err := s.layoutTab(value.Tab)
		if err != nil {
			return nil, err
		}
		if err := s.showLayoutTab(card, tab); err != nil {
			return nil, err
		}
		return map[string]string{"card": card, "tab": tab}, nil
	})
	command(s, "core.layout.move", func(value layoutMoveParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		return s.moveLayoutTab(value)
	})
	command(s, "core.layout.close", func(value tabParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		// No tab of the window takes the identifier of a closed tab, so a closed tab is in no layout.
		if s.closedTabs[value.Tab] {
			return closed(true), nil
		}
		_, tab, err := s.layoutTab(value.Tab)
		if err != nil {
			return nil, err
		}
		done, err := s.askedCloseTab(tab)
		return closed(done), err
	})
}

type layoutMoveParam struct {
	Tab  string  `json:"tab"`
	Card string  `json:"card"`
	Side *string `json:"side"`
}

// moveLayoutTab moves an existing tab with its surface into the target card, card or its neighbour toward the side. A target that
// already holds the tab selects it; otherwise the tab joins card as a drop on its centre does, or card splits toward the side into a
// new card with the tab as a drop on that edge does, and the only tab of a card moves its card. The tab never closes.
func (s *Shell) moveLayoutTab(value layoutMoveParam) (map[string]string, error) {
	if value.Side != nil && !splitSide(*value.Side) {
		return nil, fmt.Errorf("unknown side %s; use left, right, top or bottom", *value.Side)
	}
	from, tab, err := s.layoutTab(value.Tab)
	if err != nil {
		return nil, err
	}
	card, err := s.layoutCard(value.Card)
	if err != nil {
		return nil, err
	}
	if err := s.layoutChangeable(card); err != nil {
		return nil, err
	}
	target, zone := card, "centre"
	if value.Side != nil {
		target, zone = s.planes.Neighbour(card, *value.Side), *value.Side
	}
	holds := target == from
	if s.isGroup(target) {
		holds = slices.Contains(s.planes.ContentInside(target), from)
	}
	if target != "" && !isPlace(target) && holds {
		if err := s.showLayoutTab(from, tab); err != nil {
			return nil, err
		}
		return map[string]string{"card": from, "tab": tab}, nil
	}
	if err := s.moveTab(tab, layout.Target{card}, zone, nil); err != nil {
		return nil, err
	}
	return map[string]string{"card": s.cardOfTab(tab), "tab": tab}, nil
}

// openLayoutTab selects the first tab of the plugin with the params in the target card, or adds one to the card, or splits the card
// toward the side with it.
func (s *Shell) openLayoutTab(value layoutOpenParam) (map[string]string, error) {
	switch {
	case value.Plugin != nil && value.Path != nil:
		return nil, fmt.Errorf("core.layout.open takes plugin or path, not both")
	case value.Plugin == nil && value.Path == nil:
		return nil, fmt.Errorf("core.layout.open needs plugin or path")
	case value.Path != nil && value.Params != nil:
		return nil, fmt.Errorf("core.layout.open takes params only with plugin")
	case value.Side != nil && !splitSide(*value.Side):
		return nil, fmt.Errorf("unknown side %s; use left, right, top or bottom", *value.Side)
	}
	card, err := s.layoutCard(value.Card)
	if err != nil {
		return nil, err
	}
	if err := s.layoutChangeable(card); err != nil {
		return nil, err
	}
	var plugin string
	params := value.Params
	if value.Path != nil {
		file, err := OpenPath(*value.Path)
		if err != nil {
			return nil, err
		}
		if plugin, err = ChooseOpener(shellFiles{s}.FilePlugins(), file); err != nil {
			return nil, err
		}
		if params, err = json.Marshal(map[string]string{"path": file}); err != nil {
			return nil, err
		}
	} else {
		plugin = *value.Plugin
	}
	known, err := s.knownPlugin(plugin)
	if err != nil {
		return nil, err
	}
	checked, err := checkTabParams(known, params)
	if err != nil {
		return nil, err
	}
	targets := []string{card}
	if value.Side != nil {
		targets = []string{s.neighbour(card, *value.Side)}
	} else if s.isGroup(card) {
		// A group card selects the first equal tab among the content cards inside it in workbench order
		// (docs/spec/groups.md#card-commands-on-a-group-card).
		targets = s.planes.ContentInside(card)
	}
	for _, target := range targets {
		if target == "" || s.isGroup(target) {
			continue
		}
		tab, err := s.equalTab(target, plugin, checked)
		if err != nil {
			return nil, err
		}
		if tab != "" {
			if err := s.showLayoutTab(target, tab); err != nil {
				return nil, err
			}
			return map[string]string{"card": target, "tab": tab}, nil
		}
	}
	if value.Side != nil {
		return s.splitTab(card, *value.Side, known, checked)
	}
	tab, err := s.addTab(card, plugin, checked)
	if err != nil {
		return nil, err
	}
	return map[string]string{"card": card, "tab": tab}, nil
}

// equalTab returns the first tab of card in tab order whose plugin is plugin and whose params equal params as JSON values, nil
// and absent params being null, or "" when no tab is such.
func (s *Shell) equalTab(card, plugin string, params json.RawMessage) (string, error) {
	data, err := s.cardData(card)
	if err != nil {
		return "", err
	}
	want, err := jsonValue(params)
	if err != nil {
		return "", err
	}
	for _, tab := range data.TabList() {
		if tab.Plugin != plugin {
			continue
		}
		stored, err := jsonValue(tab.Rest["params"])
		if err != nil {
			return "", fmt.Errorf("the params of tab %s: %w", tab.ID, err)
		}
		if reflect.DeepEqual(stored, want) {
			return tab.ID, nil
		}
	}
	return "", nil
}

// jsonValue decodes text into a JSON value, so the order of members and the form of numbers make no difference, and empty text is null.
func jsonValue(text json.RawMessage) (any, error) {
	var value any
	if len(text) == 0 {
		return nil, nil
	}
	err := json.Unmarshal(text, &value)
	return value, err
}

// neighbour returns the content card of the plane of card whose edge lies on the line of the edge of card toward side and which spans the same two lines
// across that side, compared by the lines of the layout, or "" when none does.
func (s *Shell) neighbour(card, side string) string {
	other := s.planes.Neighbour(card, side)
	if isPlace(other) || s.isGroup(other) {
		return ""
	}
	return other
}

// showLayoutTab makes tab the active tab of card and focuses card, and leaves a tab that is already active in the focused card as it is.
func (s *Shell) showLayoutTab(card, tab string) error {
	data, err := s.cardData(card)
	if err != nil {
		return err
	}
	if active := data.ActiveTab(); active != nil && active.ID == tab && s.focused == card && (s.fullscreen == "" || s.fullscreen == card) {
		return nil
	}
	return s.selectTab(tab)
}

// layoutCard resolves the card of a layout operation: current is the focused card, and a card that is no content card of the plane
// fails with the place where it is.
func (s *Shell) layoutCard(id string) (string, error) {
	if id == currentTarget {
		if _, ok := s.findCard(s.focused); !ok || isPlace(s.focused) {
			return "", fmt.Errorf("card current names no card: window %s has no focused card", s.options.Name)
		}
		return s.focused, nil
	}
	if _, ok := s.findCard(id); ok && !isPlace(id) {
		return id, nil
	}
	return "", s.outOfLayout("card", id, func(cards []layout.Card) bool {
		return slices.ContainsFunc(cards, func(card layout.Card) bool { return card.ID == id && !isPlace(id) })
	})
}

// layoutTab resolves the tab of a layout operation to its card and itself: current is the active tab of the focused card, and a tab
// that is in no card of the plane fails with the place where it is.
func (s *Shell) layoutTab(id string) (string, string, error) {
	if id == currentTarget {
		card, err := s.layoutCard(id)
		if err != nil {
			return "", "", err
		}
		data, err := s.cardData(card)
		if err != nil {
			return "", "", err
		}
		if data.ActiveTab() == nil {
			return "", "", fmt.Errorf("tab current names no tab: card %s of window %s has no active tab", card, s.options.Name)
		}
		return card, data.ActiveTab().ID, nil
	}
	if card := s.cardOfTab(id); card != "" {
		return card, id, nil
	}
	return "", "", s.outOfLayout("tab", id, func(cards []layout.Card) bool {
		found := false
		eachTab(cards, func(tab layout.Tab, _ bool) { found = found || tab.ID == id })
		return found
	})
}

// outOfLayout is the failure of a card or a tab id that is not in the shown space: the other space of the shown project that holds it,
// or no space.
func (s *Shell) outOfLayout(kind, id string, holds func(cards []layout.Card) bool) error {
	project := s.opened()
	for _, space := range project.Spaces {
		if space.ID == project.ActiveSpaceID {
			continue
		}
		var stored storedLayout
		if err := json.Unmarshal(space.Layout, &stored); err != nil {
			return fmt.Errorf("space %s: %w", space.ID, err)
		}
		cards, err := stored.State.Cards()
		if err != nil {
			return fmt.Errorf("space %s: %w", space.ID, err)
		}
		if holds(cards) {
			return fmt.Errorf("%s %s is in space %s, which is not active", kind, id, space.ID)
		}
	}
	return fmt.Errorf("%s %s is not in the layout of window %s", kind, id, s.options.Name)
}

// onCardOrHeader tells whether the point x, y of the plane stands on a card that is shown, a window sidebar included, or on the header of
// a group card, whose name and buttons take their own presses.
func (s *Shell) onCardOrHeader(x, y float64) bool {
	inside := func(r layout.Rect) bool { return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H }
	for _, card := range s.allCards() {
		if s.isGroup(card.ID) {
			if head, ok := s.groupHeadRect(card.ID); ok && s.shownFullscreen(card.ID) && inside(head) {
				return true
			}
			continue
		}
		if rect, ok := s.cardRect(card.ID); ok && s.shownFullscreen(card.ID) && rect.W > 0 && inside(rect) {
			return true
		}
	}
	return false
}
