package workbench

import (
	"fmt"
	"math"
	"slices"
	"strconv"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drawing of a group card (docs/spec/groups.md#drawing): a frame of the card border around its rectangle and a card header at its
// top that shows the name of the group and the head buttons of the group. The close menu of a group header.

// groupMenuElements are the elements of the buttons of a group header that open the menus of core.card.menu.
var groupMenuElements = map[string]string{"split-x": "core.group.split-x", "split-y": "core.group.split-y",
	"group-x": "core.group.group-x", "group-y": "core.group.group-y"}

// cardMenuElement is the element of the button that opens the menu of card: the button of a group header for a group card.
func (s *Shell) cardMenuElement(card, menu string) string {
	if s.isGroup(card) {
		return groupMenuElements[menu]
	}
	return "core.card." + menu
}

// groupHeadTools are the head buttons of the group card id in the order of docs/spec/groups.md#headers: the two splits, the two group
// splits, the leader button, fullscreen and close; a group header holds no add button.
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
		changes(headTool{Do: "x", Status: "split-x", Name: "core.group.split-x", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-x"},
			Title: names["split-x"], Icon: "card-split-x"}, s.planes.CanSplit(id, "right")),
		changes(headTool{Do: "y", Status: "split-y", Name: "core.group.split-y", Command: "core.card.menu", Params: menuParam{Card: id, Menu: "split-y"},
			Title: names["split-y"], Icon: "card-split-y"}, s.planes.CanSplit(id, "bottom")),
	}
	tools = append(tools, s.groupTools(id, "core.group", changes)...)
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

// drawGroupCard draws the group card id whose rectangle is rect as one container (docs/spec/groups.md#drawing): its body filled with the
// color of the level of its members, its header, the band of head-h at the top of the rectangle (docs/spec/groups.md#drawn-rectangles),
// and its frame, the border and the radius of a card on the rectangle, drawn over the header so the line runs around the whole card and
// the header keeps the rounded corners. The cards inside it draw over the rest of the rectangle, one gap inside the frame.
func (s *Shell) drawGroupCard(c *ui.Context, id string, rect layout.Rect, inset float32) {
	record, _ := s.planes.Group(id) // silent: drawWork draws a group card of the tree.
	head, _ := s.groupHeadRect(id)  // silent: a group card has a header.
	// The frame lets the pointer through to the plane, whose press clears the focus (docs/spec/groups.md#focus).
	card := s.binder.Press(c, "core.group", "core.card.focus", id, focusParam{})
	s.anchored("core.group/"+id, card)
	card.FocusRing(false).Role(ui.RoleGroup).Label(record.Name).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).
		Size(float32(rect.W), float32(rect.H)).Background(s.palette.GroupLook(s.planes.Level(id)+1, s.metrics.groupFillFade).Body).
		Radius(s.palette.CardRadius()).PassThrough()
	radius := s.palette.CardRadius()
	ui.Box(c).Absolute().Left(float32(head.X)+inset).Top(float32(head.Y)+inset).Size(float32(head.W), float32(head.H)).Radius(radius, radius, 0, 0).Clip().
		Children(func() { s.drawGroupHead(c, id, record.Name, float32(head.W), float32(head.H)) })
	ui.Box(c).Absolute().Left(float32(rect.X)+inset).Top(float32(rect.Y)+inset).Size(float32(rect.W), float32(rect.H)).
		Border(s.palette.CardBorder(), s.frameColor(id)).Radius(radius).PassThrough()
	// At the seam the frame has no border, and its line is the line of the plane around it; the mark of the focus colors that line, as
	// the focus ring of a content card does. A nested group card and the focused card draw later, so the innermost mark owns a line that
	// several marked boxes end on (docs/spec/groups.md#drawing).
	if s.palette.Seam() && s.frameColor(id) != s.palette.Edge {
		line := s.palette.BorderWidth
		ui.Box(c).Absolute().Left(float32(rect.X)+inset-line).Top(float32(rect.Y)+inset-line).Size(float32(rect.W)+2*line, float32(rect.H)+2*line).
			Border(line, s.frameColor(id)).PassThrough()
	}
}

// groupFocus is the number of levels from the focused content card up to the group card id that holds it, 1 for the group card that
// holds it directly, or nil when the focused card stands outside id (docs/spec/groups.md#focus).
func (s *Shell) groupFocus(id string) *int {
	path := s.planes.Groups(s.focused)
	for i, group := range path {
		if group == id {
			d := len(path) - i
			return &d
		}
	}
	return nil
}

