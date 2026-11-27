package workbench

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// The sections of a set whose plugin is not loaded (docs/spec/plugins.md#missing-plugins). The sidebar draws none of them; it shows one line
// for each plugin, with the button of the state of the plugin, and in a tab layout a dimmed tab for each.

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

// MissingLines returns one line for each plugin of the missing sections of the frame, in the order of their first section. plugin
// returns the state of a plugin id; nil reports every plugin as absent from the catalog and the installed plugins.
func MissingLines(frame SidebarFrame, plugin func(id string) PluginLine) []MissingLine {
	var lines []MissingLine
	index := map[string]int{}
	for _, section := range frame.Missing {
		if i, ok := index[section.Plugin]; ok {
			lines[i].Count++
			continue
		}
		state := PluginLine{Name: section.Plugin}
		if plugin != nil {
			state = plugin(section.Plugin)
		}
		if state.Name == "" {
			state.Name = section.Plugin
		}
		index[section.Plugin] = len(lines)
		lines = append(lines, missingLine(section.Plugin, state, 1))
	}
	return lines
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
		// The other states (reload, requires, unread, host) have no remedy in the line; the state is named by the plugin page.
		line.Text = fmt.Sprintf("%s 플러그인을 불러오지 못해 섹션 %d개를 못 보여 준다.", name, count)
	}
	return line
}

// drawMissingLine draws the line of a plugin: the element core.sidebar.missing of the plugin, its text, and its button when the state has one.
func (s *Sidebars) drawMissingLine(c *ui.Context, line MissingLine, width float32) {
	metrics := s.metrics
	theme := c.Theme()
	ui.Row(s.options.Binder.Name(c, "core.sidebar.missing", line.Plugin)).Size(width, metrics.HeadH).Role(ui.RoleGroup).Children(func() {
		color := theme.TextMuted
		if s.options.Warn != nil {
			color = s.options.Warn()
		}
		ui.Text(c, line.Text).NoWrap().Grow(1).Shrink(1).MinWidth(0).Clip().FontSize(metrics.SectionHeadText).TextColor(color)
		if line.Action != nil {
			action := line.Action
			s.options.Binder.Press(c, "core.sidebar.missing", action.Command, line.Plugin, action.Params).Role(ui.RoleButton).Children(func() {
				ui.Text(c, action.Label).NoWrap().FontSize(metrics.SectionHeadText).TextColor(theme.Text)
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
