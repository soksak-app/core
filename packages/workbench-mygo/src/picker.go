package workbench

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The picker layer: the add, split, tool, tab and context menus of the workbench, as plane.js opens them and picker-layer.js fills
// them. It is native UI, drawn over the window (docs/spec/hosts.md#native-views).

// pickerAsk are the questions of the add menu by its tool.
var pickerAsk = map[string]string{"add": "새 탭에 무엇을 띄울까", "x": "새 위치에 무엇을 띄울까", "y": "새 위치에 무엇을 띄울까"}

// The view box of the map of a group heading (fillPicker of packages/workbench/picker-layer.js).
const pickerMapWidth, pickerMapHeight = 16, 10

// menuTools are the menus of the card head, with the tool of each and the side that its split takes.
var menuTools = map[string]struct{ tool, side string }{"add": {tool: "add"}, "split-x": {"x", "right"}, "split-y": {"y", "bottom"}}

// pickerItem is an item of the layer. Expose is the element name of an item that has its own, and Icon the SVG elements of a
// 16-unit view box.
type pickerItem struct {
	Key, Name, Mark, Icon, Expose string
	Active                        bool
	// Group is the id of the group heading of the item in a grouped layer, and Notice the tab whose notice the item shows.
	Group, Notice string
}

// pickerGroup is a heading of a grouped layer: its name, its tree depth, and its map of the plane.
type pickerGroup struct {
	ID, Name string
	Depth    int
	Map      *ui.SVG
}

// picker is the open layer. An anchored layer stands below the element of anchor, on its start with start and on its end
// otherwise, and a layer without an anchor stands at x and y of the window.
type picker struct {
	open    bool
	title   string
	items   []pickerItem
	groups  []pickerGroup
	anchor  string
	start   bool
	x, y    float32
	pick    func(key string) error
	dismiss func()
	// drawn holds the anchors of the current frame.
	drawn map[string]ui.Element
}

// pickerMetrics are the chrome metrics of the layer.
type pickerMetrics struct {
	minW, maxW, maxH, outerPad, pad, icon, iconH, gap, itemPadY, headTop, headX, headBottom, noteGap, shadowY, shadowBlur, shadowAlpha float32
	indent, groupedMaxW, groupedMaxH, groupedMargin, groupedIcon, groupTop, groupBottom, groupStroke                                   float32
}

func (s *Shell) readPickerMetrics() pickerMetrics {
	metric := func(name string) float32 {
		value, _ := s.options.Declared.Metric("picker-" + name)
		return float32(value)
	}
	return pickerMetrics{minW: metric("min-w"), maxW: metric("max-w"), maxH: metric("max-h"), outerPad: metric("outer-pad"), pad: metric("pad"),
		icon: metric("icon"), iconH: metric("icon-h"), gap: metric("gap"), itemPadY: metric("item-pad-y"), headTop: metric("head-pad-top"),
		headX: metric("head-pad-x"), headBottom: metric("head-pad-bottom"), noteGap: metric("item-note-gap"), shadowY: metric("shadow-y"),
		shadowBlur: metric("shadow-blur"), shadowAlpha: metric("shadow-alpha"), indent: metric("indent"), groupedMaxW: metric("grouped-max-w"),
		groupedMaxH: metric("grouped-max-h"), groupedMargin: metric("grouped-margin"), groupedIcon: metric("grouped-icon"),
		groupTop: metric("group-pad-top"), groupBottom: metric("group-pad-bottom"), groupStroke: metric("group-stroke")}
}

// anchored records element as the anchor key of this frame.
func (s *Shell) anchored(key string, element ui.Element) {
	s.picker.drawn[key] = element
}

// toggled closes the layer of anchor when it is open.
func (s *Shell) toggled(anchor string) bool {
	if !s.picker.open || s.picker.anchor != anchor {
		return false
	}
	s.closePicker()
	return true
}

