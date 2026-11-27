package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The texts of the notice center are those of packages/workbench/notice-view.js (docs/spec/notifications.md#notice-center).
var noticeGroupLabel = map[string]string{"progress": "진행 중", "today": "오늘", "yesterday": "어제"}

var noticeFilterLabel = map[string]string{"all": "전체", "problems": "오류·경고", "progress": "진행 중"}

const noticeFootText = "오류는 지울 때까지, 나머지는 7일 동안 남는다."

// centerEntries returns the entries in center order, newest first, after the expired ones are dropped.
func (e *ShownErrors) centerEntries() []*errorToast {
	e.ExpireNotices()
	list := make([]*errorToast, 0, len(e.toasts))
	for i := len(e.toasts) - 1; i >= 0; i-- {
		list = append(list, e.toasts[i])
	}
	return list
}

// noticeMatches reports whether an entry is shown under filter: all, problems (warning and error) or progress.
func noticeMatches(toast *errorToast, filter string) bool {
	switch filter {
	case "problems":
		return toast.kind == "warning" || toast.kind == "error"
	case "progress":
		return toast.kind == "progress"
	}
	return true
}

// drawNoticeCenter draws the notice center below the title bar when it is open: a popover under the bell, or a drawer on the right
// of the window, as the setting noticeCenterStyle chooses.
func (s *Shell) drawNoticeCenter(c *ui.Context, width, height float32) {
	if !s.errors.noticeOpen {
		return
	}
	m := s.metrics
	top := s.chromeHeight()
	body := max(0, height-top)
	entries := s.errors.centerEntries()
	counts := map[string]int{}
	var shown []*errorToast
	for _, toast := range entries {
		for _, filter := range noticeFilters {
			if noticeMatches(toast, filter) {
				counts[filter]++
			}
		}
		if noticeMatches(toast, s.errors.noticeFilter) {
			shown = append(shown, toast)
		}
	}
	panel := s.exposedBox(c, "core.notices.panel", "", "").Absolute().Top(top).Background(s.palette.Card).Radius(s.radiusMiddle())
	if s.noticeCenterStyle() == "drawer" {
		panel.Right(0).Size(m.noticeCenterW, body)
	} else {
		panel.Right(m.toastRight).Size(m.noticeCenterW, min(m.noticeCenterMaxH, body))
	}
	panel.Role(ui.RoleGroup).Label("알림").Children(func() {
		ui.Scroll(c).Fill().Column().Gap(m.toastGap).Padding(m.noticeEntryPad).Children(func() {
			s.drawNoticeHead(c)
			s.drawNoticeFilters(c, counts)
			s.drawNoticeGroups(c, shown)
			s.drawNoticeFoot(c)
		})
	})
}

// noticeCenterStyle is the setting noticeCenterStyle: popover or drawer.
func (s *Shell) noticeCenterStyle() string {
	if value, ok := s.settings.Value("noticeCenterStyle").(string); ok && value != "" {
		return value
	}
	return "popover"
}

// drawNoticeHead draws the title 알림, the read-all button, the settings button and the close control.
func (s *Shell) drawNoticeHead(c *ui.Context) {
	m := s.metrics
	ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(m.toastGap).Children(func() {
		ui.Text(c, "알림").SingleLine().TextColor(s.palette.Fg)
		ui.Box(c).Grow(1)
		s.uiButton(c, s.binder.Press(c, "core.notices.read-all", "core.notices.read-all", "", nil), "모두 읽음", false)
		s.uiButton(c, s.binder.Press(c, "core.notices.settings", "core.settings-tab.nav", "", map[string]any{"page": "behavior", "group": "notices"}), "⚙", false)
		close := s.binder.Press(c, "core.notices.toggle", "core.notices.toggle", "", nil)
		close.Size(m.noticeGlyph, m.noticeGlyph).Shrink(0).Center().Label("닫기").Tooltip("닫기").Cursor(ui.CursorPointer).Children(func() {
			ui.Icon(c, s.declaredIcon("0 0 24 24", fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, 2.0), s.options.Declared.Icons["close"])).
				Size(m.noticeGlyph, m.noticeGlyph).TextColor(s.palette.Muted)
		})
	})
}

// drawNoticeFilters draws the filter segment with the count of each filter; the selected filter is marked.
func (s *Shell) drawNoticeFilters(c *ui.Context, counts map[string]int) {
	m := s.metrics
	ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(m.toastGap).Children(func() {
		for _, filter := range noticeFilters {
			label := fmt.Sprintf("%s %d", noticeFilterLabel[filter], counts[filter])
			button := s.binder.Press(c, "core.notices.filter", "core.notices.filter", filter, map[string]any{"filter": filter})
			s.uiButton(c, button, label, filter == s.errors.noticeFilter)
		}
		// The switch 조용히 runs core.settings.set with the patch of quietToasts (docs/spec/notifications.md#notice-center).
		// silent: the settings store checks that quietToasts is a boolean, as a switch of the declaration.
		quiet, _ := s.settings.Value("quietToasts").(bool)
		s.uiButton(c, s.binder.Press(c, "core.notices.quiet", "core.settings.set", "", s.appliedPatch("quietToasts", !quiet)), "조용히", quiet)
	})
}

