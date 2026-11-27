package workbench

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The sections of a set whose plugin is not loaded (docs/spec/plugins.md#missing-plugins). The sidebar draws none of them. The warning of each
// missing plugin is a notice whose source is the sidebar (missingNotices), and the status line shows the newest notice of the sidebar; in a tab
// layout a dimmed tab is drawn for each missing section.

// MissingSection is a section of a set whose plugin is not loaded. Plugin is the id before the first `.` of the section.
type MissingSection struct {
	ID     string `json:"id"`
	Plugin string `json:"plugin"`
}

// PluginLine is the state of a plugin that a missing section names: its name, which the catalog gives or its id, and its state, which is
// the state of its row in the plugin status ("available" for a catalog plugin that is not installed, "" when the catalog and the installed
// plugins do not list it).
type PluginLine struct {
	Name  string
	State string
}

// MissingAction is the button of a missing-plugin line: the label and the command that it runs with its params.
type MissingAction struct {
	Label   string
	Command string
	Params  map[string]any
}

// MissingLine is the warning of one plugin that the sets have missing sections of. Count is the number of such sections in the frame. Title
// names the plugin, and Text states its state and the count of its sections.
type MissingLine struct {
	Plugin string
	Count  int
	Title  string
	Text   string
	Action *MissingAction
}

// MissingLines returns one warning for each plugin of the missing sections of the frame, in the order of their first section, with the number of
// its sections. plugin returns the state of a plugin id; nil reports every plugin as absent from the catalog and the installed plugins. A plugin
// in a state without a remedy (reload, unread, host) has no line, and its plugin page names the state.
func MissingLines(frame SidebarFrame, plugin func(id string) PluginLine) []MissingLine {
	type pending struct {
		line  MissingLine
		state PluginLine
	}
	var pendings []pending
	// index holds the position of each plugin in pendings, or -1 for a plugin that has no line.
	index := map[string]int{}
	for _, section := range frame.Missing {
		if i, ok := index[section.Plugin]; ok {
			if i >= 0 {
				pendings[i].line.Count++
			}
			continue
		}
		state := PluginLine{Name: section.Plugin}
		if plugin != nil {
			state = plugin(section.Plugin)
		}
		if state.Name == "" {
			state.Name = section.Plugin
		}
		if !hasMissingLine(state.State) {
			index[section.Plugin] = -1
			continue
		}
		index[section.Plugin] = len(pendings)
		pendings = append(pendings, pending{line: MissingLine{Plugin: section.Plugin, Count: 1}, state: state})
	}
	lines := make([]MissingLine, 0, len(pendings))
	for _, p := range pendings {
		lines = append(lines, missingLine(p.line.Plugin, p.state, p.line.Count))
	}
	return lines
}

// hasMissingLine tells whether a plugin in the state has a line: the states that have a remedy in the line (docs/spec/plugins.md#missing-plugins).
func hasMissingLine(state string) bool {
	switch state {
	case "", "available", "disabled", "refused", "requires":
		return true
	}
	return false
}

// missingLine builds the warning of a plugin with the title, the text and the button of its state (docs/spec/plugins.md#missing-plugins).
func missingLine(id string, state PluginLine, count int) MissingLine {
	// The title names the plugin by its name and its id, and shows the id alone when the name is the id, so the id is not repeated.
	title := id
	if state.Name != "" && state.Name != id {
		title = fmt.Sprintf("%s(%s)", state.Name, id)
	}
	line := MissingLine{Plugin: id, Count: count, Title: title}
	params := map[string]any{"plugin": id}
	switch state.State {
	case "":
		line.Text = fmt.Sprintf("플러그인이 없어 섹션 %d개를 못 보여 준다.", count)
	case "available":
		line.Text = fmt.Sprintf("플러그인이 없어 섹션 %d개를 못 보여 준다.", count)
		line.Action = &MissingAction{Label: state.Name + " 설치", Command: "core.plugins.install", Params: params}
	case "disabled":
		line.Text = fmt.Sprintf("플러그인이 꺼져 있어 섹션 %d개를 못 보여 준다.", count)
		line.Action = &MissingAction{Label: "켜기", Command: "core.plugins.enable", Params: params}
	case "refused", "requires":
		line.Text = fmt.Sprintf("플러그인을 불러오지 못해 섹션 %d개를 못 보여 준다.", count)
		line.Action = &MissingAction{Label: "설치됨 보기", Command: "core.plugins.browse", Params: map[string]any{}}
	default:
		panic(fmt.Sprintf("missing line of plugin %s in state %q, which has no line", id, state.State))
	}
	return line
}

// missingNotices shows the warning of each missing plugin of a sidebar as a notice whose source is the sidebar, and withdraws the notice of
// a plugin that no longer has a warning (docs/spec/plugins.md#missing-plugins). The notice of a plugin is shown under its origin, so a
// redraw of the same plugin keeps one notice.
type missingNotices struct {
	store *ShownErrors
	// shown holds the notice ids of each sidebar by origin.
	shown map[string]map[string]string
}

// missingOriginPrefix is the prefix of the origin of a missing-plugin warning. Such a warning is a record of the notice center only: its
// sidebar shows it as its line at the top, so it takes no toast and no status line notice (docs/spec/notifications.md#sidebar-notice).
const missingOriginPrefix = "missing-plugin:"

// missingOrigin is the origin of the warning of a plugin in a sidebar (docs/spec/notifications.md#sidebar-notice).
func missingOrigin(sidebar, plugin string) string {
	return missingOriginPrefix + sidebar + ":" + plugin
}

// isMissingOrigin tells whether an origin belongs to a missing-plugin warning.
func isMissingOrigin(origin string) bool {
	return strings.HasPrefix(origin, missingOriginPrefix)
}

// drawMissingLines draws the warning of each missing plugin of the frame as one line at the top of the sidebar, above its sections, with the
// action of its state (docs/spec/plugins.md#missing-plugins). Each line has the height of the status line.
func drawMissingLines(c *ui.Context, binder *Binder, frame SidebarFrame, metrics SidebarMetrics) {
	theme := c.Theme()
	for _, line := range frame.MissingLines {
		label := line.Title + " " + line.Text
		ui.Row(binder.Name(c, "core.sidebar.missing", frame.Sidebar+":"+line.Plugin)).FillWidth().Height(metrics.FootH).AlignItems(ui.Center).
			Gap(metrics.StatusGap).PaddingX(metrics.StatusPad).Role(ui.RoleStatus).Label(label).Children(func() {
			ui.Text(c, "⚠").SingleLine().FontSize(metrics.StatusText).TextColor(metrics.Warn)
			ui.Text(c, label).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).Grow(1).FontSize(metrics.StatusText).TextColor(metrics.Warn)
			if line.Action != nil && binder.Declares(line.Action.Command) {
				action := line.Action
				binder.Press(c, "core.sidebar.missing", action.Command, frame.Sidebar+":"+line.Plugin, action.Params).Role(ui.RoleButton).Children(func() {
					ui.Text(c, action.Label).NoWrap().FontSize(metrics.StatusText).TextColor(theme.Text)
				})
			}
		})
	}
}