// openPicker replaces the layer with a new one and returns it for what the placement adds.
func (s *Shell) openPicker(title string, items []pickerItem, pick func(key string) error) *picker {
	s.closePicker()
	s.picker = picker{open: true, title: title, items: items, pick: pick, drawn: s.picker.drawn}
	s.options.Invalidate()
	return &s.picker
}

// closePicker closes the layer. A question that waits for its answer learns that the layer closed without a pick.
func (s *Shell) closePicker() {
	if !s.picker.open {
		return
	}
	dismiss := s.picker.dismiss
	s.picker = picker{drawn: s.picker.drawn}
	s.options.Invalidate()
	if dismiss != nil {
		dismiss()
	}
}

// pickItem chooses one item of the open layer.
func (s *Shell) pickItem(index int) error {
	if !s.picker.open {
		return errors.New("no menu is open")
	}
	if index < 0 || index >= len(s.picker.items) {
		return fmt.Errorf("the menu has no item %d", index)
	}
	key, pick := s.picker.items[index].Key, s.picker.pick
	s.picker.dismiss = nil
	s.closePicker()
	return pick(key)
}

// openAddMenu asks which plugin a new tab of the card takes, for the tool add or a split tool, under the anchor.
func (s *Shell) openAddMenu(anchor, tool, card string) {
	items := []pickerItem{}
	for _, plugin := range s.plugins {
		if plugin.Surface {
			items = append(items, pickerItem{Key: plugin.ID, Name: plugin.Name, Mark: plugin.Mark, Icon: plugin.Icon})
		}
	}
	s.openPicker(pickerAsk[tool], items, func(plugin string) error {
		if tool == "add" {
			_, err := s.addTab(card, plugin, nil)
			return err
		}
		side := "right"
		if tool == "y" {
			side = "bottom"
		}
		_, err := s.splitCard(card, side, plugin)
		return err
	}).anchor = anchor
}

// openCardMenu opens the add or split menu of a card, and closes it when it is open.
func (s *Shell) openCardMenu(card, menu string) error {
	if err := s.paneCard(card); err != nil {
		return err
	}
	if err := s.layoutChangeable(card); err != nil {
		return err
	}
	tool, known := menuTools[menu]
	if !known {
		return fmt.Errorf("unknown menu %s", menu)
	}
	anchor := "core.card." + menu + "/" + card
	if _, drawn := s.picker.drawn[anchor]; !drawn {
		return fmt.Errorf("card %s has no %s button", card, menu)
	}
	if s.toggled(anchor) {
		return nil
	}
	s.focused = card
	s.settle()
	s.openAddMenu(anchor, tool.tool, card)
	return nil
}

// openCardTools opens the tool menu of a card, which holds the tools that its narrow head folds, and closes it when it is open.
func (s *Shell) openCardTools(card string) error {
	if err := s.paneCard(card); err != nil {
		return err
	}
	anchor := "core.card.tools/" + card
	if _, drawn := s.picker.drawn[anchor]; !drawn {
		return fmt.Errorf("card %s has no tool menu button", card)
	}
	if s.toggled(anchor) {
		return nil
	}
	items, err := s.sideItems(card)
	if err != nil {
		return err
	}
	for _, tool := range s.headTools(card) {
		if tool.Enabled {
			name, _, _ := strings.Cut(tool.Title, " — ")
			items = append(items, pickerItem{Key: tool.Do, Name: name, Icon: s.headIconElements(tool.Icon), Active: tool.Pressed})
		}
	}
	s.focused = card
	s.settle()
	s.openPicker("카드 도구", items, func(key string) error {
		if key == "close" {
			_, err := s.askedCloseCard(card)
			return err
		}
		if key == "fullscreen" {
			s.binder.run("core.card.fullscreen", cardParam{Card: card})
			return nil
		}
		if side, ok := strings.CutPrefix(key, "side-"); ok {
			s.binder.run("core.card.sidebar.toggle", cardSideParam{Card: card, Side: side})
			return nil
		}
		s.openAddMenu(anchor, key, card)
		return nil
	}).anchor = anchor
	return nil
}

