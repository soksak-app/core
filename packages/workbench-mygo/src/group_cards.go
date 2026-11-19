package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drawing of a group card (docs/spec/groups.md#drawing): a card of the existing design whose header shows the name of the group and
// the head buttons of the group, and whose body holds the child plane, which drawWork draws after it. The close menu of a group header.

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
// button, the leader button and close.
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
	return append(tools, changes(headTool{Do: "close", Status: "close", Name: "core.group.close", Command: "core.group.menu", Params: groupParam{Group: id},
		Title: names["group-menu"], Icon: "card-close"}, true))
}

// drawGroupCard draws the group card id at its rectangle of the root plane: the card, its header and the elements of its tools that the
// header folds.
func (s *Shell) drawGroupCard(c *ui.Context, id string, rect layout.Rect, inset float32) {
	record, _ := s.planes.Group(id) // silent: drawWork draws a group card of the tree.
	card := s.binder.Press(c, "core.group", "core.card.focus", id, cardParam{Card: id})
	s.anchored("core.group/"+id, card)
	card.FocusRing(false).Role(ui.RoleGroup).Label(record.Name).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).
		Size(float32(rect.W), float32(rect.H)).Background(s.palette.Card).Border(s.palette.CardBorder(), s.palette.Edge).Radius(s.palette.CardRadius()).
		Clip().Column().Draw(func(p *ui.Painter, r ui.Rect) { s.drawGroupRules(p, r, id, rect) }).Children(func() {
		edge := s.palette.CardBorder()
		inner := max(0, float32(rect.W)-2*edge)
		head, _ := cardRows(float32(rect.H)-2*edge, s.metrics.headH, 0)
		s.drawGroupHead(c, id, record.Name, inner, head)
		// The body holds the room of the child plane, whose cards drawWork draws over it.
		ui.Box(c).Size(inner, max(0, float32(rect.H)-2*edge-head))
	})
}

// drawGroupRules paints the boundary lines of the child plane of the group card id, which stands at rect of the root plane, in the body of
// the group card under the cards of the child plane. A line at the edge of the child plane goes on across the half gap around it to the
// border of the group card, as a line at the edge of the root plane goes on to the line around the stage.
func (s *Shell) drawGroupRules(p *ui.Painter, box ui.Rect, id string, rect layout.Rect) {
	origin := s.planes.Origin(id)
	s.paintPlaneRules(p, id, ui.Rect{X: box.X + float32(origin.X-rect.X), Y: box.Y + float32(origin.Y-rect.Y)}, false)
}

// paintPlaneRules paints the boundary lines of the child plane of the group card id with its origin at body: the solid stretches and
// the crossings drawn under the cards, or with over the crossings that the setting fullRule draws over the cards.
func (s *Shell) paintPlaneRules(p *ui.Painter, id string, body ui.Rect, over bool) {
	grid, _ := s.planes.Plane(id)                     // silent: the rules are painted for a group card of the tree.
	place, _ := s.settings.Value("fullRule").(string) // silent: the settings store checks the type of the value.
	for _, rule := range grid.Rules() {
		color := s.palette.Rule
		if rule.Virtual {
			if place == "none" || (place == "over") != over {
				continue
			}
			color = faded(color, s.metrics.lineCrossingMix)
		} else if over {
			continue
		}
		p.Fill(ruleRect(rule, grid.Width(), grid.Height(), body, 0, float32(s.planes.Options().Gap/2)), color, 0)
	}
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
	ui.Row(s.binder.Name(c, "core.group.header", id)).Size(width, height).PaddingX(m.cardHeadPad).AlignItems(ui.Center).Gap(m.cardHeadGap).Clip().
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
				if tool.Do == "leader" {
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
	if s.fullscreen == "" && s.planes.CanDissolve(id) {
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