// frameColor is the color of the frame line of the group card id: the focus color mixed into edge by group-focus-fade to the power of
// the levels up to the focused card while id holds it and focusInd is border, and edge otherwise (docs/spec/groups.md#focus).
func (s *Shell) frameColor(id string) ui.Color {
	d := s.groupFocus(id)
	if d == nil || s.settings.Value("focusInd") == "corner" {
		return s.palette.Edge
	}
	return mixed(s.palette.Focus, s.palette.Edge, float32(math.Pow(float64(s.metrics.groupFocusFade), float64(*d))))
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

// planeRule is a stretch of a rule of the grid to draw, and whether it may reach into the stage padding at the edge of the plane: only a
// stretch outside every group card does.
type planeRule struct {
	layout.Rule
	Bleed bool
}

// planeRules are the rules of the grid as drawn (docs/spec/groups.md#drawing): none while a card is fullscreen, each cut where it would
// cross a header, and a stretch inside a group card cut to the inside of its frame below its header; a stretch outside every group card
// is cut where it would cross a frame.
func (s *Shell) planeRules() []planeRule {
	out := []planeRule{}
	if s.fullscreen != "" {
		return out
	}
	heads := s.headRects()
	frames := []layout.Rect{}
	inner := []layout.Rect{}
	for _, id := range s.planes.Cards() {
		if !s.planes.IsGroup(id) {
			continue
		}
		frame, _ := s.planes.Rect(id) // silent: id is a group card of the tree.
		head, _ := s.planes.HeadRect(id)
		frames = append(frames, frame)
		inner = append(inner, layout.Rect{X: frame.X, Y: head.Y + head.H, W: frame.W, H: frame.Y + frame.H - head.Y - head.H})
	}
	for _, rule := range s.plane.Rules() {
		a0, a1, from, to := rule.X, rule.X+rule.W, rule.Y, rule.Y+rule.H
		if rule.Axis == "y" {
			a0, a1, from, to = rule.Y, rule.Y+rule.H, rule.X, rule.X+rule.W
		}
		k := 0
		for _, part := range clearOfHeads(rule.Axis, a0, a1, from, to, heads) {
			for _, cut := range clearOfFrames(rule.Axis, a0, a1, part, frames, inner) {
				piece := planeRule{Rule: rule, Bleed: cut.outside}
				if k > 0 {
					piece.Key = rule.Key + ":" + strconv.Itoa(k)
				}
				k++
				if rule.Axis == "y" {
					piece.X, piece.W = cut.from, cut.to-cut.from
				} else {
					piece.Y, piece.H = cut.from, cut.to-cut.from
				}
				out = append(out, piece)
			}
		}
	}
	return out
}

// ruleCut is a stretch [from, to] of a rule, and whether it lies outside every group card.
type ruleCut struct {
	from, to float64
	outside  bool
}

// clearOfFrames cuts the stretch part of a line of axis, which spans [a0, a1] across it, by the group cards: inside the innermost frame
// that holds the middle of the stretch and the line, the stretch keeps only the inside of that frame below its header, inner; outside
// every frame, it loses every stretch where it would cross a frame.
func clearOfFrames(axis layout.Axis, a0, a1 float64, part [2]float64, frames, inner []layout.Rect) []ruleCut {
	span := func(r layout.Rect) (float64, float64, float64, float64) {
		if axis == "y" {
			return r.Y, r.Y + r.H, r.X, r.X + r.W
		}
		return r.X, r.X + r.W, r.Y, r.Y + r.H
	}
	middle := (part[0] + part[1]) / 2
	holder := -1
	for k, frame := range frames {
		c0, c1, s0, s1 := span(frame)
		if a0 >= c0 && a1 <= c1 && middle > s0 && middle < s1 && (holder < 0 || frames[holder].W*frames[holder].H > frame.W*frame.H) {
			holder = k
		}
	}
	if holder >= 0 {
		_, _, s0, s1 := span(inner[holder])
		if from, to := max(part[0], s0), min(part[1], s1); to > from {
			return []ruleCut{{from: from, to: to}}
		}
		return nil
	}
	parts := [][2]float64{part}
	for _, frame := range frames {
		c0, c1, s0, s1 := span(frame)
		if min(a1, c1)-max(a0, c0) <= headTolerance {
			continue
		}
		next := [][2]float64{}
		for _, p := range parts {
			if p[1] <= s0 || p[0] >= s1 {
				next = append(next, p)
				continue
			}
			if p[0] < s0 {
				next = append(next, [2]float64{p[0], s0})
			}
			if p[1] > s1 {
				next = append(next, [2]float64{s1, p[1]})
			}
		}
		parts = next
	}
	out := make([]ruleCut, 0, len(parts))
	for _, p := range parts {
		out = append(out, ruleCut{from: p[0], to: p[1], outside: true})
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
	// The icon of the activity of the group card stands before its name, so the name takes its width and the gap of the header with it
	// (docs/spec/activity.md#drawing).
	_, groupActivities, _, _ := s.shownActivities()
	activity := groupActivities[id]
	if activity != "" {
		nameWidth += m.activityIcon + m.cardHeadGap
	}
	buttons := float32(len(tools))
	group := buttons*m.cardButton + (buttons-1)*m.cardActsGap + 2*m.cardActsPad + 2*s.palette.BorderWidth + s.pairWidth(tools)
	kept := keptTools(tools)
	// The line of the frame runs over the ends of the header, so its content starts the head padding inside the line, as in a card head.
	pad := m.cardHeadPad + s.palette.CardBorder()
	fit := layout.FitHead(layout.Head{Width: float64(width), PaddingLeft: float64(pad), PaddingRight: float64(pad),
		Gap: float64(m.cardHeadGap), ToolsWidth: float64(group), MoreWidth: float64(m.cardButton), KeptWidth: float64(s.keptWidth(kept)),
		TabWidths: []float64{float64(nameWidth)}, TabGap: float64(m.cardTabsGap), Peek: float64(m.tabPeekW), MinTab: float64(m.tabMinW),
		Grab: float64(m.tabGrabW)})
	s.heads[id] = fit
	kept = shownKept(fit, kept)
	target := renameTarget{Kind: "group", ID: id}
	look := s.palette.GroupLook(s.planes.Level(id)+1, s.metrics.groupFillFade)
	header := ui.Row(s.binder.Name(c, "core.group.header", id))
	header.Size(width, height).PaddingX(pad).AlignItems(ui.Center).Gap(m.cardHeadGap).Clip().
		Role(ui.RoleGroup).Label("core.group.header").BorderWidth(0, 0, s.palette.BorderWidth, 0).BorderColor(look.Line).Background(look.Head).Children(func() {
		ui.Box(c).Absolute().Size(0, 0).Children(func() {
			if fit.Tools == "bar" {
				s.binder.Absent(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id})
				return
			}
			for _, tool := range tools {
				if keeps(kept, tool.Do) {
					continue
				}
				s.binder.Absent(c, tool.Name, tool.Command, id, tool.Params).Disabled(!tool.Enabled)
			}
		})
		if s.renaming != nil && s.renaming.renameTarget == target {
			// The field takes the place of the name: its text starts where the text of the name started, so it starts its outline and its
			// padding less the padding of the name before the name, grows to the end of the name, and keeps the size of the name
			// (docs/spec/groups.md#headers).
			s.drawRenameField(c, 0, size).Grow(1).Shrink(1).MarginStart(m.tabPadX - s.palette.BorderWidth - s.frameLength(m.barTabRootPad))
		} else {
			if activity != "" {
				s.drawActivity(c, "core.activity.group", id, activity, m.activityIcon)
			}
			// A press on the name, which fills the header outside its buttons, lands on no content card and clears the focus
			// (docs/spec/groups.md#focus).
			label := s.binder.Press(c, "core.group.name", "core.card.focus", id, focusParam{})
			// The name stands at the start of the place of the tab strip, where the first tab of a content card stands; a button centres its
			// content otherwise (docs/spec/groups.md#headers).
			label.KeepFocus().Grow(1).Shrink(1).Row().Justify(ui.Start).AlignItems(ui.Center).PaddingX(m.tabPadX).Label(name).Tooltip(name)
			s.renameOnDoubleClick(label, target)
			// The name grows over the room that the buttons leave, so a press on the header outside its buttons drags the group card. The
			// buttons take their own presses, so only the name starts the drag, and its release ends it.
			label.HandleInput(s.groupHeadInput(id))
			label.Children(func() {
				ui.Text(c, name).SingleLine().Ellipsis("…").LineHeight(m.lineHeight).FontSize(size).TextColor(s.palette.Fg)
			})
		}
		if fit.Tools != "bar" {
			s.drawKeptTools(c, id, kept)
			s.headButton(c, "core.card.tools", "core.card.tools", id, cardParam{Card: id}, "카드 도구", s.headIcon("card-more", true), true, false)
			return
		}
		ui.Row(c).Gap(m.cardActsGap).Padding(m.cardActsPad).Radius(s.radiusSmall()).Border(s.palette.BorderWidth, s.palette.Edge).Shrink(0).Children(func() {
			s.drawToolRow(c, id, tools)
		})
	})
}

// openGroupMenu opens the close menu of the group card id under its close button, and closes it when it is open: the close
// item runs core.card.close on the group with its cards, and the dissolve item, shown while the dissolve would succeed, runs
// core.group.dissolve (docs/spec/groups.md#headers).
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
		items = append(items, pickerItem{Key: "dissolve", Name: names["group-dissolve"], Icon: s.headIconElements("card-split-x")})
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
