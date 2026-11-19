package workbench

import (
	"fmt"
	"slices"
	"strconv"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drawing of a group card (docs/spec/groups.md#drawing): a frame of the card border around its rectangle and a card header at its
// top that shows the name of the group and the head buttons of the group. The close menu of a group header.

// groupMenuElements are the elements of the buttons of a group header that open the menus of core.card.menu.
var groupMenuElements = map[string]string{"add": "core.group.add", "split-x": "core.group.split-x", "split-y": "core.group.split-y",
	"group": "core.group.wrap"}

// cardMenuElement is the element of the button that opens the menu of card: the button of a group header for a group card.
func (s *Shell) cardMenuElement(card, menu string) string {
	if s.isGroup(card) {
		return groupMenuElements[menu]
	}
	return "core.card." + menu
}

// groupHeadTools are the head buttons of the group card id in the order of docs/spec/groups.md#headers: add, the two splits, the group
// button, the leader button, fullscreen and close.
func (s *Shell) groupHeadTools(id string) []headTool {
	names := s.options.Declared.CardTools
	changes := func(tool headTool, can bool) headTool {
		tool.Enabled = s.fullscreen == "" && can
		if s.fullscreen != "" {
			tool.Title = names["layout-held"]
		}
		return tool
	}
	tools := []headTool{
		changes(headTool{Do: "add", Status: "add", Name: "core.group.add", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "add"},
			Title: names["add"], Icon: "card-add"}, true),
		changes(headTool{Do: "x", Status: "split-x", Name: "core.group.split-x", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-x"},
			Title: names["split-x"], Icon: "card-split-x"}, s.planes.CanSplit(id, "right")),
		changes(headTool{Do: "y", Status: "split-y", Name: "core.group.split-y", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-y"},
			Title: names["split-y"], Icon: "card-split-y"}, s.planes.CanSplit(id, "bottom")),
	}
	tools = append(tools, s.groupTools(id, "core.group.wrap", changes)...)
	// The fullscreen button stays enabled while its group card is fullscreen, so a second press restores the arrangement.
	fullscreen := s.fullscreen == id
	whole := headTool{Do: "fullscreen", Status: "fullscreen", Name: "core.group.fullscreen", Command: "core.card.fullscreen", Params: cardParam{Card: id},
		Title: names["fullscreen"], Icon: "card-expand", Enabled: true, Pressed: fullscreen}
	if fullscreen {
		whole.Title, whole.Icon = names["restore"], "card-restore"
	}
	tools = append(tools, whole)
	return append(tools, changes(headTool{Do: "close", Status: "close", Name: "core.group.close", Command: "core.group.menu", Params: groupParam{Group: id},
		Title: names["group-menu"], Icon: "card-close"}, true))
}

// drawGroupCard draws the group card id whose rectangle is rect (docs/spec/groups.md#drawing): its frame, the border of a card in the
// corridor half the gap around the rectangle, and its header at the top of the rectangle. The content cards inside it draw over the
// rest of the rectangle, and the grid draws its own lines between them.
func (s *Shell) drawGroupCard(c *ui.Context, id string, rect layout.Rect, inset float32) {
	record, _ := s.planes.Group(id) // silent: drawWork draws a group card of the tree.
	head, _ := s.groupHeadRect(id)  // silent: a group card has a header.
	line := s.palette.CardBorder()
	out := float32(s.plane.Gap()/2) + line/2
	card := s.binder.Press(c, "core.group", "core.card.focus", id, cardParam{Card: id})
	s.anchored("core.group/"+id, card)
	card.FocusRing(false).Role(ui.RoleGroup).Label(record.Name).Absolute().Left(float32(rect.X)+inset-out).Top(float32(rect.Y)+inset-out).
		Size(float32(rect.W)+2*out, float32(rect.H)+2*out).Border(line, s.palette.Edge).Radius(s.palette.CardRadius()).PassThrough()
	ui.Box(c).Absolute().Left(float32(head.X)+inset).Top(float32(head.Y)+inset).Size(float32(head.W), float32(head.H)).
		Background(s.palette.Card).Radius(s.palette.CardRadius()).Clip().Children(func() {
		s.drawGroupHead(c, id, record.Name, float32(head.W), float32(head.H))
	})
}

// headTolerance is how far a line may reach into a header across the line, in points: a divider at the side of a group card touches the
// end of its header by less than this.
const headTolerance = 1

// headRects are the drawn headers of the shown group cards, in the coordinates of the plane.
func (s *Shell) headRects() []layout.Rect {
	out := []layout.Rect{}
	for _, id := range s.planes.Cards() {
		if !s.planes.IsGroup(id) || !s.shownFullscreen(id) {
			continue
		}
		if head, ok := s.groupHeadRect(id); ok {
			out = append(out, head)
		}
	}
	return out
}

// clearOfHeads is the parts of the stretch [from, to] along a line of axis, which spans [a0, a1] across it, that cross no header: a
// header that the line reaches into by more than headTolerance across it takes its own stretch out of the line
// (docs/spec/groups.md#drawing).
func clearOfHeads(axis layout.Axis, a0, a1, from, to float64, heads []layout.Rect) [][2]float64 {
	parts := [][2]float64{{from, to}}
	for _, head := range heads {
		h0, h1, s0, s1 := head.X, head.X+head.W, head.Y, head.Y+head.H
		if axis == "y" {
			h0, h1, s0, s1 = head.Y, head.Y+head.H, head.X, head.X+head.W
		}
		if min(a1, h1)-max(a0, h0) <= headTolerance {
			continue
		}
		next := [][2]float64{}
		for _, part := range parts {
			if part[1] <= s0 || part[0] >= s1 {
				next = append(next, part)
				continue
			}
			if part[0] < s0 {
				next = append(next, [2]float64{part[0], s0})
			}
			if part[1] > s1 {
				next = append(next, [2]float64{s1, part[1]})
			}
		}
		parts = next
	}
	return parts
}

// planeDividers are the dividers of the grid cut where they would cross a group header: a divider of a line inside a group starts
// below the stacked headers. A divider cut in parts keeps its key on the first part, and the next parts add their index.
func (s *Shell) planeDividers() []layout.Divider {
	heads := s.headRects()
	out := []layout.Divider{}
	for _, divider := range s.plane.Dividers() {
		a0, a1, from, to := divider.X, divider.X+divider.W, divider.Y, divider.Y+divider.H
		if divider.Axis == "y" {
			a0, a1, from, to = divider.Y, divider.Y+divider.H, divider.X, divider.X+divider.W
		}
		for k, part := range clearOfHeads(divider.Axis, a0, a1, from, to, heads) {
			piece := divider
			if k > 0 {
				piece.Key = divider.Key + ":" + strconv.Itoa(k)
			}
			if divider.Axis == "y" {
				piece.X, piece.W = part[0], part[1]-part[0]
			} else {
				piece.Y, piece.H = part[0], part[1]-part[0]
			}
			out = append(out, piece)
		}
	}
	return out
}

// planeRules are the rules of the grid cut where they would cross a group header.
func (s *Shell) planeRules() []layout.Rule {
	heads := s.headRects()
	out := []layout.Rule{}
	for _, rule := range s.plane.Rules() {
		a0, a1, from, to := rule.X, rule.X+rule.W, rule.Y, rule.Y+rule.H
		if rule.Axis == "y" {
			a0, a1, from, to = rule.Y, rule.Y+rule.H, rule.X, rule.X+rule.W
		}
		for k, part := range clearOfHeads(rule.Axis, a0, a1, from, to, heads) {
			piece := rule
			if k > 0 {
				piece.Key = rule.Key + ":" + strconv.Itoa(k)
			}
			if rule.Axis == "y" {
				piece.X, piece.W = part[0], part[1]-part[0]
			} else {
				piece.Y, piece.H = part[0], part[1]-part[0]
			}
			out = append(out, piece)
		}
	}
	return out
}

// shownFullscreen tells whether the card id is drawn while a card is fullscreen: the fullscreen card and the cards inside it, or every
// card while no card is fullscreen.
func (s *Shell) shownFullscreen(id string) bool {
	return s.fullscreen == "" || id == s.fullscreen || slices.Contains(s.planes.Groups(id), s.fullscreen)
}

// groupHeadRect is the header of the group card id in the plane: at the top of its rectangle, or of the rectangle that a fullscreen
// group card gives it.
func (s *Shell) groupHeadRect(id string) (layout.Rect, bool) {
	head, ok := s.planes.HeadRect(id)
	if !ok || s.fullscreen == "" {
		return head, ok
	}
	from, _ := s.planes.Rect(id) // silent: HeadRect found the group card.
	shown, ok := s.cardRect(id)
	return layout.Rect{X: shown.X, Y: shown.Y + head.Y - from.Y, W: shown.W, H: head.H}, ok
}

// drawGroupHead draws the header of the group card id: its name in the place of the tab strip and its head buttons, folded into the tool
// menu as the width of the header allows, as the head of a content card folds them.
func (s *Shell) drawGroupHead(c *ui.Context, id, name string, width, height float32) {
	m := s.metrics
	tools := s.groupHeadTools(id)
	size, family := s.tabText()
	nameWidth := spanWidth(c, ui.Span{Text: name, Size: size, Font: family}) + 2*m.tabPadX
	buttons := float32(len(tools))
	group := buttons*m.cardButton + (buttons-1)*m.cardActsGap + 2*m.cardActsPad + 2*s.palette.BorderWidth
	fit := layout.FitHead(layout.Head{Width: float64(width), PaddingLeft: float64(m.cardHeadPad), PaddingRight: float64(m.cardHeadPad),
		Gap: float64(m.cardHeadGap), ToolsWidth: float64(group), MoreWidth: float64(m.cardButton), TabWidths: []float64{float64(nameWidth)},
		TabGap: float64(m.cardTabsGap), ActiveWidth: float64(nameWidth), Peek: float64(m.tabPeekW), MinTab: float64(m.tabMinW)})
	s.heads[id] = fit
	target := renameTarget{Kind: "group", ID: id}
	header := ui.Row(s.binder.Name(c, "core.group.header", id))
	header.Size(width, height).PaddingX(m.cardHeadPad).AlignItems(ui.Center).Gap(m.cardHeadGap).Clip().
		Role(ui.RoleGroup).Label("core.group.header").BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(s.cardLine()).Children(func() {
		ui.Box(c).Absolute().Size(0, 0).Children(func() {
			if fit.Tools == "bar" {
				s.binder.Absent(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id})
				return
			}
			for _, tool := range tools {
				s.binder.Absent(c, tool.Name, tool.Command, id, tool.Params).Disabled(!tool.Enabled)
			}
		})
		if s.renaming != nil && s.renaming.renameTarget == target {
			ui.Row(c).Grow(1).Children(func() { s.drawRenameField(c, max(0, nameWidth)) })
		} else {
			label := s.binder.Press(c, "core.group.name", "core.card.focus", id, cardParam{Card: id})
			label.KeepFocus().Grow(1).Shrink(1).AlignItems(ui.Center).PaddingX(m.tabPadX).Label(name).Tooltip(name)
			s.renameOnDoubleClick(label, target)
			// The name grows over the room that the buttons leave, so a press on the header outside its buttons drags the group card. The
			// buttons take their own presses, so only the name starts the drag, and its release ends it.
			label.HandleInput(s.groupHeadInput(id, label.Bounds()))
			label.Children(func() {
				ui.Text(c, name).SingleLine().Ellipsis("…").LineHeight(m.lineHeight).FontSize(size).TextColor(s.palette.Fg)
			})
		}
		if fit.Tools != "bar" {
			s.headButton(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id}, "카드 도구", s.headIcon("card-more", true), true, false)
			return
		}
		ui.Row(c).Gap(m.cardActsGap).Padding(m.cardActsPad).Radius(s.radiusSmall()).Border(s.palette.BorderWidth, s.palette.Edge).Shrink(0).Children(func() {
			for _, tool := range tools {
				button := s.headButton(c, tool.Name, tool.Command, id, tool.Params, tool.Title, s.headIcon(tool.Icon, false), tool.Enabled, tool.Pressed)
				if tool.Do == "fullscreen" || tool.Do == "leader" {
					button.Checked(tool.Pressed)
				}
			}
		})
	})
}