// openTabList opens the list of the tabs of a card, which its head folds, and closes it when it is open.
func (s *Shell) openTabList(card string) error {
	if err := s.paneCard(card); err != nil {
		return err
	}
	anchor := "core.card.tab-list/" + card
	if _, drawn := s.picker.drawn[anchor]; !drawn {
		return fmt.Errorf("card %s has no tab list button", card)
	}
	if s.toggled(anchor) {
		return nil
	}
	data, err := s.cardData(card)
	if err != nil {
		return err
	}
	tabs := data.TabList()
	active := data.ActiveTab()
	items := make([]pickerItem, 0, len(tabs))
	for _, tab := range tabs {
		item := pickerItem{Key: tab.ID, Name: layout.TabName(tab, nil, false), Mark: "?", Notice: tab.ID, Active: active != nil && tab.ID == active.ID}
		if plugin := s.loadedPlugin(tab.Plugin); plugin != nil {
			item.Mark, item.Icon = plugin.Mark, plugin.Icon
		}
		items = append(items, item)
	}
	layer := s.openPicker(fmt.Sprintf("탭 %d개", len(tabs)), items, func(tab string) error {
		s.focused = card
		return s.selectTab(tab)
	})
	layer.anchor, layer.start = anchor, true
	return nil
}

// openSpaceApps opens the list of the tabs of the space under the button of a fullscreen card, and closes it when it is open. The groups are
// the cards in the order of reading the slicing tree, and a pick moves the full screen to the card of the tab and shows the tab.
func (s *Shell) openSpaceApps(id string) error {
	if err := s.paneCard(id); err != nil {
		return err
	}
	if s.fullscreen != id {
		return fmt.Errorf("card %s is not fullscreen", id)
	}
	anchor := "core.card.space-apps/" + id
	if s.toggled(anchor) {
		return nil
	}
	holdsTabs := func(card layout.Card) bool { return len(card.Data) > 0 && string(card.Data) != "null" }
	order, ok := s.plane.Sliced(holdsTabs)
	if !ok {
		return errors.New("the cards of the space are not a slicing arrangement")
	}
	metrics := s.readPickerMetrics()
	groups := make([]pickerGroup, 0, len(order))
	items := []pickerItem{}
	for index, card := range order {
		data, err := s.cardData(card.ID)
		if err != nil {
			return err
		}
		groups = append(groups, pickerGroup{ID: card.ID, Name: fmt.Sprintf("카드 %d", index+1), Depth: max(0, card.Cuts-1), Map: s.planeMap(order, card.ID, metrics)})
		active := data.ActiveTab()
		for _, tab := range data.TabList() {
			item := pickerItem{Key: card.ID + "/" + tab.ID, Name: s.tabName(tab), Mark: "?", Group: card.ID, Notice: tab.ID,
				Active: card.ID == id && active != nil && tab.ID == active.ID}
			if plugin := s.loadedPlugin(tab.Plugin); plugin != nil {
				item.Mark, item.Icon = plugin.Mark, plugin.Icon
			}
			items = append(items, item)
		}
	}
	layer := s.openPicker(fmt.Sprintf("스페이스 앱 %d개", len(items)), items, func(key string) error {
		card, tab, _ := strings.Cut(key, "/")
		return s.showFullscreen(card, tab)
	})
	layer.groups, layer.anchor, layer.start = groups, anchor, true
	return nil
}