// drawNoticeGroups draws the groups in order: 진행 중 first, then each day of the entries, each with its 지우기 button except 진행 중.
func (s *Shell) drawNoticeGroups(c *ui.Context, shown []*errorToast) {
	m := s.metrics
	var order []string
	groups := map[string][]*errorToast{}
	for _, toast := range shown {
		group := s.errors.noticeGroup(toast)
		if _, seen := groups[group]; !seen && group != "progress" {
			order = append(order, group)
		}
		groups[group] = append(groups[group], toast)
	}
	if len(groups["progress"]) > 0 {
		order = append([]string{"progress"}, order...)
	}
	for _, group := range order {
		ui.Column(c).FillWidth().Gap(m.toastGap).Children(func() {
			ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(m.toastGap).Children(func() {
				ui.Text(c, groupLabel(group)).SingleLine().TextColor(s.palette.Muted)
				ui.Box(c).Grow(1)
				if group != "progress" {
					clear := s.binder.Press(c, "core.notices.clear", "core.notices.clear", group, map[string]any{"group": group})
					s.uiButton(c, clear, "지우기", false)
				}
			})
			for _, toast := range groups[group] {
				s.drawNoticeEntry(c, toast)
			}
		})
	}
}

// groupLabel is the label of a group: 진행 중, 오늘 or 어제, or the day itself.
func groupLabel(group string) string {
	if label, ok := noticeGroupLabel[group]; ok {
		return label
	}
	return group
}

// drawNoticeEntry draws one entry: its icon, title with count, text, progress, source chip, time, actions and the unread dot. A press
// reads the entry, and a press on a card entry also focuses its card.
func (s *Shell) drawNoticeEntry(c *ui.Context, toast *errorToast) {
	m := s.metrics
	steps := []PressStep{{Command: "core.notices.read", Params: map[string]any{"id": toast.id}}}
	if toast.source.Kind == "card" {
		steps = append(steps, PressStep{Command: "core.card.focus", Params: map[string]any{"card": toast.source.Card}})
	}
	entry := s.binder.PressAll(c, "core.notices.entry", toast.id, steps...)
	color := s.noticeKindColor(toast.kind)
	entry.FillWidth().Row().AlignItems(ui.Start).Gap(m.toastGap).Padding(m.noticeEntryPad, m.noticeEntryPad, m.noticeEntryPad, m.noticeEntryPad).Children(func() {
		ui.Icon(c, s.noticeGlyph(toast.kind)).Size(m.noticeGlyph, m.noticeGlyph).Shrink(0).TextColor(color)
		ui.Column(c).FillWidth().Gap(m.toastGap).Children(func() {
			ui.Text(c, displayTitle(toast)).Wrap().TextColor(s.palette.Fg).Label(displayTitle(toast))
			if toast.text != "" {
				ui.Text(c, toast.text).Wrap().TextColor(s.palette.Muted)
			}
			if toast.kind == "progress" {
				s.drawNoticeProgress(c, toast)
			}
			ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(m.toastGap).Children(func() {
				ui.Text(c, sourceChip(toast.source)).SingleLine().TextColor(s.palette.Muted)
				ui.Text(c, toast.at.Local().Format("15:04")).SingleLine().TextColor(s.palette.Muted)
			})
			if len(toast.actions) > 0 {
				ui.Row(c).FillWidth().Gap(m.toastGap).Children(func() {
					for _, action := range toast.actions {
						if !s.binder.Declares(action.Command) {
							continue
						}
						s.uiButton(c, s.binder.Press(c, "core.notices.action", action.Command, toast.id, action.Params), action.Label, false)
					}
				})
			}
		})
	})
	if !toast.read {
		ui.Box(c).Absolute().Left(0).Top(m.noticeEntryPad).Size(m.noticeDotSize, m.noticeDotSize).Radius(m.noticeDotSize / 2).Background(color)
	}
}

// sourceChip is the chip of an entry's source: the tab label of a card, the plugin, 설정 or soksak (packages/workbench/notice-view.js).
func sourceChip(source NoticeSource) string {
	switch source.Kind {
	case "card":
		return source.Label
	case "plugin":
		return source.Plugin
	case "settings":
		return "설정"
	}
	return "soksak"
}