// openGroupMenu opens the close menu of the group card id under its close button, and closes it when it is open: 그룹 닫기 closes the
// group with its cards, and 그룹 풀기, shown while the dissolve would succeed, dissolves it (docs/spec/groups.md#headers).
func (s *Shell) openGroupMenu(id, anchor string) error {
	if err := s.groupCard(id); err != nil {
		return err
	}
	if !s.isGroup(id) {
		return fmt.Errorf("card %s is not a group", id)
	}
	if _, drawn := s.picker.drawn[anchor]; !drawn {
		return fmt.Errorf("group %s has no close button", id)
	}
	if s.toggled(anchor) {
		return nil
	}
	names := s.options.Declared.CardTools
	items := []pickerItem{{Key: "close", Name: names["group-close"], Icon: s.headIconElements("card-close")}}
	if s.fullscreen == "" && s.planes.IsGroup(id) {
		items = append(items, pickerItem{Key: "dissolve", Name: names["group-dissolve"], Icon: s.headIconElements("card-group")})
	}
	s.openPicker(names["group-menu"], items, func(key string) error {
		if key == "dissolve" {
			s.binder.run("core.group.dissolve", groupParam{Group: id})
			return nil
		}
		_, err := s.askedCloseCard(id)
		return err
	}).anchor = anchor
	return nil
}

// renameGroup commits the rename of a group card.
func (s *Shell) renameGroup(id, name string) error {
	if err := s.groupCard(id); err != nil {
		return err
	}
	if !s.isGroup(id) {
		return fmt.Errorf("card %s is not a group", id)
	}
	if _, err := s.planes.Rename(id, name); err != nil {
		return err
	}
	s.settle()
	return nil
}