// planeMap is the icon of a group heading: the cards of the plane, with the card own filled.
func (s *Shell) planeMap(cards []layout.SlicedCard, own string, metrics pickerMetrics) *ui.SVG {
	var elements strings.Builder
	sx, sy := pickerMapWidth/s.plane.Width(), pickerMapHeight/s.plane.Height()
	for _, card := range cards {
		rect, _ := s.plane.Rect(card.ID)
		fill := "none"
		if card.ID == own {
			fill = "currentColor"
		}
		fmt.Fprintf(&elements, `<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" rx=".6" fill="%s"/>`, rect.X*sx, rect.Y*sy, rect.W*sx, rect.H*sy, fill)
	}
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, metrics.groupStroke)
	return s.declaredIcon(fmt.Sprintf("0 0 %d %d", pickerMapWidth, pickerMapHeight), paint, elements.String())
}

// showFullscreen moves the full screen to a card and shows its tab.
func (s *Shell) showFullscreen(card, tab string) error {
	data, err := s.cardData(card)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(data.TabList(), func(held layout.Tab) bool { return held.ID == tab }) {
		return fmt.Errorf("no tab %s in card %s", tab, card)
	}
	data.SelectTab(tab)
	if err := s.storeCard(card, data); err != nil {
		return err
	}
	s.focused, s.fullscreen = card, card
	s.settle()
	return nil
}

// openSurfaceMenu opens at x and y the context menu that the plugin of a surface declares. A chosen item runs its command.
func (s *Shell) openSurfaceMenu(surface string, x, y float64) error {
	tab, err := s.tabOf(surface)
	if err != nil {
		return err
	}
	owner := s.loadedPlugin(tab.Plugin)
	if owner == nil || len(owner.Menu) == 0 {
		return fmt.Errorf("the plugin %s of surface %s declares no menu", tab.Plugin, surface)
	}
	items := make([]pickerItem, 0, len(owner.Menu))
	for _, item := range owner.Menu {
		items = append(items, pickerItem{Key: item.Command, Name: item.Title})
	}
	layer := s.openPicker(owner.Name, items, func(command string) error {
		s.registry.RunOn(command, nil, surface, func(_ any, err error) {
			if err != nil {
				s.fail(err)
			}
		})
		return nil
	})
	layer.x, layer.y = float32(x), float32(y)
	return nil
}

// tabContextMenu opens the context menu of a tab on a right click of its button, when the menu has items. Without items the press
// does nothing, as a press outside a menu does.
func (s *Shell) tabContextMenu(button ui.Element, tab string) {
	if !button.RightClicked() || s.tabs == nil || !s.tabs.saver.Known(tab) {
		return
	}
	reasons, err := s.tabs.saver.Reasons(tab)
	if err != nil {
		s.fail(err)
		return
	}
	if len(tabMenuItems(reasons)) == 0 {
		return
	}
	x, y, _ := button.PointerPosition() // The right click reports the pointer, which stands in the button.
	bounds := button.Bounds()
	s.binder.run("core.tab.menu", pointParam{Tab: tab, X: float64(bounds.X + x), Y: float64(bounds.Y + y)})
}

// tabOf returns the tab id of the shown plane.
func (s *Shell) tabOf(id string) (layout.Tab, error) {
	card := s.cardOfTab(id)
	if card == "" {
		return layout.Tab{}, fmt.Errorf("unknown tab %s", id)
	}
	data, err := s.cardData(card)
	if err != nil {
		return layout.Tab{}, err
	}
	for _, tab := range data.TabList() {
		if tab.ID == id {
			return tab, nil
		}
	}
	return layout.Tab{}, fmt.Errorf("unknown tab %s", id)
}

// tabMenuItems are the items of the context menu of a tab from the reasons of the memory saver, as tab-menu.js builds them: a tab
// that can never be unloaded has no keep item.
func tabMenuItems(reasons []string) []pickerItem {
	if slices.Contains(reasons, "undeclared") || slices.Contains(reasons, "background") {
		return nil
	}
	return []pickerItem{{Key: "keep", Name: "메모리에 유지", Expose: "core.tab.menu-keep", Active: slices.Contains(reasons, "kept")}}
}