// drawNoticeProgress draws the bar of a progress entry; a progress that is not known yet draws an empty bar.
func (s *Shell) drawNoticeProgress(c *ui.Context, toast *errorToast) {
	m := s.metrics
	bar := ui.Row(c).FillWidth().Height(m.noticeDotSize).Background(s.palette.Edge).Radius(m.noticeDotSize / 2)
	fraction := float32(0)
	if toast.progress != nil {
		fraction = float32(min(max(*toast.progress, 0), 1))
	}
	bar.Children(func() {
		if fraction > 0 {
			ui.Box(c).Grow(fraction).Height(m.noticeDotSize).Background(s.palette.Focus).Radius(m.noticeDotSize / 2)
		}
		ui.Box(c).Grow(1 - fraction)
	})
}

// drawNoticeFoot draws the rule of the lifetime of the entries and the button 모두 지우기.
func (s *Shell) drawNoticeFoot(c *ui.Context) {
	m := s.metrics
	ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(m.toastGap).Children(func() {
		ui.Text(c, noticeFootText).Wrap().TextColor(s.palette.Muted)
		s.uiButton(c, s.binder.Press(c, "core.notices.clear-all", "core.notices.clear-all", "", nil), "모두 지우기", false)
	})
}

// cardNotice returns the newest unclosed notice of card, which the card status line shows, or nil when the card has none.
func (e *ShownErrors) cardNotice(card string) *errorToast {
	e.ExpireNotices()
	for i := len(e.toasts) - 1; i >= 0; i-- {
		if toast := e.toasts[i]; !toast.closed && toast.source.Kind == "card" && toast.source.Card == card {
			return toast
		}
	}
	return nil
}

// noticeGlyphName is the key of the declared icon of a notice kind. The kinds are a closed set, so a kind without a declared icon is an error.
func noticeGlyphName(kind string, icons map[string]string) (string, error) {
	name := "notice-" + kind
	if _, ok := icons[name]; !ok {
		return "", fmt.Errorf("no icon for notice kind %s", kind)
	}
	return name, nil
}

// noticeGlyph is the declared icon of a kind. A kind without a declared icon is reported as an error and draws no icon.
func (s *Shell) noticeGlyph(kind string) *ui.SVG {
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, 2.0)
	name, err := noticeGlyphName(kind, s.options.Declared.Icons)
	if err != nil {
		s.fail(err)
		return s.declaredIcon("0 0 24 24", paint, "")
	}
	return s.declaredIcon("0 0 24 24", paint, s.options.Declared.Icons[name])
}

// noticeKindColor is the color of a kind's icon: the error token for an error, the accent for info and progress.
func (s *Shell) noticeKindColor(kind string) ui.Color {
	switch kind {
	case "error":
		return s.palette.No
	case "info", "progress":
		return s.palette.Focus
	}
	return s.palette.Muted
}

// drawCardNotice draws the status line of card for its notice toast: the icon of its kind, the tab name when the notice comes from another
// tab, the title and text, the first action and the close control (docs/spec/notifications.md#notices).
func (s *Shell) drawCardNotice(c *ui.Context, card string, data *layout.CardData, toast *errorToast) {
	m := s.metrics
	color := s.noticeKindColor(toast.kind)
	title := toast.title
	if active := data.ActiveTab(); active != nil && toast.source.Tab != "" && toast.source.Tab != active.ID {
		for _, tab := range data.Tabs {
			if tab.ID == toast.source.Tab {
				title = s.tabName(tab) + " · " + title
			}
		}
	}
	if toast.text != "" {
		title += " · " + toast.text
	}
	line := ui.Row(s.binder.Name(c, "core.card.notice", card)).FillWidth().Height(m.noticeLineH).Shrink(0).AlignItems(ui.Center).Gap(m.noticeLineGap).PaddingX(m.noticeLineGap).Role(ui.RoleStatus).Label(title)
	if toast.kind == "warning" || toast.kind == "error" {
		line.Background(faded(color, m.noticeToneMix))
	}
	line.Children(func() {
		ui.Icon(c, s.noticeGlyph(toast.kind)).Size(m.noticeGlyph, m.noticeGlyph).Shrink(0).TextColor(color)
		ui.Text(c, title).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).FontSize(s.textCaption()).TextColor(s.palette.Fg)
		if len(toast.actions) > 0 && s.binder.Declares(toast.actions[0].Command) {
			action := toast.actions[0]
			s.uiButton(c, s.binder.Press(c, "core.notices.action", action.Command, toast.id, action.Params), action.Label, false)
		}
		close := s.binder.Press(c, "core.notices.close", "core.notices.close", toast.id, map[string]any{"id": toast.id})
		close.Size(m.noticeGlyph, m.noticeGlyph).Shrink(0).Center().Label("닫기").Tooltip("닫기").Cursor(ui.CursorPointer).Children(func() {
			ui.Icon(c, s.declaredIcon("0 0 24 24", fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, 2.0), s.options.Declared.Icons["close"])).
				Size(m.noticeGlyph, m.noticeGlyph).TextColor(s.palette.Muted)
		})
	})
}
