package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// The sections of a set whose plugin is not loaded (docs/spec/plugins.md#missing-plugins). The sidebar draws none of them. Its status line
// shows the warning of its newest missing plugin with the button of the state of that plugin, and in a tab layout a dimmed tab for each.

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

// MissingLine is the line of one plugin that the sets have missing sections of. Count is the number of such sections in the frame.
type MissingLine struct {
	Plugin string
	Count  int
	Text   string
	Action *MissingAction
}

// MissingWarning is the warning that a status line shows: the line of the newest plugin of the frame, which is the last one in set order,
// and the count of the other plugins that have a line.
type MissingWarning struct {
	Line   MissingLine
	Others int
}

// Shown returns the text of the status line: the text of the line, and ` +<n> more` when other plugins are missing too.
func (w MissingWarning) Shown() string {
	if w.Others == 0 {
		return w.Line.Text
	}
	return fmt.Sprintf("%s +%d개 더", w.Line.Text, w.Others)
}

// newestWarning returns the warning of the lines, which are in set order, or nil when no plugin has a line.
func newestWarning(lines []MissingLine) *MissingWarning {
	if len(lines) == 0 {
		return nil
	}
	return &MissingWarning{Line: lines[len(lines)-1], Others: len(lines) - 1}
}

// MissingLines returns one line for each plugin of the missing sections of the frame, in the order of their first section, with the number of
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

// missingLine builds the line of a plugin with the text and the button of its state (docs/spec/plugins.md#missing-plugins).
func missingLine(id string, state PluginLine, count int) MissingLine {
	line := MissingLine{Plugin: id, Count: count}
	params := map[string]any{"plugin": id}
	name := fmt.Sprintf("%s(%s)", state.Name, id)
	switch state.State {
	case "":
		line.Text = fmt.Sprintf("%s 플러그인이 없어 섹션 %d개를 못 보여 준다.", name, count)
	case "available":
		line.Text = fmt.Sprintf("%s 플러그인이 없어 섹션 %d개를 못 보여 준다.", name, count)
		line.Action = &MissingAction{Label: state.Name + " 설치", Command: "core.plugins.install", Params: params}
	case "disabled":
		line.Text = fmt.Sprintf("%s 플러그인이 꺼져 있어 섹션 %d개를 못 보여 준다.", name, count)
		line.Action = &MissingAction{Label: "켜기", Command: "core.plugins.enable", Params: params}
	case "refused", "requires":
		line.Text = fmt.Sprintf("%s 플러그인을 불러오지 못해 섹션 %d개를 못 보여 준다.", name, count)
		line.Action = &MissingAction{Label: "설치됨 보기", Command: "core.plugins.browse", Params: map[string]any{}}
	default:
		panic(fmt.Sprintf("missing line of plugin %s in state %q, which has no line", id, state.State))
	}
	return line
}

// drawWarning draws the warning of a status line: the dot, the text in the warning tone and the button of the state of the plugin when it has
// one. The line is the element core.sidebar.missing of the plugin, and its label is the whole text.
func drawWarning(c *ui.Context, binder *Binder, warning MissingWarning, metrics SidebarMetrics) {
	theme := c.Theme()
	line := warning.Line
	ui.Row(binder.Name(c, "core.sidebar.missing", line.Plugin)).Grow(1).Shrink(1).MinWidth(0).Height(metrics.FootH).AlignItems(ui.Center).
		Gap(metrics.StatusGap).Role(ui.RoleGroup).Label(warning.Shown()).Children(func() {
		ui.Text(c, "●").SingleLine().FontSize(metrics.StatusText).TextColor(metrics.Warn)
		ui.Text(c, warning.Shown()).SingleLine().Ellipsis("…").MinWidth(0).Shrink(1).Grow(1).FontSize(metrics.StatusText).TextColor(metrics.Warn)
		if line.Action != nil {
			action := line.Action
			binder.Press(c, "core.sidebar.missing", action.Command, line.Plugin, action.Params).Role(ui.RoleButton).Children(func() {
				ui.Text(c, action.Label).NoWrap().FontSize(metrics.StatusText).TextColor(theme.Text)
			})
		}
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