// openTabMenu opens at x and y the context menu of a tab.
func (s *Shell) openTabMenu(id string, x, y float64) error {
	if s.tabs == nil {
		return fmt.Errorf("unknown tab %s", id)
	}
	if err := s.tabs.saver.Tab(id); err != nil {
		return err
	}
	reasons, err := s.tabs.saver.Reasons(id)
	if err != nil {
		return err
	}
	items := tabMenuItems(reasons)
	if len(items) == 0 {
		return fmt.Errorf("tab %s has no menu items", id)
	}
	tab, err := s.tabOf(id)
	if err != nil {
		return err
	}
	kept := items[0].Active
	layer := s.openPicker(layout.TabName(tab, nil, false), items, func(string) error {
		return s.tabs.saver.Keep(id, !kept)
	})
	layer.x, layer.y = float32(x), float32(y)
	return nil
}

// pickerStatusItem is an item of the status core.picker. An item of a menu without groups has a null group.
type pickerStatusItem struct {
	Key    string  `json:"key"`
	Name   string  `json:"name"`
	Active bool    `json:"active"`
	Group  *string `json:"group"`
}

// pickerColumn is the x of the icon and of the name of a row, relative to the left edge of the layer.
type pickerColumn struct {
	Icon float32 `json:"icon"`
	Name float32 `json:"name"`
}

// pickerColumns are the columns of the rows of the layer.
type pickerColumns struct {
	Groups []pickerColumn `json:"groups"`
	Items  []pickerColumn `json:"items"`
}

// pickerGroupStatus is a group heading of the status core.picker.
type pickerGroupStatus struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Depth int    `json:"depth"`
}

// pickerStatus is the status core.picker.
type pickerStatus struct {
	Open    bool                `json:"open"`
	Title   string              `json:"title"`
	Items   []pickerStatusItem  `json:"items"`
	Groups  []pickerGroupStatus `json:"groups"`
	Columns pickerColumns       `json:"columns"`
}

func (s *Shell) pickerStatus() pickerStatus {
	status := pickerStatus{Open: s.picker.open, Title: s.picker.title, Items: []pickerStatusItem{}, Groups: []pickerGroupStatus{},
		Columns: pickerColumns{Groups: []pickerColumn{}, Items: []pickerColumn{}}}
	metrics := s.readPickerMetrics()
	icon := s.palette.BorderWidth + metrics.outerPad + metrics.pad
	cell := s.pickerCell(metrics)
	column := func(depth int) pickerColumn {
		start := icon + float32(depth)*metrics.indent
		return pickerColumn{Icon: start, Name: start + cell + metrics.gap}
	}
	for _, group := range s.picker.groups {
		status.Groups = append(status.Groups, pickerGroupStatus{ID: group.ID, Name: group.Name, Depth: group.Depth})
		status.Columns.Groups = append(status.Columns.Groups, column(group.Depth))
	}
	for _, item := range s.picker.items {
		shown := pickerStatusItem{Key: item.Key, Name: item.Name, Active: item.Active}
		if item.Group != "" {
			group := item.Group
			shown.Group = &group
		}
		status.Items = append(status.Items, shown)
		status.Columns.Items = append(status.Columns.Items, column(s.pickerDepth(item)))
	}
	return status
}

// screenStatus is the status core.screen.
type screenStatus struct {
	Screen string  `json:"screen"`
	Modal  *string `json:"modal"`
}

// modalName is the open modal of the window, or nil.
func (s *Shell) modalName() *string {
	name := ""
	switch {
	case s.settingsWindow.open:
		name = "settings"
	case s.debugView.open:
		name = "debug"
	case s.picker.open:
		name = "picker"
	default:
		return nil
	}
	return &name
}

type menuParam struct {
	Card string `json:"card"`
	Menu string `json:"menu"`
}