// reconcile shows the warning of each line of the sidebar and withdraws the notice of each origin of the sidebar that has no line now. The
// card of a window sidebar is empty.
func (m *missingNotices) reconcile(sidebar, card string, lines []MissingLine) {
	next := make(map[string]string, len(lines))
	for _, line := range lines {
		origin := missingOrigin(sidebar, line.Plugin)
		fields := noticeFields{Kind: "warning", Title: line.Title, Text: line.Text}
		if line.Action != nil {
			action := NoticeAction{Label: line.Action.Label, Command: line.Action.Command, Params: line.Action.Params}
			fields.Action = &action
		}
		next[origin] = m.store.NotifyFrom(origin, fields, NoticeSource{Kind: "sidebar", Card: card, Sidebar: sidebar, Plugin: line.Plugin})
	}
	for origin, id := range m.shown[sidebar] {
		if _, ok := next[origin]; !ok {
			m.store.WithdrawNotice(id)
		}
	}
	m.shown[sidebar] = next
}

// drawSidebarNotice draws the notice of a sidebar in its status line: the title and the text, the first action and the close control, as the
// card notice line draws them (docs/spec/notifications.md#sidebar-notice).
func drawSidebarNotice(c *ui.Context, binder *Binder, notice *errorToast, metrics SidebarMetrics) {
	theme := c.Theme()
	label := notice.title
	if notice.text != "" {
		label += " · " + notice.text
	}
	ui.Text(c, "●").SingleLine().FontSize(metrics.StatusText).TextColor(metrics.Warn)
	ui.Text(c, label).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).Grow(1).FontSize(metrics.StatusText).TextColor(metrics.Warn)
	if len(notice.actions) > 0 && binder.Declares(notice.actions[0].Command) {
		action := notice.actions[0]
		binder.Press(c, "core.notices.action", action.Command, notice.id, action.Params).Role(ui.RoleButton).Children(func() {
			ui.Text(c, action.Label).NoWrap().FontSize(metrics.StatusText).TextColor(theme.Text)
		})
	}
	binder.Press(c, "core.notices.close", "core.notices.close", notice.id, map[string]any{"id": notice.id}).Role(ui.RoleButton).Label("닫기").Children(func() {
		ui.Text(c, "×").NoWrap().FontSize(metrics.StatusText).TextColor(theme.Text)
	})
}

// missingPluginLine returns the state of a plugin for its missing-plugin line: its name and its row state in the plugin status of the
// host. A plugin that neither the catalog nor the installed plugins list has no row, and its name is its id.
func (s *Shell) missingPluginLine(id string) PluginLine {
	for _, row := range s.pluginOperations.Status().Plugins {
		if row.ID == id {
			return PluginLine{Name: row.Name, State: row.State}
		}
	}
	return PluginLine{Name: id}
}

// sectionOf returns the loaded section of the frame with the id.
func sectionOf(frame SidebarFrame, id string) (SidebarSection, bool) {
	for _, section := range frame.Sections {
		if section.ID == id {
			return section, true
		}
	}
	return SidebarSection{}, false
}