type pointParam struct {
	Surface string  `json:"surface"`
	Tab     string  `json:"tab"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
}

// registerPicker adds the commands and the statuses of the layer.
func (s *Shell) registerPicker() {
	s.picker.drawn = map[string]ui.Element{}
	act(s, "core.card.menu", func(value menuParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openCardMenu(value.Card, value.Menu)
	})
	act(s, "core.card.tools", func(value cardParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openCardTools(value.Card)
	})
	act(s, "core.space.apps", func(value cardParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openSpaceApps(value.Card)
	})
	act(s, "core.card.tab-list", func(value cardParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openTabList(value.Card)
	})
	act(s, "core.surface.menu", func(value pointParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openSurfaceMenu(value.Surface, value.X, value.Y)
	})
	act(s, "core.tab.menu", func(value pointParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.openTabMenu(value.Tab, value.X, value.Y)
	})
	act(s, "core.picker.pick", func(value struct {
		Index int `json:"index"`
	}) error {
		return s.pickItem(value.Index)
	})
	act(s, "core.picker.close", func(struct{}) error { s.closePicker(); return nil })
	act(s, "core.modal.dismiss", func(struct{}) error { s.closePicker(); return nil })
	s.registry.Status("core.picker", func() any { return s.pickerStatus() })
	s.registry.Status("core.modal", func() any { return nil })
	s.registry.Status("core.screen", func() any {
		screen := "workspace"
		if s.browsing || s.opened() == nil {
			screen = "library"
		}
		return screenStatus{Screen: screen, Modal: s.modalName()}
	})
}

// pickerIcon returns the icon of the SVG elements of an item, or nil for an item without one. An icon that does not parse shows
// its error, since the manifest reader of the plugin holds the form of these elements.
func (s *Shell) pickerIcon(elements string) *ui.SVG {
	if elements == "" {
		return nil
	}
	if icon, ok := s.icons[elements]; ok {
		return icon
	}
	icon, err := ui.ParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">` + elements + `</svg>`))
	if err != nil {
		s.fail(fmt.Errorf("icon %s: %w", elements, err))
	}
	s.icons[elements] = icon
	return icon
}

// drawPicker draws the open layer over a window of width and height. A press outside it and Escape close it.
func (s *Shell) drawPicker(c *ui.Context, width, height float32) {
	layer := &s.picker
	if !layer.open {
		return
	}
	metrics := s.readPickerMetrics()
	anchor, attached := layer.drawn[layer.anchor]
	open := true
	ui.PopoverBase(c, anchor, &open, func(panel ui.Element) {
		switch {
		case attached && layer.start:
			panel.AttachTo(anchor, ui.AnchorBottomStart, ui.AnchorTopStart)
		case attached:
			panel.AttachTo(anchor, ui.AnchorBottomEnd, ui.AnchorTopEnd)
		default:
			panel.Absolute().Left(min(layer.x, max(0, width-metrics.maxW))).Top(min(layer.y, max(0, height-metrics.maxH)))
		}
		maxW, maxH := metrics.maxW, metrics.maxH
		if len(layer.groups) > 0 {
			maxW, maxH = metrics.groupedMaxW, min(metrics.groupedMaxH, height-metrics.groupedMargin)
		}
		panel.Margin(5, 0, 0, 0).MinWidth(metrics.minW).MaxWidth(maxW).MaxHeight(maxH).Column().Padding(metrics.outerPad).
			Background(s.palette.Card).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.palette.Radius).Label(layer.title).
			Shadow(0, metrics.shadowY, metrics.shadowBlur, 0, ui.RGBA(0, 0, 0, metrics.shadowAlpha)).Children(func() {
			ui.Box(c).Padding(metrics.headTop, metrics.headX, metrics.headBottom, metrics.headX).Children(func() {
				ui.Text(c, layer.title).FontSize(s.textCaption()).TextColor(s.palette.Muted)
			})
			ui.Scroll(c).Grow(1).Column().Children(func() {
				heading := ""
				for index, item := range layer.items {
					if item.Group != heading {
						heading = item.Group
						s.drawPickerGroup(c, heading, metrics)
					}
					s.drawPickerItem(c, index, item, metrics)
				}
			})
		})
	})
	if !open {
		s.closePicker()
	}
}

// pickerGroupOf returns the heading of a grouped layer.
func (s *Shell) pickerGroupOf(id string) pickerGroup {
	for _, group := range s.picker.groups {
		if group.ID == id {
			return group
		}
	}
	return pickerGroup{}
}

// pickerDepth is the indentation level of an item, the depth of its heading.
func (s *Shell) pickerDepth(item pickerItem) int { return s.pickerGroupOf(item.Group).Depth }

// pickerCell is the width of the icon cell of the rows of the layer, which is wider in a grouped layer.
func (s *Shell) pickerCell(metrics pickerMetrics) float32 {
	if len(s.picker.groups) > 0 {
		return metrics.groupedIcon
	}
	return metrics.icon
}

// drawPickerGroup draws the heading of a group: the map of the plane and the name. It does not receive presses.
func (s *Shell) drawPickerGroup(c *ui.Context, id string, metrics pickerMetrics) {
	group := s.pickerGroupOf(id)
	ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(metrics.gap).
		Padding(metrics.groupTop, metrics.pad, metrics.groupBottom, metrics.pad+float32(group.Depth)*metrics.indent).Children(func() {
		slot := ui.Box(s.binder.Name(c, "core.picker.group-icon", id)).Size(metrics.groupedIcon, metrics.iconH).Role(ui.RoleGroup).Label(group.Name).Center().AlignItems(ui.Center)
		slot.Children(func() {
			ui.Icon(c, group.Map).Size(metrics.groupedIcon, metrics.groupedIcon*pickerMapHeight/pickerMapWidth).TextColor(s.palette.Muted)
		})
		ui.Text(s.binder.Name(c, "core.picker.group-name", id), group.Name).FontSize(s.textCaption()).SingleLine().Ellipsis("…").TextColor(s.palette.Muted)
	})
}

// drawPickerItem draws an item of the layer.
func (s *Shell) drawPickerItem(c *ui.Context, index int, item pickerItem, metrics pickerMetrics) {
	name := item.Expose
	if name == "" {
		name = "core.picker.item"
	}
	ui.Box(c).FillWidth().Children(func() {
		row := ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(metrics.gap).
			Padding(metrics.itemPadY, metrics.pad, metrics.itemPadY, metrics.pad+float32(s.pickerDepth(item))*metrics.indent).Radius(s.radiusSmall())
		// The press lies over the row, since the element tree holds no element inside a button and the icon and the name are elements.
		button := s.binder.Press(c, name, "core.picker.pick", item.Key, map[string]int{"index": index})
		button.Absolute().Left(0).Top(0).Right(0).Bottom(0).Label(item.Name)
		switch {
		case button.Hovered():
			row.Background(faded(s.palette.Fg, s.metrics.chipHoverMix))
		case item.Active:
			row.Background(faded(s.palette.Fg, s.metrics.chipSelMix))
		}
		if text := s.tabNoticeText(item.Notice); text != "" {
			button.Tooltip(text)
		}
		row.Children(func() {
			if item.Notice != "" {
				s.noticeMark(c, item.Notice)
			}
			slot := ui.Box(s.binder.Name(c, "core.picker.item-icon", item.Key)).Size(s.pickerCell(metrics), metrics.iconH).Role(ui.RoleGroup).Label(item.Name).Center().AlignItems(ui.Center)
			slot.Children(func() {
				if icon := s.pickerIcon(item.Icon); icon != nil {
					ui.Icon(c, icon).Size(metrics.icon, metrics.iconH)
				}
			})
			ui.Text(s.binder.Name(c, "core.picker.item-name", item.Key), item.Name).FontSize(s.textControl()).SingleLine().Ellipsis("…").Grow(1)
			if item.Mark != "" {
				ui.Text(c, item.Mark).FontSize(s.textCaption()).TextColor(s.palette.Muted).MarginStart(metrics.noteGap)
			}
		})
	})
}
